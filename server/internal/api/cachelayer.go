package api

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"memoryz/server/internal/jitter"
	"memoryz/server/internal/logx"
	"memoryz/server/internal/telemetry"
)

// Versioned invalidation: every account has a version counter in the cache; cached answers that
// depend on an account embed its version in their key, so a write only has to bump the counter and
// the old entries fall out of use (and expire by TTL). Nothing here affects correctness — a cold or
// lost cache costs one query.
// Cache TTLs get no jitter: every key is per user or versioned, and an expiry sends no request
// (docs/JITTER.md). Concurrent misses on one key are coalesced by fill instead.
const (
	// jitter: coalesce singleflight on the bootstrap fill; the TTL stays exactly 60 s [site server/internal/api/cachelayer.go:18]
	bootstrapTTL = 60 * time.Second
	// jitter: coalesce singleflight on the posts fill; the TTL stays 15 s [site server/internal/api/cachelayer.go:19]
	postsTTL = 15 * time.Second
	// jitter: coalesce singleflight on the one key shared across users; the TTL stays 1 h [site server/internal/api/cachelayer.go:20]
	schoolsTTL = time.Hour
	// jitter: none — an expired version costs no query (its entries live ≤ 1 h); bumps restart above any old value [site server/internal/api/cachelayer.go:21]
	versionTTL = 7 * 24 * time.Hour
)

func versionKey(userID string) string { return "ver:" + userID }

// version reads an account's counter (0 when unknown).
func (s *Server) version(ctx context.Context, userID string) string {
	raw, ok, err := s.cache.Get(ctx, versionKey(userID))
	if err != nil {
		logx.From(ctx).Warn("cache version read failed", slog.String("error", err.Error()))
		return "0"
	}
	if !ok {
		return "0"
	}
	return string(raw)
}

// bump moves accounts (and the shared "posts"/"schools" lists) to a new version after a write that
// changes what their screens show. Each id is one atomic Cache.Bump of max(current+1, now in ms): two
// concurrent writers can no longer both write n+1 (the GET-then-SET it replaces could), and a value
// never repeats after the key expired. The bumps run on a context detached from the request, so a
// client that leaves as the write commits still moves the versions. Each id gets its own budget and
// runs alongside the others: timeouts on one id (the operation deadline is 250 ms) cannot use up the
// attempts of the next, and the write still waits at most one budget.
func (s *Server) bump(ctx context.Context, ids ...string) {
	base := context.WithoutCancel(ctx)
	var wg sync.WaitGroup
	for _, id := range ids {
		if id == "" {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.bumpOne(base, id)
		}()
	}
	wg.Wait()
}

// bumpOne moves one id's version; a transient cache error is retried twice after full jitter
// (25 ms base, 100 ms cap), within bumpBudget.
func (s *Server) bumpOne(base context.Context, id string) {
	ctx, cancel := context.WithTimeout(base, bumpBudget)
	defer cancel()
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			// jitter: backoff Full(25 ms base, 100 ms cap) between up to 3 attempts on a detached context [site server/internal/api/cachelayer.go:40]
			if !s.pause(ctx, jitter.Full(s.rand, attempt-1, 25*time.Millisecond, 100*time.Millisecond)) {
				break
			}
		}
		if _, err = s.cache.Bump(ctx, versionKey(id), s.now().UnixMilli(), versionTTL); err == nil {
			break
		}
	}
	if err != nil {
		logx.From(ctx).Warn("cache version bump failed", slog.String("userId", id), slog.String("error", err.Error()))
	}
}

// bumpBudget bounds one id's bump with its retries (two 250 ms operation timeouts, or three fast
// errors with their jittered pauses).
const bumpBudget = 500 * time.Millisecond

// sleepCtx waits d or until ctx ends; it reports whether the full wait elapsed.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	// jitter: backoff waits the delay bump already drew with jitter.Full; adds none of its own
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// fillTimeout bounds a shared cache fill; it stays under the 15 s request deadline.
const fillTimeout = 12 * time.Second

// fill returns the cached document under key, or builds it once for everyone asking at the same
// time: concurrent misses on one key wait for a single build (singleflight) instead of each running
// the queries. Under DEMO_MODE a whole class is one demo account, so the bell sends 50 identical
// misses. The build runs on a context detached from the first caller (its client may leave) and
// bounded by fillTimeout; each caller still honours its own context. state is "hit", "miss" (this
// caller built it) or "shared" (it waited for another caller's build). The bytes are shared: read-only.
func (s *Server) fill(ctx context.Context, name, key string, ttl time.Duration, build func(context.Context) ([]byte, error)) ([]byte, string, error) {
	if raw, ok := s.lookup(ctx, name, key); ok {
		return raw, "hit", nil
	}
	led := false
	ch := s.flights.DoChan(key, func() (any, error) {
		led = true
		bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), fillTimeout)
		defer cancel()
		raw, err := build(bctx)
		if err != nil {
			return nil, err
		}
		s.remember(bctx, key, raw, ttl)
		return raw, nil
	})
	select {
	case <-ctx.Done():
		return nil, "", ctx.Err()
	case res := <-ch:
		if res.Err != nil {
			return nil, "", res.Err
		}
		state := "shared"
		if led {
			state = "miss"
		}
		return res.Val.([]byte), state, nil
	}
}

// lookup reads a cached document and records the hit or miss.
func (s *Server) lookup(ctx context.Context, name, key string) ([]byte, bool) {
	raw, ok, err := s.cache.Get(ctx, key)
	if err != nil {
		logx.From(ctx).Warn("cache read failed", slog.String("key", key), slog.String("error", err.Error()))
		ok = false
	}
	telemetry.CacheResult(ctx, name, ok)
	return raw, ok
}

func (s *Server) remember(ctx context.Context, key string, value []byte, ttl time.Duration) {
	if err := s.cache.Set(ctx, key, value, ttl); err != nil {
		logx.From(ctx).Warn("cache write failed", slog.String("key", key), slog.String("error", err.Error()))
	}
}
