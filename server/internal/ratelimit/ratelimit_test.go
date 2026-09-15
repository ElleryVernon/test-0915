package ratelimit

import (
	"context"
	"errors"
	"testing"
	"time"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/cache"
)

// fixedCache answers Incr with a preset count, window and error.
type fixedCache struct {
	cache.Cache
	n    int64
	left time.Duration
	err  error
}

func (f fixedCache) Incr(context.Context, string, time.Duration) (int64, time.Duration, error) {
	return f.n, f.left, f.err
}

func TestRatelimitHint(t *testing.T) {
	ctx := context.Background()
	err := Check(ctx, fixedCache{n: 11, left: 42 * time.Second}, "k", 10, time.Minute)
	e, ok := apierr.From(err)
	if !ok || e.Status != 429 || e.RetryMin != 42*time.Second || e.RetrySpread != refusalSpread || !errors.Is(err, ErrTooMany) {
		t.Fatalf("a refusal carries the window's rest + spread: %+v", err)
	}
	if err := Check(ctx, fixedCache{n: 10, left: 42 * time.Second}, "k", 10, time.Minute); err != nil {
		t.Fatalf("the limit itself is allowed: %v", err)
	}
	if ok, _ := Allow(ctx, fixedCache{err: errors.New("down")}, "k", 1, time.Minute); !ok {
		t.Fatal("a cache outage fails open")
	}
	if ErrTooMany.RetryMin != 0 {
		t.Fatal("the sentinel is never mutated")
	}
}
