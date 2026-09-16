package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"sync"
	"testing"

	"memoryz/server/internal/ids"
	"memoryz/server/internal/learning"
	"memoryz/server/internal/store"
)

func TestLearningJourneyOwnershipIdempotencyAndPersistence(t *testing.T) {
	// The harness rejects every DB except verified loopback :15444, creates a scratch DB,
	// migrates only that scratch DB and drops it afterwards. No live demo row is touched.
	h := newAIHarness(t, nil)
	ctx := context.Background()
	source := "광종은 과거제를 실시하였다. 성종은 12목을 설치하였다."
	if _, err := h.pool.Exec(ctx, `UPDATE "Material" SET "content"=$2 WHERE "id"=$1`, h.material, source); err != nil {
		t.Fatal(err)
	}
	m, err := h.s.q.GetMaterialContent(ctx, store.GetMaterialContentParams{ID: h.material, UserID: h.student})
	if err != nil {
		t.Fatal(err)
	}
	q, err := h.s.q.CreateQuestion(ctx, store.CreateQuestionParams{ID: ids.New(), UserID: h.student, SubjectID: m.SubjectID, MaterialID: h.material, Prompt: "광종의 정책은?", Options: []string{"과거제 실시", "12목 설치"}, Answer: 0, Explanation: "광종은 과거제를 실시하였다.", Citation: "광종은 과거제를 실시하였다.", Past: "역사", Future: "역사"})
	if err != nil {
		t.Fatal(err)
	}
	require := func(rec *httptest.ResponseRecorder, status int) map[string]any {
		t.Helper()
		if rec.Code != status {
			t.Fatalf("status %d want %d: %s", rec.Code, status, rec.Body.String())
		}
		out, ok := bodyOf(rec)["data"].(map[string]any)
		if !ok {
			t.Fatal("missing data", rec.Body.String())
		}
		return out
	}
	data := require(h.do("GET", "/api/quiz/explanation?questionId="+q.ID, nil), 200)
	var explanation learning.Explanation
	raw, _ := json.Marshal(data)
	if err := json.Unmarshal(raw, &explanation); err != nil || explanation.Status != "READY" {
		t.Fatal("comparison not ready", string(raw))
	}
	// Actual option count, not the maximum schema length, bounds submissions.
	if rec := h.do("POST", "/api/quiz/answer", map[string]any{"questionId": q.ID, "answer": 4}); rec.Code != 400 {
		t.Fatal("invalid option accepted")
	}
	requestID := ids.New()
	answer := map[string]any{"questionId": q.ID, "answer": 1, "requestId": requestID, "responseMs": 1200}
	first := require(h.do("POST", "/api/quiz/answer", answer), 200)
	attemptID := first["attemptId"].(string)
	var wg sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); responses <- h.do("POST", "/api/quiz/answer", answer) }()
	}
	wg.Wait()
	close(responses)
	for rec := range responses {
		if got := require(rec, 200); got["attemptId"] != attemptID {
			t.Fatal("retry created another attempt")
		}
	}
	if rec := h.do("POST", "/api/quiz/answer", map[string]any{"questionId": q.ID, "answer": 0, "requestId": requestID}); rec.Code != 409 {
		t.Fatal("mismatched idempotency replay accepted")
	}
	check := explanation.MicroChecks[0]
	reflect := map[string]any{"questionId": q.ID, "attemptId": attemptID, "stage": "CHECK", "depth": "FULL", "microCheckId": check.ID, "answer": check.Answer}
	if got := require(h.do("POST", "/api/quiz/reflection", reflect), 200); got["microResult"] != "PASS" {
		t.Fatal("server check grading failed")
	}
	require(h.do("POST", "/api/quiz/reflection", map[string]any{"questionId": q.ID, "attemptId": attemptID, "stage": "VERDICT", "depth": "SHORT"}), 200)
	a, err := h.s.q.GetOwnedAttempt(ctx, store.GetOwnedAttemptParams{ID: attemptID, UserID: h.student, QuestionID: &q.ID})
	if err != nil || a.Correct || a.Score != 0 || a.BeatsSeen != 3 || *a.ResponseMs != 1200 || *a.MicroResult != "PASS" {
		t.Fatal("reflection changed scored error or lost progress", a, err)
	}
	// Existing text wrong-note cards remain intact; diagram creation is independently deduplicated.
	textCard, err := h.s.q.UpsertWrongNoteCard(ctx, store.UpsertWrongNoteCardParams{ID: ids.New(), UserID: h.student, SubjectID: q.SubjectID, Front: "기존 카드", Back: "기존 답", SourceQuestionID: &q.ID})
	if err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"questionId": q.ID, "nodeIds": []string{explanation.Diagram.AnswerNodeID}, "microResult": "PASS"}
	card := require(h.do("POST", "/api/quiz/explanation-card", payload), 201)
	cardID := card["id"].(string)
	if cardID == textCard.ID || card["diagram"] == nil || card["nextReviewAt"] == nil {
		t.Fatal("expected separate diagram card", card)
	}
	payload["nodeIds"] = []string{explanation.Diagram.Nodes[0].ID}
	retry := require(h.do("POST", "/api/quiz/explanation-card", payload), 201)
	if retry["id"] != cardID {
		t.Fatal("card retry duplicate")
	}
	mask := retry["maskedNodeIds"].([]any)
	if mask[0] != explanation.Diagram.AnswerNodeID {
		t.Fatal("retry changed masks")
	}
	require(h.do("PATCH", "/api/cards/"+cardID, map[string]any{"deleted": true}), 200)
	restored := require(h.do("POST", "/api/quiz/explanation-card", payload), 201)
	if restored["deleted"] != false || restored["id"] != cardID {
		t.Fatal("card restoration duplicate")
	}

	reviewed := require(h.do("POST", "/api/cards/review", map[string]any{"cardId": cardID, "rating": "GOOD", "reviewId": ids.New()}), 200)
	if reviewed["diagram"] == nil || reviewed["maskedNodeIds"] == nil || reviewed["sourceDiagramId"] == nil {
		t.Fatal("review dropped diagram")
	}
	replayAfterReview := require(h.do("POST", "/api/quiz/explanation-card", payload), 201)
	if replayAfterReview["nextReviewAt"] != reviewed["nextReviewAt"] {
		t.Fatal("recreating card reset schedule")
	}
	report := map[string]any{"questionId": q.ID, "nodeId": explanation.Diagram.Nodes[0].ID, "reason": "source-mismatch"}
	require(h.do("POST", "/api/quiz/explanation/report", report), 200)
	require(h.do("POST", "/api/quiz/explanation/report", report), 200)
	var reports, attempts int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM "ExplanationReport" WHERE "questionId"=$1`, q.ID).Scan(&reports); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM "Attempt" WHERE "questionId"=$1`, q.ID).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if reports != 1 || attempts != 1 {
		t.Fatal("duplicates", reports, attempts)
	}
	boot := require(h.do("GET", "/api/bootstrap", nil), 200)
	found := false
	for _, v := range boot["cards"].([]any) {
		c := v.(map[string]any)
		if c["id"] == cardID {
			found = c["diagram"] != nil && c["maskedNodeIds"] != nil
		}
	}
	if !found {
		t.Fatal("bootstrap dropped diagram")
	}
	attemptsOut := boot["attempts"].([]any)
	if len(attemptsOut) != 1 || attemptsOut[0].(map[string]any)["microResult"] != "PASS" {
		t.Fatal("bootstrap dropped reflection")
	}
	// Ownership and retired subjects are enforced for reads and every write.
	if _, err := h.pool.Exec(ctx, `INSERT INTO "User" ("id","name","nickname","role") VALUES ('outsider','other','other','STUDENT')`); err != nil {
		t.Fatal(err)
	}
	cookie, _, err := h.s.auth.Create(ctx, "outsider")
	if err != nil {
		t.Fatal(err)
	}
	oldCookie := h.cookie
	h.cookie = cookie
	for _, path := range []string{"/api/quiz/answer", "/api/quiz/reflection", "/api/quiz/explanation-card", "/api/quiz/explanation/report"} {
		p := answer
		switch path {
		case "/api/quiz/reflection":
			p = reflect
		case "/api/quiz/explanation-card":
			p = payload
		case "/api/quiz/explanation/report":
			p = report
		}
		if rec := h.do("POST", path, p); rec.Code != 404 {
			t.Fatalf("ownership %s: %d %s", path, rec.Code, rec.Body.String())
		}
	}
	if rec := h.do("GET", "/api/quiz/explanation?questionId="+q.ID, nil); rec.Code != 404 {
		t.Fatal("cross-user explanation exposed")
	}
	h.cookie = oldCookie
	if _, err := h.pool.Exec(ctx, `UPDATE "Subject" SET "deleted"=true WHERE "id"=$1`, q.SubjectID); err != nil {
		t.Fatal(err)
	}
	if rec := h.do("GET", "/api/quiz/explanation?questionId="+q.ID, nil); rec.Code != 404 {
		t.Fatal("retired subject explanation exposed")
	}
}
