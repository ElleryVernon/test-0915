// Package ratelimit counts events per key in the cache over a fixed window. It protects the
// database and the AI budget from bursts; a cache outage fails open so a cache incident never
// locks students out.
package ratelimit

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/cache"
	"memoryz/server/internal/logx"
)

// ErrTooMany is the answer when a limit is exceeded.
var ErrTooMany = apierr.New(429, "요청이 많아요. 잠시 후 다시 시도해 주세요.")

// refusalSpread breaks up the window edge: the 25–50 callers of one key refused in the same window
// come back over 15 s (about 2–3 per second) instead of all at the moment the window resets.
const refusalSpread = 15 * time.Second

// Allow records one event under key and reports whether it stays within limit per window, and how
// long the window has left.
func Allow(ctx context.Context, c cache.Cache, key string, limit int64, window time.Duration) (bool, time.Duration) {
	n, left, err := c.Incr(ctx, "rl:"+key, window)
	if err != nil {
		// Only the limit's name: its key carries a client address or an account id.
		name, _, _ := strings.Cut(key, ":")
		logx.From(ctx).Warn("rate limit unavailable", slog.String("limit", name), slog.String("error", err.Error()))
		return true, 0
	}
	return n <= limit, left
}

// Check is Allow as an error for handlers: a refusal says when to come back.
func Check(ctx context.Context, c cache.Cache, key string, limit int64, window time.Duration) error {
	ok, left := Allow(ctx, c, key, limit, window)
	if ok {
		return nil
	}
	// jitter: retry-after the rest of the window + U[0,15 s) [site server/internal/ratelimit/ratelimit.go:20]
	return ErrTooMany.Retry(left, refusalSpread)
}
