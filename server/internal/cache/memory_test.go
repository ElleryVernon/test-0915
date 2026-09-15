package cache

import (
	"context"
	"strconv"
	"sync"
	"testing"
	"time"
)

func TestMemoryTTLAndCounters(t *testing.T) {
	m := NewMemory()
	defer m.Close()
	now := time.Unix(1_700_000_000, 0)
	m.now = func() time.Time { return now }
	ctx := context.Background()
	if err := m.Set(ctx, "a", []byte("1"), time.Minute); err != nil {
		t.Fatal(err)
	}
	if v, ok, _ := m.Get(ctx, "a"); !ok || string(v) != "1" {
		t.Fatalf("get: %q %v", v, ok)
	}
	now = now.Add(61 * time.Second)
	if _, ok, _ := m.Get(ctx, "a"); ok {
		t.Fatal("expired entry still present")
	}
	for i := int64(1); i <= 3; i++ {
		if n, _, _ := m.Incr(ctx, "count", time.Minute); n != i {
			t.Fatalf("incr %d: %d", i, n)
		}
	}
	now = now.Add(2 * time.Minute)
	if n, _, _ := m.Incr(ctx, "count", time.Minute); n != 1 {
		t.Fatalf("counter should restart after its ttl: %d", n)
	}
	release, ok, _ := m.Lock(ctx, "lease", time.Minute)
	if !ok {
		t.Fatal("first lock should succeed")
	}
	if _, again, _ := m.Lock(ctx, "lease", time.Minute); again {
		t.Fatal("second lock should fail while held")
	}
	release()
	release()
	if _, third, _ := m.Lock(ctx, "lease", time.Minute); !third {
		t.Fatal("lock should be free after release")
	}
	if err := m.Del(ctx, "lease", "missing"); err != nil {
		t.Fatal(err)
	}
}

func TestIncrWindow(t *testing.T) {
	m := NewMemory()
	defer m.Close()
	now := time.Unix(1_700_000_000, 0)
	m.now = func() time.Time { return now }
	ctx := context.Background()
	if n, left, _ := m.Incr(ctx, "w", time.Minute); n != 1 || left != time.Minute {
		t.Fatalf("a new window: %d %v", n, left)
	}
	now = now.Add(20 * time.Second)
	if n, left, _ := m.Incr(ctx, "w", time.Minute); n != 2 || left != 40*time.Second {
		t.Fatalf("20 s in: %d %v", n, left)
	}
	// A key that lost its expiry (set without a TTL) heals to a full window instead of never resetting.
	_ = m.Set(ctx, "stuck", encodeInt(7), 0)
	if n, left, _ := m.Incr(ctx, "stuck", time.Minute); n != 8 || left != time.Minute {
		t.Fatalf("heal: %d %v", n, left)
	}
}

func TestBump(t *testing.T) {
	m := NewMemory()
	defer m.Close()
	ctx := context.Background()
	if v, _ := m.Bump(ctx, "ver", 1000, time.Hour); v != "1000" {
		t.Fatalf("a missing key takes the floor: %s", v)
	}
	if v, _ := m.Bump(ctx, "ver", 900, time.Hour); v != "1001" {
		t.Fatalf("a floor below the value adds one: %s", v)
	}
	_ = m.Set(ctx, "odd", []byte("01H8XGJWBWBAQ4Z4"), time.Hour)
	if v, _ := m.Bump(ctx, "odd", 5, time.Hour); v != "5" {
		t.Fatalf("a non-decimal value restarts at the floor: %s", v)
	}
	// Concurrent writers never produce the same version (the GET-then-SET it replaces could).
	var wg sync.WaitGroup
	seen := sync.Map{}
	for range 200 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, _ := m.Bump(ctx, "race", 1, time.Hour)
			seen.Store(v, true)
		}()
	}
	wg.Wait()
	distinct := 0
	seen.Range(func(k, _ any) bool {
		if n, err := strconv.Atoi(k.(string)); err == nil && n >= 1 && n <= 200 {
			distinct++
		}
		return true
	})
	if distinct != 200 {
		t.Fatalf("200 concurrent bumps gave %d distinct values", distinct)
	}
}

func TestIAMSchedule(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	half := func() float64 { return 0.5 }
	if got := iamRefreshAt(now.Add(20*time.Minute), half, now); !got.Equal(now.Add(20*time.Minute - 5*time.Minute - 30*time.Second)) {
		t.Fatalf("a fresh token: %v", got.Sub(now))
	}
	if got := iamRefreshAt(now.Add(2*time.Minute), half, now); !got.Equal(now.Add(60 * time.Second)) {
		t.Fatalf("a token with 2 min left retries within a minute: %v", got.Sub(now))
	}
	if got := iamRefreshAt(now.Add(40*time.Second), half, now); got.After(now.Add(20 * time.Second)) {
		t.Fatalf("a token with 40 s left re-authenticates within half of it: %v", got.Sub(now))
	}
	if got := iamRefreshAt(time.Time{}, half, now); !got.Equal(now.Add(30 * time.Minute)) {
		t.Fatalf("no expiry: %v", got.Sub(now))
	}
	// The old rule scheduled a near-expiry refresh 30 min later, after the token died.
	for _, left := range []time.Duration{10 * time.Second, time.Minute, 4 * time.Minute, 6 * time.Minute, time.Hour} {
		for _, r := range []float64{0, 0.5, 1 - 1.0/(1<<53)} {
			if at := iamRefreshAt(now.Add(left), func() float64 { return r }, now); !at.Before(now.Add(left)) {
				t.Fatalf("expiry in %v, r=%v: refresh at +%v is not before expiry", left, r, at.Sub(now))
			}
		}
	}
}
