package ai

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"memoryz/server/internal/config"
)

// fakeJev serves TypeSafe's response shape; answer builds the answers for a decoded request.
func fakeJev(t *testing.T, mode string, answer func(questions map[string]JevQuestion) map[string]JevAnswer, before func(w http.ResponseWriter, calls int) bool) (*Jev, *int32) {
	t.Helper()
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if r.Header.Get("Authorization") != "Bearer jev-test-key" || r.URL.Path != "/v1/systemone" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var req struct {
			Model     string                 `json:"model"`
			Questions map[string]JevQuestion `json:"questions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Model != "jev-latest" {
			w.WriteHeader(http.StatusUnprocessableEntity)
			return
		}
		if before != nil && !before(w, int(n)) {
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"model": "jev-1.13.0", "answers": answer(req.Questions), "usage": map[string]int{"input_tokens": 1000, "output_tokens": 0}})
	}))
	t.Cleanup(srv.Close)
	cfg := &config.Config{TypeSafeAPIKey: "jev-test-key", TypeSafeModel: "jev-latest", AIJudge: mode}
	return NewJev(cfg, srv.URL, slog.Default()), &calls
}

func TestJevIsInertWithoutKeyOrMode(t *testing.T) {
	off := NewJev(&config.Config{TypeSafeAPIKey: "k", TypeSafeModel: "jev-latest", AIJudge: "off"}, "", nil)
	if off.Available() || off.Active() || off.Mode() != "off" {
		t.Fatalf("off must be inert: %v %v %s", off.Available(), off.Active(), off.Mode())
	}
	if _, err := off.Ask(context.Background(), "t", "x", map[string]JevQuestion{"a": {Type: "noul", Instructions: "?"}}); err != errJevUnavailable {
		t.Fatalf("expected unavailable, got %v", err)
	}
	shadow := NewJev(&config.Config{TypeSafeAPIKey: "k", TypeSafeModel: "jev-latest", AIJudge: "shadow"}, "", nil)
	if !shadow.Available() || shadow.Active() {
		t.Fatalf("shadow must be available but not active")
	}
	var nilJev *Jev
	if nilJev.Available() || nilJev.Mode() != "off" {
		t.Fatalf("nil judge must be inert")
	}
}

func TestJevAskRecordsUsageAndParsesAnswers(t *testing.T) {
	j, calls := fakeJev(t, "on", func(q map[string]JevQuestion) map[string]JevAnswer {
		return map[string]JevAnswer{
			"is_urgent": {Type: "noul", Noul: 0.91},
			"category":  {Type: "choice", Choice: "billing", Probabilities: map[string]float64{"billing": 0.8, "other": 0.2}, Confidence: 0.8},
		}
	}, nil)
	ctx, usage := CaptureUsage(context.Background())
	res, err := j.Ask(ctx, "typesafe_test", map[string]any{"text": "charged twice"}, map[string]JevQuestion{
		"is_urgent": {Type: "noul", Instructions: "urgent?"},
		"category":  {Type: "choice", Instructions: "what?", Criteria: map[string]any{"billing": nil, "other": nil}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Answers["is_urgent"].Noul != 0.91 || res.Answers["category"].Choice != "billing" || res.Model != "jev-1.13.0" || res.InputTokens != 1000 {
		t.Fatalf("unexpected result %+v", res)
	}
	if *calls != 1 {
		t.Fatalf("expected one call, got %d", *calls)
	}
	reqs := usage.Requests()
	if len(reqs) != 1 || reqs[0].Provider != "typesafe" || reqs[0].Task != "typesafe_test" || reqs[0].PromptTokens != 1000 || reqs[0].Cost == nil || math.Abs(*reqs[0].Cost-0.000042) > 1e-12 || !reqs[0].ModelReported {
		t.Fatalf("usage not recorded as a paid call: %+v", reqs)
	}
}

func TestJevAskRetriesRateLimitOnceAndFailsOnErrors(t *testing.T) {
	j, calls := fakeJev(t, "on", func(q map[string]JevQuestion) map[string]JevAnswer {
		return map[string]JevAnswer{"a": {Type: "noul", Noul: 0.5}}
	}, func(w http.ResponseWriter, n int) bool {
		if n == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			return false
		}
		return true
	})
	if _, err := j.Ask(context.Background(), "t", "x", map[string]JevQuestion{"a": {Type: "noul", Instructions: "?"}}); err != nil {
		t.Fatalf("one 429 must be retried: %v", err)
	}
	if *calls != 2 {
		t.Fatalf("expected 2 calls, got %d", *calls)
	}
	bad, _ := fakeJev(t, "on", nil, func(w http.ResponseWriter, n int) bool {
		w.WriteHeader(http.StatusInternalServerError)
		return false
	})
	ctx, usage := CaptureUsage(context.Background())
	if _, err := bad.Ask(ctx, "t", "x", map[string]JevQuestion{"a": {Type: "noul", Instructions: "?"}}); err == nil {
		t.Fatal("a 500 must fail")
	}
	if reqs := usage.Requests(); len(reqs) != 1 || reqs[0].HTTPStatus != 500 {
		t.Fatalf("failed call must still be recorded: %+v", reqs)
	}
	short, _ := fakeJev(t, "on", func(q map[string]JevQuestion) map[string]JevAnswer {
		return map[string]JevAnswer{"a": {Type: "noul", Noul: 0.5}}
	}, nil)
	if _, err := short.Ask(context.Background(), "t", "x", map[string]JevQuestion{"a": {Type: "noul", Instructions: "?"}, "b": {Type: "noul", Instructions: "?"}}); err == nil {
		t.Fatal("missing answers must fail")
	}
}
