package api

import (
	"context"
	"net/http/httptest"
	"sync"
	"testing"
)

// newAIHarness verifies the dedicated loopback DB, creates a scratch DB and drops
// it on cleanup. This test never changes a pre-existing user or uses the AI model.
func TestScheduleBatchAtomicConflictAndConcurrentRetry(t *testing.T) {
	h := newAIHarness(t, nil)
	block := func(title, date, start, end string) map[string]any {
		return map[string]any{"title": title, "date": date, "start": start, "end": end, "kind": "FIXED"}
	}
	first := block("학교", "2026-09-21", "08:00", "16:00")
	if r := h.do("POST", "/api/schedules", first); r.Code != 201 {
		t.Fatal(r.Code, r.Body.String())
	}
	bad := map[string]any{"blocks": []any{block("먼저 담길 일정", "2026-09-22", "18:00", "19:00"), block("충돌", "2026-09-21", "15:00", "17:00")}}
	if r := h.do("POST", "/api/schedules/batch", bad); r.Code != 409 {
		t.Fatal("expected conflict", r.Code, r.Body.String())
	}
	var count int
	if err := h.pool.QueryRow(context.Background(), `SELECT count(*) FROM "Schedule" WHERE "userId"=$1`, h.student).Scan(&count); err != nil || count != 1 {
		t.Fatal("partial save or fixed schedule mutation", count, err)
	}
	body := map[string]any{"blocks": []any{first, block("복습", "2026-09-22", "18:00", "19:00")}}
	replies := make(chan *httptest.ResponseRecorder, 3)
	var wg sync.WaitGroup
	for range 3 {
		wg.Add(1)
		go func() { defer wg.Done(); replies <- h.do("POST", "/api/schedules/batch", body) }()
	}
	wg.Wait()
	close(replies)
	added := float64(0)
	for rec := range replies {
		if rec.Code != 200 {
			t.Fatal(rec.Code, rec.Body.String())
		}
		data := bodyOf(rec)["data"].(map[string]any)
		added += data["added"].(float64)
	}
	if added != 1 {
		t.Fatal("concurrent replay duplicated events", added)
	}
	if err := h.pool.QueryRow(context.Background(), `SELECT count(*) FROM "Schedule" WHERE "userId"=$1`, h.student).Scan(&count); err != nil || count != 2 {
		t.Fatal(count, err)
	}
	if h.model.calls.Load() != 0 {
		t.Fatal("batch must not invoke AI")
	}
}
func TestScheduleBatchRejectsInvalidDatesAndForeignSubjects(t *testing.T) {
	h := newAIHarness(t, nil)
	b := map[string]any{"title": "공부", "date": "2026-02-30", "start": "18:00", "end": "19:00", "kind": "FLEXIBLE"}
	if r := h.do("POST", "/api/schedules/batch", map[string]any{"blocks": []any{b}}); r.Code != 400 {
		t.Fatal(r.Code, r.Body.String())
	}
	b["date"] = "2026-09-21"
	b["subjectId"] = "unowned-subject"
	if r := h.do("POST", "/api/schedules/batch", map[string]any{"blocks": []any{b}}); r.Code != 404 {
		t.Fatal(r.Code, r.Body.String())
	}
}
