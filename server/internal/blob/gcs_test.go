package blob

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"cloud.google.com/go/storage"
	"github.com/googleapis/gax-go/v2"
)

// fakeGCS answers the JSON API's upload endpoint with a scripted status per attempt.
type fakeGCS struct {
	mu       sync.Mutex
	statuses []int
	attempts []string // the ifGenerationMatch of each attempt
}

func (f *fakeGCS) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	_, _ = io.Copy(io.Discard, r.Body)
	if !strings.Contains(r.URL.Path, "/upload/storage/v1/b/") {
		http.NotFound(w, r)
		return
	}
	f.mu.Lock()
	f.attempts = append(f.attempts, r.URL.Query().Get("ifGenerationMatch"))
	status := http.StatusOK
	if len(f.statuses) > 0 {
		status, f.statuses = f.statuses[0], f.statuses[1:]
	}
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if status == http.StatusOK {
		_, _ = io.WriteString(w, `{"bucket":"b","name":"k","generation":"1","size":"5"}`)
		return
	}
	_, _ = io.WriteString(w, `{"error":{"code":`+strconv.Itoa(status)+`,"message":"scripted"}}`)
}

func fakeStore(t *testing.T, f *fakeGCS) *GCS {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	t.Setenv("STORAGE_EMULATOR_HOST", strings.TrimPrefix(srv.URL, "http://"))
	s, err := NewGCS(context.Background(), "b")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	// Production keeps the client's own backoff and a 20 s budget; the test shortens both.
	s.retry = []storage.RetryOption{storage.WithBackoff(gax.Backoff{Initial: 5 * time.Millisecond, Max: 20 * time.Millisecond, Multiplier: 2})}
	s.putBudget = 300 * time.Millisecond
	return s
}

// TestGCSIdempotent: writes carry ifGenerationMatch=0, so the client retries a transient 503; a
// 412 after a lost response means the object landed; a store that keeps failing gives up when the
// write's budget runs out.
func TestGCSIdempotent(t *testing.T) {
	f := &fakeGCS{statuses: []int{503, 200}}
	s := fakeStore(t, f)
	if err := s.Put(context.Background(), "k", "text/plain", []byte("hello")); err != nil {
		t.Fatalf("503 then 200: %v", err)
	}
	if len(f.attempts) != 2 || f.attempts[0] != "0" || f.attempts[1] != "0" {
		t.Fatalf("two attempts, both conditional: %v", f.attempts)
	}
	f.attempts, f.statuses = nil, []int{503, 412}
	if err := s.Put(context.Background(), "k", "text/plain", []byte("hello")); err != nil {
		t.Fatalf("503 then 412 is success (an earlier attempt landed): %v", err)
	}
	f.attempts, f.statuses = nil, make([]int, 1000)
	for i := range f.statuses {
		f.statuses[i] = 503
	}
	started := time.Now()
	if err := s.Put(context.Background(), "k", "text/plain", []byte("hello")); err == nil {
		t.Fatalf("a store that keeps failing is an error (attempts %d)", len(f.attempts))
	}
	if took := time.Since(started); took > time.Second || len(f.attempts) < 3 {
		t.Fatalf("retried with backoff until the budget ran out: %d attempts in %v", len(f.attempts), took)
	}
	for _, match := range f.attempts {
		if match != "0" {
			t.Fatalf("every attempt is conditional: %v", f.attempts)
		}
	}
}
