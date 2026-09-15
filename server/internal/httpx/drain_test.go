package httpx

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// TestDrain: after the shutdown signal, drain runs drainAfter later while a request is still in
// flight (and lets it finish); a shutdown with nothing in flight ends at once without draining.
// The budget fits Cloud Run's 10 s between SIGTERM and SIGKILL.
func TestDrain(t *testing.T) {
	// Interrupted runs get 2 s to record themselves before the HTTP grace ends, and the whole
	// shutdown (grace, bounded closers, flush) stays under Cloud Run's 10 s.
	if ShutdownGrace+CloseGrace+FlushGrace >= 10*time.Second || DrainAfter+2*time.Second > ShutdownGrace {
		t.Fatalf("shutdown budget: grace %v + close %v + flush %v, drain at %v", ShutdownGrace, CloseGrace, FlushGrace, DrainAfter)
	}
	run := func(inFlight bool) (drainedAfter time.Duration, drained bool) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		release := make(chan struct{})
		var stoppedAt atomic.Int64
		var drainAt atomic.Int64
		handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			<-release // an AI run waiting on the model until drain interrupts it
			_, _ = io.WriteString(w, "interrupted")
		})
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			done <- serve(ctx, ln, handler, slog.New(slog.NewTextHandler(io.Discard, nil)), func() {
				drainAt.Store(time.Now().UnixNano())
				close(release)
			}, 200*time.Millisecond)
		}()
		var answered chan string
		if inFlight {
			answered = make(chan string, 1)
			go func() {
				res, err := http.Get("http://" + ln.Addr().String() + "/")
				if err != nil {
					answered <- err.Error()
					return
				}
				body, _ := io.ReadAll(res.Body)
				res.Body.Close()
				answered <- string(body)
			}()
			time.Sleep(100 * time.Millisecond)
		}
		stoppedAt.Store(time.Now().UnixNano())
		cancel()
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		if inFlight {
			if got := <-answered; got != "interrupted" {
				t.Fatalf("the in-flight request is answered: %q", got)
			}
		}
		if drainAt.Load() == 0 {
			return 0, false
		}
		return time.Duration(drainAt.Load() - stoppedAt.Load()), true
	}
	after, drained := run(true)
	if !drained || after < 200*time.Millisecond || after > 600*time.Millisecond {
		t.Fatalf("drain runs drainAfter into the shutdown: %v %v", after, drained)
	}
	if _, drained := run(false); drained {
		t.Fatal("nothing in flight: the shutdown ends before any drain")
	}
}

// TestLive: /api/live answers without touching anything, so a database outage never fails liveness.
func TestLive(t *testing.T) {
	rec := httptest.NewRecorder()
	Live().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/live", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "{\"data\":{\"status\":\"ok\"}}\n" {
		t.Fatalf("live: %d %q", rec.Code, rec.Body.String())
	}
}

// TestClientGone: the connection's context survives a detached Deadline, so a queued handler can
// still see its client leave.
func TestClientGone(t *testing.T) {
	conn, cancel := context.WithCancel(context.Background())
	var seen <-chan struct{}
	h := Timeout(time.Minute)(Deadline(time.Minute, func(w http.ResponseWriter, r *http.Request) error {
		seen = ClientGone(r.Context())
		return nil
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil).WithContext(conn))
	if seen == nil {
		t.Fatal("ClientGone is known under Deadline")
	}
	select {
	case <-seen:
		t.Fatal("not gone yet")
	default:
	}
	cancel()
	select {
	case <-seen:
	case <-time.After(time.Second):
		t.Fatal("closed when the client leaves")
	}
	if ClientGone(context.Background()) != nil {
		t.Fatal("unknown without Timeout")
	}
}
