package api

import (
	"context"
	"net/http/httptest"
	"sync"
	"testing"

	"memoryz/server/internal/ids"
)

func TestFirstLearningSampleIsOwnedIdempotentAndRecordsRealProgress(t *testing.T) {
	h := newAIHarness(t, nil)
	ctx := context.Background()
	responses := make(chan *httptest.ResponseRecorder, 3)
	var wg sync.WaitGroup
	for range 3 {
		wg.Add(1)
		go func() { defer wg.Done(); responses <- h.do("POST", "/api/materials/sample", map[string]any{}) }()
	}
	wg.Wait()
	close(responses)
	materialID, questionID, cardID := "", "", ""
	created := 0
	for rec := range responses {
		if rec.Code != 200 && rec.Code != 201 {
			t.Fatalf("sample: %d %s", rec.Code, rec.Body.String())
		}
		if rec.Code == 201 {
			created++
		}
		data := bodyOf(rec)["data"].(map[string]any)
		material := data["material"].(map[string]any)
		lesson := data["lesson"].(map[string]any)
		if materialID != "" && (materialID != material["id"] || questionID != lesson["questionId"] || cardID != lesson["cardId"]) {
			t.Fatal("a retry duplicated the lesson")
		}
		materialID, questionID, cardID = material["id"].(string), lesson["questionId"].(string), lesson["cardId"].(string)
	}
	if created != 1 {
		t.Fatalf("created %d copies", created)
	}
	var cards, questions, sources int
	if err := h.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM "Card" WHERE "materialId"=$1),(SELECT count(*) FROM "Question" WHERE "materialId"=$1),(SELECT count(*) FROM "Material" WHERE "id"=$2)`, materialID, h.material).Scan(&cards, &questions, &sources); err != nil {
		t.Fatal(err)
	}
	if cards != 1 || questions != 2 || sources != 1 {
		t.Fatalf("sample changed unrelated data: cards=%d questions=%d original=%d", cards, questions, sources)
	}
	if h.model.calls.Load() != 0 {
		t.Fatal("sample must work without waiting for AI generation")
	}
	answer := map[string]any{"questionId": questionID, "answer": 0, "requestId": ids.New()}
	for range 2 {
		if rec := h.do("POST", "/api/quiz/answer", answer); rec.Code != 200 {
			t.Fatalf("answer: %s", rec.Body.String())
		}
	}
	review := map[string]any{"cardId": cardID, "rating": "GOOD", "reviewId": ids.New()}
	for range 2 {
		if rec := h.do("POST", "/api/cards/review", review); rec.Code != 200 {
			t.Fatalf("review: %s", rec.Body.String())
		}
	}
	if rec := h.do("POST", "/api/materials/sample", map[string]any{}); rec.Code != 200 {
		t.Fatalf("resume: %s", rec.Body.String())
	}
	boot := bodyOf(h.do("GET", "/api/bootstrap", nil))["data"].(map[string]any)
	if len(boot["attempts"].([]any)) != 1 {
		t.Fatal("repeated answer counted twice")
	}
	card := boot["cards"].([]any)[0].(map[string]any)
	if card["id"] != cardID || card["sourceKind"] != "STARTER" || card["reviewCount"] != float64(1) || card["sourceQuestionId"] != questionID {
		t.Fatalf("saved progress missing: %#v", card)
	}
	// An unrelated session cannot read or answer the learner's sample.
	peerID := "first-learning-peer"
	if _, err := h.pool.Exec(ctx, `INSERT INTO "User"("id","name","nickname","role") VALUES($1,$1,$1,'STUDENT')`, peerID); err != nil {
		t.Fatal(err)
	}
	cookie, _, err := h.s.auth.Create(ctx, peerID)
	if err != nil {
		t.Fatal(err)
	}
	peer := *h
	peer.cookie = cookie
	for _, req := range []struct {
		method, path string
		body         any
	}{
		{"GET", "/api/materials/" + materialID, nil},
		{"POST", "/api/quiz/answer", map[string]any{"questionId": questionID, "answer": 1}},
		{"POST", "/api/cards/review", map[string]any{"cardId": cardID, "rating": "GOOD", "reviewId": ids.New()}},
	} {
		if rec := peer.do(req.method, req.path, req.body); rec.Code != 404 {
			t.Fatalf("cross-user access: %s %d", req.path, rec.Code)
		}
	}
}
