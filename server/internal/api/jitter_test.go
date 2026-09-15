package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"memoryz/server/internal/cache"
)

func bareServer(c cache.Cache) *Server {
	return &Server{cache: c, now: time.Now, rand: func() float64 { return 0.5 }, pause: sleepCtx}
}

// TestFillCoalesces: the bell under DEMO_MODE is 50 identical misses on one bootstrap key; one build
// answers them all. The caller that starts the build leaves before it finishes: the build runs on a
// detached context, so it still completes for the 50 who joined, and the next read is a hit.
func TestFillCoalesces(t *testing.T) {
	mem := cache.NewMemory()
	defer mem.Close()
	s := bareServer(mem)
	var builds atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	build := func(ctx context.Context) ([]byte, error) {
		if builds.Add(1) == 1 {
			close(started)
		}
		<-release
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return []byte("payload"), nil
	}
	// The leader: its client gives up while the build it started is still running.
	leaving, cancel := context.WithCancel(context.Background())
	var leaverErr error
	var leaver sync.WaitGroup
	leaver.Add(1)
	go func() {
		defer leaver.Done()
		_, _, leaverErr = s.fill(leaving, "bootstrap", "boot:k", time.Minute, build)
	}()
	<-started
	const callers = 50
	var entered, done sync.WaitGroup
	states := make(chan string, callers)
	entered.Add(callers)
	done.Add(callers)
	for range callers {
		go func() {
			defer done.Done()
			entered.Done()
			raw, state, err := s.fill(context.Background(), "bootstrap", "boot:k", time.Minute, build)
			if err != nil || string(raw) != "payload" {
				t.Errorf("fill: %q %v", raw, err)
			}
			states <- state
		}()
	}
	entered.Wait()
	time.Sleep(100 * time.Millisecond) // every caller is now waiting on the one flight
	cancel()
	leaver.Wait()
	if !errors.Is(leaverErr, context.Canceled) {
		t.Fatalf("a caller who leaves gets its own context error: %v", leaverErr)
	}
	close(release)
	done.Wait()
	close(states)
	count := map[string]int{}
	for st := range states {
		count[st]++
	}
	if builds.Load() != 1 || count["shared"] != callers {
		t.Fatalf("one build, not cancelled by its leaving leader, for %d concurrent misses: builds=%d states=%v", callers, builds.Load(), count)
	}
	if raw, state, err := s.fill(context.Background(), "bootstrap", "boot:k", time.Minute, build); err != nil || state != "hit" || string(raw) != "payload" {
		t.Fatalf("the build was stored for the next reader: %q %s %v", raw, state, err)
	}
	if builds.Load() != 1 {
		t.Fatalf("a hit does not build: %d", builds.Load())
	}
	// A lone miss reports itself as the miss.
	if _, state, err := s.fill(context.Background(), "bootstrap", "boot:other", time.Minute, func(context.Context) ([]byte, error) { return []byte("x"), nil }); err != nil || state != "miss" {
		t.Fatalf("a lone miss: %s %v", state, err)
	}
}

// flakyBump fails the first `fail` bumps, then passes them to the memory cache.
type flakyBump struct {
	cache.Cache
	fail    atomic.Int32
	calls   atomic.Int32
	doneCtx atomic.Int32
}

func (f *flakyBump) Bump(ctx context.Context, key string, floor int64, ttl time.Duration) (string, error) {
	f.calls.Add(1)
	// Like the real client: an operation on a done context fails at once.
	if err := ctx.Err(); err != nil {
		f.doneCtx.Add(1)
		return "", err
	}
	if f.fail.Add(-1) >= 0 {
		return "", errors.New("valkey hiccup")
	}
	return f.Cache.Bump(ctx, key, floor, ttl)
}

// TestBumpDetached: a version bump survives a transient cache error (two retries after full jitter
// of 25 ms and 50 ms caps), runs on its own context even when the request's is already gone, and
// every bump moves the version by at least one (concurrent writers never collapse into one value).
func TestBumpDetached(t *testing.T) {
	mem := cache.NewMemory()
	defer mem.Close()
	flaky := &flakyBump{Cache: mem}
	flaky.fail.Store(2)
	s := bareServer(flaky)
	s.rand = func() float64 { return 1 - 1.0/(1<<53) }
	var pauses []time.Duration
	s.pause = func(ctx context.Context, d time.Duration) bool {
		pauses = append(pauses, d)
		return ctx.Err() == nil // like sleepCtx: a done context ends the retries
	}
	gone, cancel := context.WithCancel(context.Background())
	cancel() // the client left as the write committed
	s.bump(gone, "u1")
	if flaky.calls.Load() != 3 || flaky.doneCtx.Load() != 0 || len(pauses) != 2 || pauses[0] >= 25*time.Millisecond || pauses[1] >= 50*time.Millisecond || pauses[0] < 24*time.Millisecond || pauses[1] < 49*time.Millisecond {
		t.Fatalf("two jittered retries on a live context: calls=%d doneCtx=%d pauses=%v", flaky.calls.Load(), flaky.doneCtx.Load(), pauses)
	}
	first := s.version(context.Background(), "u1")
	if n, err := strconv.ParseInt(first, 10, 64); err != nil || n < time.Now().Add(-time.Minute).UnixMilli() {
		t.Fatalf("the version is a decimal at or above the clock's milliseconds: %q", first)
	}
	// With the clock held still, 20 concurrent bumps move the version by exactly 20.
	fixed := time.Now()
	s.now = func() time.Time { return fixed }
	s.bump(context.Background(), "u2")
	before, _ := strconv.ParseInt(s.version(context.Background(), "u2"), 10, 64)
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() { defer wg.Done(); s.bump(context.Background(), "u2") }()
	}
	wg.Wait()
	after, _ := strconv.ParseInt(s.version(context.Background(), "u2"), 10, 64)
	if after-before != 20 {
		t.Fatalf("20 concurrent bumps each advanced the version: %d → %d", before, after)
	}
}

// TestInvalidateScope: saving a post moves only the viewer's version; a like moves the shared feed.
func TestInvalidateScope(t *testing.T) {
	mem := cache.NewMemory()
	defer mem.Close()
	s := bareServer(mem)
	s.pause = func(context.Context, time.Duration) bool { return true }
	before := s.version(context.Background(), "posts")
	s.invalidate(httptest.NewRequest(http.MethodPost, "/api/posts/p1/save", nil), "u1")
	if s.version(context.Background(), "posts") != before || s.version(context.Background(), "u1") == "0" {
		t.Fatal("a save bumps the viewer, not the shared feed")
	}
	s.invalidate(httptest.NewRequest(http.MethodPost, "/api/posts/p1/like", nil), "u1")
	if s.version(context.Background(), "posts") == before {
		t.Fatal("a like bumps the shared feed")
	}
}

// slowKey makes every bump of one key hang until its context ends (a cache timing out on it).
type slowKey struct {
	cache.Cache
	slow string
}

func (c slowKey) Bump(ctx context.Context, key string, floor int64, ttl time.Duration) (string, error) {
	if key == c.slow {
		<-ctx.Done()
		return "", ctx.Err()
	}
	return c.Cache.Bump(ctx, key, floor, ttl)
}

// TestBumpBudgetPerID: timeouts on the writer's own version do not use up the shared list's bump
// (each id has its own budget), and the write still waits about one budget, not one per id.
func TestBumpBudgetPerID(t *testing.T) {
	mem := cache.NewMemory()
	defer mem.Close()
	s := bareServer(slowKey{Cache: mem, slow: versionKey("u1")})
	before := s.version(context.Background(), "posts")
	started := time.Now()
	s.bump(context.Background(), "u1", "posts")
	if took := time.Since(started); took > bumpBudget+300*time.Millisecond {
		t.Fatalf("one write waits about one budget: %v", took)
	}
	if s.version(context.Background(), "posts") == before {
		t.Fatal("the shared list was bumped although the writer's own key timed out")
	}
}
