package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"memoryz/server/internal/ai"
	"memoryz/server/internal/ids"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const secondGenerationSource = "광합성은 빛에너지를 화학 에너지로 전환하는 과정이다. 엽록체에서 이산화탄소와 물로 포도당을 만든다."

func generationFixture(t *testing.T, h *aiHarness, subject, content string) (string, string) {
	t.Helper()
	ctx := context.Background()
	if subject == "" {
		subject = ids.New()
		if _, err := h.pool.Exec(ctx, `INSERT INTO "Subject"("id","userId","name") VALUES($1,$2,'통합 과학')`, subject, h.student); err != nil {
			t.Fatal(err)
		}
	}
	id := ids.New()
	if _, err := h.pool.Exec(ctx, `INSERT INTO "Material"("id","userId","subjectId","title","content") VALUES($1,$2,$3,'광합성 보충자료',$4)`, id, h.student, subject, content); err != nil {
		t.Fatal(err)
	}
	return id, subject
}
func generationResult(t *testing.T, r *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if r.Code != 201 {
		t.Fatalf("generation %d %s", r.Code, r.Body.String())
	}
	return bodyOf(r)["data"].([]any)[0].(map[string]any)
}
func generationBody(list []string, subject, mode string) map[string]any {
	return map[string]any{"materialIds": list, "subjectId": subject, "mode": mode, "count": 1, "requestId": ids.New(), "topic": "세포의 작용"}
}

func TestGenerationSourcesAllModesAndProvenance(t *testing.T) {
	h := newAIHarness(t, nil)
	ctx := context.Background()
	other, subject := generationFixture(t, h, "", secondGenerationSource)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var input struct {
			ToolChoice struct {
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tool_choice"`
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.Unmarshal(raw, &input); err != nil {
			t.Error(err)
		}
		for _, part := range []string{jitterSource, secondGenerationSource, "세포의 작용", "[자료 1:", "[자료 2:"} {
			if !strings.Contains(input.Messages[1].Content, part) {
				t.Errorf("missing full source/topic %q", part)
			}
		}
		calls.Add(1)
		citation := "광합성은 빛에너지를 화학 에너지로 전환하는 과정이다."
		var item any
		switch input.ToolChoice.Function.Name {
		case "memoryz_quiz":
			item = map[string]any{"prompt": "광합성의 에너지 전환으로 옳은 것은?", "options": []string{"빛에서 화학", "화학에서 빛", "열에서 빛", "전기에서 열", "변화 없음"}, "answer": 0, "explanation": "빛에너지를 화학 에너지로 전환하는 과정이에요.", "citation": citation, "past": "세포", "future": "생태계"}
		case "memoryz_essay":
			item = map[string]any{"prompt": "광합성이 에너지를 바꾸는 과정을 설명하세요.", "keywords": []string{"광합성", "빛에너지", "화학 에너지", "과정"}, "distractors": []string{"소화", "발열", "운동", "호르몬"}, "modelAnswer": citation, "citation": citation}
		case "memoryz_cards":
			item = map[string]any{"front": "광합성의 에너지 전환은?", "back": "빛에너지를 화학 에너지로 전환한다.", "type": "CONCEPT", "citation": citation}
		}
		args, _ := json.Marshal(map[string]any{"items": []any{item}})
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"tool_calls": []any{map[string]any{"function": map[string]any{"name": input.ToolChoice.Function.Name, "arguments": string(args)}}}}}}})
	}))
	defer upstream.Close()
	h.s.ai = ai.NewProvider(h.s.cfg, upstream.URL, slog.New(slog.NewTextHandler(io.Discard, nil)))
	var snapshot string
	for _, mode := range []string{"quiz", "essay", "cards"} {
		payload := generationBody([]string{h.material, other}, subject, mode)
		item := generationResult(t, h.do("POST", "/api/generate", payload))
		snapshot = item["materialId"].(string)
		if snapshot == h.material || snapshot == other || item["subjectId"] != subject {
			t.Fatal("wrong destination", item)
		}
		if again := generationResult(t, h.do("POST", "/api/generate", payload)); again["id"] != item["id"] {
			t.Fatal("duplicate")
		}
		payload["topic"] = "다른 주제"
		if r := h.do("POST", "/api/generate", payload); r.Code != 409 {
			t.Fatal("mismatch accepted", r.Code)
		}
	}
	if calls.Load() != 3 {
		t.Fatal("unexpected provider retry", calls.Load())
	}
	detail := communityData(t, h.do("GET", "/api/materials/"+snapshot, nil), 200)
	if detail["extraction"] != "combined" || !strings.Contains(detail["content"].(string), jitterSource) || !strings.Contains(detail["content"].(string), secondGenerationSource) {
		t.Fatal("incomplete snapshot", detail)
	}
	provenance := communityData(t, h.do("GET", "/api/materials/"+snapshot+"/sources", nil), 200)
	if provenance["combined"] != true || provenance["topic"] != "세포의 작용" || len(provenance["sources"].([]any)) != 2 {
		t.Fatal("provenance", provenance)
	}
	if r := h.do("PATCH", "/api/materials/"+snapshot, map[string]any{"content": "다른 본문"}); r.Code != 409 {
		t.Fatal("editable", r.Code)
	}
	if _, err := h.pool.Exec(ctx, `UPDATE "Material" SET "content"='changed' WHERE "id"=$1`, snapshot); err == nil {
		t.Fatal("DB snapshot mutable")
	}
	if _, err := h.pool.Exec(ctx, `UPDATE "Material" SET "content"='수정한 원본 본문입니다. 충분히 길게 작성합니다.' WHERE "id"=$1`, h.material); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(ctx, `DELETE FROM "Material" WHERE "id"=$1`, other); err != nil {
		t.Fatal(err)
	}
	provenance = communityData(t, h.do("GET", "/api/materials/"+snapshot+"/sources", nil), 200)
	saved := provenance["sources"].([]any)
	if saved[0].(map[string]any)["content"] != jitterSource || saved[0].(map[string]any)["changed"] != true || saved[1].(map[string]any)["available"] != false || saved[1].(map[string]any)["content"] != secondGenerationSource {
		t.Fatal("mutable provenance", saved)
	}
	peer := commentActor(t, h, "source-peer", "STUDENT")
	if r := peer.do("GET", "/api/materials/"+snapshot+"/sources", nil); r.Code != 404 {
		t.Fatal("foreign provenance leaked", r.Code)
	}
}

func TestGenerationSourcesValidationAndLegacy(t *testing.T) {
	h := newAIHarness(t, nil)
	other, subject := generationFixture(t, h, "", secondGenerationSource)
	short, _ := generationFixture(t, h, subject, "짧음")
	for name, body := range map[string]map[string]any{
		"empty": generationBody([]string{}, subject, "quiz"), "duplicate": generationBody([]string{h.material, h.material}, subject, "quiz"), "too many": generationBody([]string{h.material, other, short, ids.New(), ids.New(), ids.New()}, subject, "quiz"), "short": generationBody([]string{h.material, short}, subject, "quiz"), "missing": generationBody([]string{h.material, ids.New()}, subject, "quiz"), "wrong subject": generationBody([]string{h.material, other}, ids.New(), "quiz"), "ambiguous subject": generationBody([]string{h.material, other}, "", "quiz"),
	} {
		t.Run(name, func(t *testing.T) {
			r := h.do("POST", "/api/generate", body)
			if r.Code != 400 && r.Code != 404 {
				t.Fatal(r.Code, r.Body.String())
			}
		})
	}
	mismatch := generationBody([]string{h.material, other}, subject, "quiz")
	mismatch["materialId"] = h.material
	if r := h.do("POST", "/api/generate", mismatch); r.Code != 400 {
		t.Fatal("conflicting inputs", r.Code)
	}
	topic := generationBody([]string{h.material}, "", "quiz")
	topic["topic"] = strings.Repeat("가", 121)
	if r := h.do("POST", "/api/generate", topic); r.Code != 400 {
		t.Fatal("topic too long", r.Code)
	}
	if h.model.calls.Load() != 0 {
		t.Fatal("invalid input sent to model")
	}
	item := generationResult(t, h.generate(ids.New()))
	if item["materialId"] != h.material {
		t.Fatal("legacy copied original")
	}
	response := communityData(t, h.do("GET", "/api/materials/"+h.material+"/sources", nil), 200)
	if response["combined"] != false || len(response["sources"].([]any)) != 1 {
		t.Fatal(response)
	}
	peer := commentActor(t, h, "foreign-source-owner", "STUDENT")
	foreign, foreignSubject := generationFixture(t, peer, "", secondGenerationSource)
	if r := h.do("POST", "/api/generate", generationBody([]string{h.material, foreign}, foreignSubject, "quiz")); r.Code != 404 {
		t.Fatal("foreign source", r.Code)
	}
	if _, err := h.pool.Exec(context.Background(), `UPDATE "Subject" SET "deleted"=true WHERE "id"=$1`, subject); err != nil {
		t.Fatal(err)
	}
	if r := h.do("POST", "/api/generate", generationBody([]string{h.material, other}, subject, "quiz")); r.Code != 404 {
		t.Fatal("deleted source", r.Code)
	}
}
func TestGenerationSourcesNoTruncation(t *testing.T) {
	left := generationSource{ID: "a", Title: "첫 자료", SubjectID: "s", Content: strings.Repeat("가", generationContextLimit/2-1_000) + "마지막첫내용"}
	right := generationSource{ID: "b", Title: "둘째 자료", SubjectID: "s", Content: strings.Repeat("나", generationContextLimit/2-1_000) + "마지막둘째내용"}
	joined, err := combineGenerationSources([]generationSource{left, right}, "s")
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range []generationSource{left, right} {
		if !strings.Contains(joined.content, source.Content) {
			t.Fatal("truncated")
		}
	}
	right.Content += strings.Repeat("다", 3_000)
	if _, err = combineGenerationSources([]generationSource{left, right}, "s"); err != errGenerationContext {
		t.Fatal("oversize accepted", err)
	}
	h := newAIHarness(t, nil)
	other, subject := generationFixture(t, h, "", strings.Repeat("가", generationContextLimit))
	if r := h.do("POST", "/api/generate", generationBody([]string{h.material, other}, subject, "quiz")); r.Code != 400 || h.model.calls.Load() != 0 {
		t.Fatal("oversize sent", r.Code)
	}
}
func TestGenerationSourcesChangesDuringGeneration(t *testing.T) {
	for _, change := range []string{"content", "title", "subject", "delete"} {
		t.Run(change, func(t *testing.T) {
			h := newAIHarness(t, nil)
			other, subject := generationFixture(t, h, "", secondGenerationSource)
			h.model.mode.Store("hold")
			completed := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				completed <- h.do("POST", "/api/generate", generationBody([]string{h.material, other}, subject, "quiz"))
			}()
			deadline := time.Now().Add(3 * time.Second)
			for h.model.inFlight.Load() == 0 && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			if h.model.inFlight.Load() == 0 {
				t.Fatal("provider not called")
			}
			var sql string
			switch change {
			case "content":
				sql = `UPDATE "Material" SET "content"='본문을 생성 중에 수정했어요. 변경된 내용입니다.' WHERE "id"=$1`
			case "title":
				sql = `UPDATE "Material" SET "title"='다른 제목' WHERE "id"=$1`
			case "subject":
				sql = `UPDATE "Subject" SET "deleted"=true WHERE "id"=(SELECT "subjectId" FROM "Material" WHERE "id"=$1)`
			case "delete":
				sql = `DELETE FROM "Material" WHERE "id"=$1`
			}
			if _, err := h.pool.Exec(context.Background(), sql, other); err != nil {
				t.Fatal(err)
			}
			close(h.model.release)
			r := <-completed
			if r.Code != 409 {
				t.Fatal("changed source accepted", r.Code, r.Body.String())
			}
			var snapshots, questions int
			_ = h.pool.QueryRow(context.Background(), `SELECT count(*) FROM "GenerationSources"`).Scan(&snapshots)
			_ = h.pool.QueryRow(context.Background(), `SELECT count(*) FROM "Question"`).Scan(&questions)
			if snapshots != 0 || questions != 0 {
				t.Fatal("partial data", snapshots, questions)
			}
		})
	}
}
func TestGenerationSourcesCommitRollback(t *testing.T) {
	h := newAIHarness(t, nil)
	other, subject := generationFixture(t, h, "", secondGenerationSource)
	if _, err := h.pool.Exec(context.Background(), `ALTER TABLE "Question" ADD CONSTRAINT reject_generated_fixture CHECK ("prompt" <> '탈분극을 일으키는 이온의 이동은?')`); err != nil {
		t.Fatal(err)
	}
	if r := h.do("POST", "/api/generate", generationBody([]string{h.material, other}, subject, "quiz")); r.Code < 400 {
		t.Fatal("insert should fail")
	}
	var n int
	_ = h.pool.QueryRow(context.Background(), `SELECT count(*) FROM "Material" WHERE "extraction"='combined'`).Scan(&n)
	if n != 0 {
		t.Fatal("orphan snapshot", n)
	}
}

func TestGenerationSourcesConcurrentReplay(t *testing.T) {
	h := newAIHarness(t, nil)
	other, subject := generationFixture(t, h, "", secondGenerationSource)
	body := generationBody([]string{h.material, other}, subject, "quiz")
	h.model.mode.Store("hold")
	completed := make(chan *httptest.ResponseRecorder, 1)
	go func() { completed <- h.do("POST", "/api/generate", body) }()
	deadline := time.Now().Add(3 * time.Second)
	for h.model.inFlight.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if h.model.inFlight.Load() == 0 {
		t.Fatal("model did not start")
	}
	if r := h.do("POST", "/api/generate", body); r.Code != 409 {
		t.Fatal("concurrent request not identified", r.Code)
	}
	close(h.model.release)
	first := generationResult(t, <-completed)
	if _, err := h.pool.Exec(context.Background(), `UPDATE "Material" SET "content"='원본이 바뀌어도 끝난 요청은 같은 결과를 돌려줘야 합니다.' WHERE "id"=$1`, other); err != nil {
		t.Fatal(err)
	}
	replay := generationResult(t, h.do("POST", "/api/generate", body))
	if replay["id"] != first["id"] || h.model.calls.Load() != 1 {
		t.Fatal("replay regenerated", replay, h.model.calls.Load())
	}
	var snapshots int
	if err := h.pool.QueryRow(context.Background(), `SELECT count(*) FROM "GenerationSources"`).Scan(&snapshots); err != nil || snapshots != 1 {
		t.Fatal("duplicate snapshots", snapshots, err)
	}
	changed := generationBody([]string{h.material}, subject, "quiz")
	changed["requestId"] = body["requestId"]
	if r := h.do("POST", "/api/generate", changed); r.Code != 409 {
		t.Fatal("source change with reused ID", r.Code)
	}
}

func TestGenerationSourcesFiveMaterialsAndMetadataCannotBeCitation(t *testing.T) {
	h := newAIHarness(t, nil)
	list := []string{h.material}
	var subject string
	for i := 0; i < 4; i++ {
		var id string
		id, subject = generationFixture(t, h, subject, secondGenerationSource)
		list = append(list, id)
	}
	item := generationResult(t, h.do("POST", "/api/generate", generationBody(list, subject, "quiz")))
	sources := communityData(t, h.do("GET", "/api/materials/"+item["materialId"].(string)+"/sources", nil), 200)["sources"].([]any)
	if len(sources) != 5 {
		t.Fatal("did not retain all five", len(sources))
	}
	for i, s := range sources {
		if s.(map[string]any)["id"] != list[i] {
			t.Fatal("source order changed")
		}
	}
	context := generationContext{sources: []generationSource{{Title: "이 제목은 사실의 근거가 될 수 없습니다.", Content: jitterSource}}}
	if context.grounded(ai.Items{Questions: []ai.QuestionItem{{Citation: "이 제목은 사실의 근거가 될 수 없습니다."}}}) {
		t.Fatal("metadata accepted as evidence")
	}
	if !context.grounded(ai.Items{Questions: []ai.QuestionItem{{Citation: "나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다."}}}) {
		t.Fatal("actual citation rejected")
	}
}
