package httpx

import (
	"encoding/json"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"memoryz/server/internal/apierr"
)

func TestRetryAfterHeader(t *testing.T) {
	fail := func(err error) (string, map[string]any) {
		rec := httptest.NewRecorder()
		Fail(rec, httptest.NewRequest("GET", "/api/x", nil), err)
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return rec.Header().Get("Retry-After"), body
	}
	busy := apierr.New(429, "요청이 많아요.")
	// Whole seconds rounded up in the header, milliseconds in the body.
	if h, b := fail(busy.Retry(59200*time.Millisecond, 0)); h != "60" || b["retryAfterMs"] != float64(59200) {
		t.Fatalf("59.2 s hint: header %q body %v", h, b)
	}
	// At least one second.
	if h, b := fail(busy.Retry(300*time.Millisecond, 0)); h != "1" || b["retryAfterMs"] != float64(1000) {
		t.Fatalf("sub-second hint: header %q body %v", h, b)
	}
	// No hint, no header, and the body keeps only error (and code).
	if h, b := fail(apierr.WithCode(503, "꺼져 있어요.", "AI_UNAVAILABLE")); h != "" || b["retryAfterMs"] != nil || b["code"] != "AI_UNAVAILABLE" || len(b) != 2 {
		t.Fatalf("a permanent refusal carries a code and no hint: header %q body %v", h, b)
	}
	// The spread is drawn per response within [min, min+spread).
	zero, top := func() float64 { return 0 }, func() float64 { return 1 - 1.0/(1<<53) }
	e := busy.Retry(59200*time.Millisecond, 15*time.Second)
	if d, _ := RetryAfter(e, zero); d != 59200*time.Millisecond {
		t.Fatalf("r=0: %v", d)
	}
	if d, _ := RetryAfter(e, top); d < 74*time.Second || d > 74200*time.Millisecond || d%time.Millisecond != 0 {
		t.Fatalf("r→1: whole milliseconds, at most the window's end: %v", d)
	}
	// Header and body always agree: ceil(retryAfterMs / 1000) is the header, for any draw.
	for range 5000 {
		h, b := fail(busy.Retry(30*time.Second, 30*time.Second))
		ms := int64(b["retryAfterMs"].(float64))
		if want := (ms + 999) / 1000; h != strconv.FormatInt(want, 10) {
			t.Fatalf("header %q disagrees with retryAfterMs %d", h, ms)
		}
	}
	if _, ok := RetryAfter(busy, zero); ok {
		t.Fatal("the sentinel itself has no hint")
	}
}
