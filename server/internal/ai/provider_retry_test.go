package ai

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"memoryz/server/internal/apierr"
)

// retryServer answers 429 (with header) for the first refusals calls, then a valid function call.
func retryServer(t *testing.T, refusals int32, header string) (*Provider, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n <= refusals {
			if header != "" {
				w.Header().Set("Retry-After", header)
			}
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		writeToolResponse(w, "memoryz_test", map[string]any{"ok": true})
	})
	p.retryBase, p.retryCap = 5*time.Millisecond, 20*time.Millisecond
	return p, &calls
}

var okSchema = object(map[string]any{"ok": map[string]any{"type": "boolean"}}, "ok")

func TestUpstream429IsReSentWithJitterAndRecorded(t *testing.T) {
	p, calls := retryServer(t, 1, "")
	drawn := 0
	p.rand = func() float64 { drawn++; return 0.5 }
	ctx, usage := CaptureUsage(context.Background())
	started := time.Now()
	value, err := p.JSON(ctx, "prompt", okSchema, "memoryz_test", nil)
	if err != nil || value.(map[string]any)["ok"] != true || calls.Load() != 2 {
		t.Fatalf("one 429 then success: %v %v calls=%d", value, err, calls.Load())
	}
	// Attempt 0 waits U[0, min(cap, base)) = 0.5 × 5 ms with the pinned draw.
	if elapsed := time.Since(started); elapsed < 2*time.Millisecond || drawn != 1 {
		t.Fatalf("the re-send waited a jittered interval: %v draws=%d", elapsed, drawn)
	}
	reqs := usage.Requests()
	if len(reqs) != 2 || reqs[0].HTTPStatus != 429 || !reqs[0].TransportFailure || reqs[1].HTTPStatus != 200 || reqs[1].TransportFailure {
		t.Fatalf("both attempts are recorded, the refusal as a transport failure: %+v", reqs)
	}
	notes := usage.Retries()
	if len(notes) != 1 || notes[0].Kind != "upstream_429" || !strings.Contains(notes[0].Reason, "attempt 1 refused") {
		t.Fatalf("the re-send is noted: %+v", notes)
	}
}

func TestUpstream429GivesUpAfterTheBoundedReSends(t *testing.T) {
	p, calls := retryServer(t, 10, "")
	ctx, usage := CaptureUsage(context.Background())
	_, err := p.JSON(ctx, "prompt", okSchema, "memoryz_test", nil)
	var e *apierr.Error
	if !errors.Is(err, errBusy) || !errors.As(err, &e) || e.Status != 429 || e.RetryMin != busyMin || e.RetrySpread != busySpread {
		t.Fatalf("exhausted re-sends end in the hinted 429: %v", err)
	}
	if calls.Load() != 1+UpstreamRetries {
		t.Fatalf("expected %d attempts, got %d", 1+UpstreamRetries, calls.Load())
	}
	if reqs := usage.Requests(); len(reqs) != 1+UpstreamRetries {
		t.Fatalf("every refused attempt is recorded once: %d", len(reqs))
	}
	if notes := usage.Retries(); len(notes) != UpstreamRetries {
		t.Fatalf("only the re-sends are noted, not the final refusal: %d", len(notes))
	}
}

func TestUpstream429HonoursShortHintsAndSkipsLongOnes(t *testing.T) {
	// A short Retry-After (within the cap) is waited, plus jitter, before the re-send.
	p, calls := retryServer(t, 1, "1")
	p.retryCap = 2 * time.Second
	started := time.Now()
	if _, err := p.JSON(context.Background(), "prompt", okSchema, "memoryz_test", nil); err != nil || calls.Load() != 2 {
		t.Fatalf("short hint then success: %v calls=%d", err, calls.Load())
	}
	if elapsed := time.Since(started); elapsed < time.Second {
		t.Fatalf("the 1 s hint was not waited: %v", elapsed)
	}
	// A hint beyond the cap is the provider telling us to go away: no re-send, straight to the learner.
	p, calls = retryServer(t, 1, "30")
	_, err := p.JSON(context.Background(), "prompt", okSchema, "memoryz_test", nil)
	var e *apierr.Error
	if !errors.Is(err, errBusy) || !errors.As(err, &e) || e.RetryMin != 30*time.Second || calls.Load() != 1 {
		t.Fatalf("a long hint is passed to the learner without a re-send: %v calls=%d", err, calls.Load())
	}
}

func TestUpstream429IsNotReSentWithoutDeadlineRoom(t *testing.T) {
	p, calls := retryServer(t, 1, "")
	// Less than retryBudget left: a re-send could not finish a model call, so the learner decides.
	ctx, cancel := context.WithTimeout(context.Background(), retryBudget/2)
	defer cancel()
	if _, err := p.JSON(ctx, "prompt", okSchema, "memoryz_test", nil); !errors.Is(err, errBusy) || calls.Load() != 1 {
		t.Fatalf("no room for a re-send: %v calls=%d", err, calls.Load())
	}
	// Other failures are untouched: a 500 is still one call and a 503 to the learner.
	var count atomic.Int32
	q := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	})
	q.retryBase, q.retryCap = time.Millisecond, time.Millisecond
	var e *apierr.Error
	if _, err := q.JSON(context.Background(), "prompt", okSchema, "memoryz_test", nil); !errors.As(err, &e) || e.Status != 503 || count.Load() != 1 {
		t.Fatalf("a 5xx is never re-sent: %v calls=%d", err, count.Load())
	}
}
