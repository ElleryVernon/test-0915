package ai

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/config"
)

const okBody = `{"id":"gen-1","model":"openai/gpt-5.6-luna","provider":"Amazon Bedrock","choices":[{"finish_reason":"stop","message":{"tool_calls":[{"function":{"name":"memoryz_ocr","arguments":"{\"text\":\"hello\"}"}}]}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}`

func call(p *Provider, ctx context.Context) error {
	_, err := p.JSON(ctx, "prompt", object(map[string]any{"text": str(0, 10)}, "text"), "memoryz_ocr", nil)
	return err
}

// TestAdmission: paid calls pass a FIFO semaphore of AI_CONCURRENCY slots. The upstream never sees
// more than the slots at once, waiters start in arrival order, our own wait running out is a 429
// with a [10 s, 20 s) hint, the caller's shorter deadline is its own context error, the slot is
// released once the body is read, an upstream 429 is never retried, and a zero setting means 16.
func TestAdmission(t *testing.T) {
	var inFlight, peak, calls atomic.Int32
	var mu sync.Mutex
	var order []string
	gate := make(chan struct{})
	p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		calls.Add(1)
		n := inFlight.Add(1)
		for {
			old := peak.Load()
			if n <= old || peak.CompareAndSwap(old, n) {
				break
			}
		}
		mu.Lock()
		order = append(order, r.Header.Get("X-Caller"))
		mu.Unlock()
		if r.Header.Get("X-Test") == "429" {
			inFlight.Add(-1)
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		<-gate
		inFlight.Add(-1)
		_, _ = io.WriteString(w, okBody)
	})
	p.cfg.AIConcurrency = 2
	p.slots = NewProvider(p.cfg, p.baseURL, slog.Default()).slots
	var wg sync.WaitGroup
	errs := make([]error, 5)
	for i := range 5 {
		wg.Add(1)
		caller := string(rune('a' + i))
		client := *p.client
		client.Transport = headerTransport{"X-Caller": caller}
		q := *p
		q.client = &client
		go func() { defer wg.Done(); errs[i] = call(&q, context.Background()) }()
		time.Sleep(30 * time.Millisecond) // arrival order a, b, c, d, e
	}
	time.Sleep(100 * time.Millisecond)
	if calls.Load() != 2 {
		t.Fatalf("two slots admit two calls: %d upstream", calls.Load())
	}
	for range 3 {
		gate <- struct{}{}
		time.Sleep(60 * time.Millisecond)
	}
	close(gate)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if peak.Load() != 2 {
		t.Fatalf("the upstream never sees more than the slots: peak %d", peak.Load())
	}
	if got := order[2] + order[3] + order[4]; got != "cde" {
		t.Fatalf("waiters start in arrival order: %v", order)
	}
	if !p.slots.TryAcquire(2) {
		t.Fatal("every slot is released once the body is read")
	}
	// Our wait running out: a spread 429. The caller's own shorter deadline: its context error.
	p.wait = 50 * time.Millisecond
	err := call(p, context.Background())
	var e *apierr.Error
	if !errors.As(err, &e) || e.Status != 429 || e.RetryMin != 10*time.Second || e.RetrySpread != 10*time.Second || !errors.Is(err, errBusy) {
		t.Fatalf("admission timeout: %v %+v", err, e)
	}
	p.wait = admissionWait
	short, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := call(p, short); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a shorter caller deadline is its own error, not 429: %v", err)
	}
	p.slots.Release(2)
	// An upstream 429 is one upstream call; the learner decides when to try again.
	before := calls.Load()
	p.client.Transport = headerTransport{"X-Test": "429"}
	if err := call(p, context.Background()); !errors.Is(err, errBusy) || calls.Load() != before+1 {
		t.Fatalf("upstream 429 is not retried: %v (%d calls)", err, calls.Load()-before)
	}
	zero := NewProvider(&config.Config{}, "", slog.Default())
	if !zero.slots.TryAcquire(16) || zero.slots.TryAcquire(1) {
		t.Fatal("AI_CONCURRENCY 0 means 16 slots")
	}
}

// TestRetryHints (ai): every 429 the provider produces carries a hint; the permanent 503s carry
// the code AI_UNAVAILABLE and none.
func TestRetryHints(t *testing.T) {
	var header atomic.Value
	header.Store("")
	p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		if h := header.Load().(string); h != "-" {
			w.Header().Set("Retry-After", h)
		}
		w.WriteHeader(http.StatusTooManyRequests)
	})
	now := time.Now()
	for _, c := range []struct {
		header string
		min    time.Duration
	}{
		{"25", 25 * time.Second},
		{"-", 10 * time.Second},
		{"3", 10 * time.Second},
		{"99999", 10 * time.Minute},
		{"garbage", 10 * time.Second},
		{now.Add(2 * time.Minute).UTC().Format(http.TimeFormat), 2 * time.Minute},
	} {
		header.Store(c.header)
		err := call(p, context.Background())
		var e *apierr.Error
		if !errors.As(err, &e) || e.Status != 429 || e.RetrySpread != 10*time.Second || (e.RetryMin-c.min).Abs() > 2*time.Second {
			t.Fatalf("Retry-After %q: %v %+v", c.header, err, e)
		}
	}
	for name, err := range map[string]*apierr.Error{"slow": errProviderSlow, "incomplete": errIncomplete} {
		if err.Status != 504 || err.RetryMin != 10*time.Second || err.RetrySpread != 10*time.Second {
			t.Fatalf("%s: a transient provider 504 carries the busy hint: %+v", name, err)
		}
	}
	for name, err := range map[string]*apierr.Error{"unavailable": ErrUnavailable, "model": errModelConfig, "quota": errQuota} {
		if err.Status != 503 || err.Code != "AI_UNAVAILABLE" || err.RetryMin != 0 || err.RetrySpread != 0 {
			t.Fatalf("%s: a permanent 503 has the code and no hint: %+v", name, err)
		}
	}
	if got := upstreamWait("", now); got != 10*time.Second {
		t.Fatalf("no header: %v", got)
	}
	// The caller's own deadline ending the call is the caller's error (a hinted request timeout),
	// not a slow provider.
	slow := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		<-r.Context().Done()
	})
	short, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := call(slow, short); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a caller deadline during the call: %v", err)
	}
}
