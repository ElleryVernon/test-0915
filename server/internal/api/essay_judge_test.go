package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"memoryz/server/internal/config"
)

// fakeTypeSafe answers every keyword as explained and the answer as reasoned.
func fakeTypeSafe(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer typesafe-test" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var req struct {
			Questions map[string]json.RawMessage `json:"questions"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		answers := map[string]any{}
		for id := range req.Questions {
			switch {
			case id == "injection":
				answers[id] = map[string]any{"type": "noul", "noul": 0.01}
			case id == "answer_type":
				answers[id] = map[string]any{"type": "choice", "choice": "reasoned", "confidence": 0.95}
			case strings.HasPrefix(id, "kw_"):
				answers[id] = map[string]any{"type": "choice", "choice": "explained", "confidence": 0.9}
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"model": "jev-1.13.0", "answers": answers, "usage": map[string]int{"input_tokens": 900}})
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func TestEssayJudgeEndpointAnswersOwnedEssaysWhenOn(t *testing.T) {
	upstream, calls := fakeTypeSafe(t)
	h := newAIHarness(t, func(c *config.Config) {
		c.TypeSafeAPIKey, c.TypeSafeBaseURL, c.TypeSafeModel, c.AIJudge = "typesafe-test", upstream.URL, "jev-latest", "on"
	})
	ctx := context.Background()
	if _, err := h.pool.Exec(ctx, `INSERT INTO "Essay"("id","userId","subjectId","materialId","prompt","keywords","modelAnswer","citation") VALUES('judge-essay',$1,(SELECT "id" FROM "Subject" WHERE "userId"=$1 LIMIT 1),$2,'탈분극 과정을 설명하세요.',ARRAY['자극','나트륨 이온 통로'],'자극으로 나트륨 이온 통로가 열린다.','원문')`, h.student, h.material); err != nil {
		t.Fatal(err)
	}
	boot := h.do(http.MethodGet, "/api/bootstrap", nil)
	if boot.Code != 200 || !strings.Contains(boot.Body.String(), `"judgeAvailable":true`) {
		t.Fatalf("bootstrap must advertise the judge: %d %s", boot.Code, boot.Body.String()[:min(200, len(boot.Body.String()))])
	}
	rec := h.do(http.MethodPost, "/api/essay/judge", map[string]any{"essayId": "judge-essay", "answer": "역치 이상의 자극으로 나트륨 이온 통로가 열려 나트륨이 유입된다."})
	if rec.Code != 200 {
		t.Fatalf("judge %d %s", rec.Code, rec.Body.String())
	}
	data := bodyOf(rec)["data"].(map[string]any)
	if data["provisional"] != 100.0 || len(data["matched"].([]any)) != 2 || len(data["missing"].([]any)) != 0 || data["answerType"] != "reasoned" || data["model"] != "jev-1.13.0" {
		t.Fatalf("unexpected verdict %v", data)
	}
	if calls.Load() != 1 || h.model.calls.Load() != 0 {
		t.Fatalf("one judge call and no generator call expected: judge=%d model=%d", calls.Load(), h.model.calls.Load())
	}
	if rec := h.do(http.MethodPost, "/api/essay/judge", map[string]any{"essayId": "someone-elses", "answer": "답안입니다. 답안입니다."}); rec.Code != 404 {
		t.Fatalf("foreign essay must be 404, got %d", rec.Code)
	}
	if rec := h.do(http.MethodPost, "/api/essay/judge", map[string]any{"essayId": "judge-essay", "answer": ""}); rec.Code != 400 {
		t.Fatalf("empty answer must be 400, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestEssayJudgeEndpointIsOffWithoutTheJudge(t *testing.T) {
	h := newAIHarness(t, nil)
	if boot := h.do(http.MethodGet, "/api/bootstrap", nil); boot.Code != 200 || !strings.Contains(boot.Body.String(), `"judgeAvailable":false`) {
		t.Fatalf("bootstrap must not advertise the judge: %d", boot.Code)
	}
	if rec := h.do(http.MethodPost, "/api/essay/judge", map[string]any{"essayId": "x", "answer": "답안입니다."}); rec.Code != 503 {
		t.Fatalf("expected 503 without a judge, got %d %s", rec.Code, rec.Body.String())
	}
	// Shadow mode changes no grading path but still serves the display-only preview.
	shadow, calls := fakeTypeSafe(t)
	h2 := newAIHarness(t, func(c *config.Config) {
		c.TypeSafeAPIKey, c.TypeSafeBaseURL, c.TypeSafeModel, c.AIJudge = "typesafe-test", shadow.URL, "jev-latest", "shadow"
	})
	if boot := h2.do(http.MethodGet, "/api/bootstrap", nil); boot.Code != 200 || !strings.Contains(boot.Body.String(), `"judgeAvailable":true`) {
		t.Fatalf("shadow must advertise the preview: %d", boot.Code)
	}
	if _, err := h2.pool.Exec(context.Background(), `INSERT INTO "Essay"("id","userId","subjectId","materialId","prompt","keywords","modelAnswer","citation") VALUES('shadow-essay',$1,(SELECT "id" FROM "Subject" WHERE "userId"=$1 LIMIT 1),$2,'탈분극 과정을 설명하세요.',ARRAY['자극'],'자극.','원문')`, h2.student, h2.material); err != nil {
		t.Fatal(err)
	}
	if rec := h2.do(http.MethodPost, "/api/essay/judge", map[string]any{"essayId": "shadow-essay", "answer": "역치 이상의 자극으로 시작합니다."}); rec.Code != 200 || calls.Load() != 1 {
		t.Fatalf("shadow serves the preview: %d %s calls=%d", rec.Code, rec.Body.String(), calls.Load())
	}
}
