package apierr

import (
	"errors"
	"testing"
	"time"
)

func TestRetryCopy(t *testing.T) {
	sentinel := New(429, "요청이 많아요.")
	hinted := sentinel.Retry(42*time.Second, 15*time.Second)
	if sentinel.RetryMin != 0 || sentinel.RetrySpread != 0 {
		t.Fatal("Retry must not mutate the shared sentinel")
	}
	if hinted == sentinel || hinted.RetryMin != 42*time.Second || hinted.RetrySpread != 15*time.Second {
		t.Fatalf("the copy carries the hint: %+v", hinted)
	}
	if !errors.Is(hinted, sentinel) || !errors.Is(error(hinted), sentinel) {
		t.Fatal("errors.Is still matches the hinted copy to its sentinel")
	}
	if errors.Is(hinted, New(429, "다른 문구")) || errors.Is(hinted, WithCode(429, "요청이 많아요.", "X")) {
		t.Fatal("a different message or code is a different error")
	}
	if ErrTimeout.RetryMin != 2*time.Second || ErrTimeout.RetrySpread != 4*time.Second {
		t.Fatalf("the deadline 504 carries the 2–6 s hint: %+v", ErrTimeout)
	}
}
