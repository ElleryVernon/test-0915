// Package jitter holds the timing shapes the server uses to keep class-shaped events (the bell, a
// classroom's Wi-Fi coming back, a deploy, a rate-limit window edge, lifetimes created together)
// from lining actors up (docs/JITTER.md): a uniform window (Between) and AWS full jitter (Full).
// The third shape, the server's Retry-After hint, is drawn from Between in httpx.Fail.
//
// Randomness is injected: owners hold a Rand next to their clock, tests pin it, and production uses
// Std (math/rand/v2 — goroutine-safe and seeded per process, so two instances never share a sequence).
package jitter

import (
	"math/rand/v2"
	"time"
)

// Rand returns a float64 in [0, 1).
type Rand func() float64

// Std is the production source.
func Std() float64 { return rand.Float64() }

// Between is uniform in [lo, hi); hi <= lo gives lo.
func Between(r Rand, lo, hi time.Duration) time.Duration {
	if hi <= lo {
		return lo
	}
	return lo + time.Duration(r()*float64(hi-lo))
}

// Full is AWS full jitter: uniform in [0, min(cap, base·2^attempt)). An attempt large enough to
// overflow the shift is treated as reaching the cap.
func Full(r Rand, attempt int, base, cap time.Duration) time.Duration {
	c := cap
	if attempt >= 0 && attempt < 62 {
		if v := base << attempt; v > 0 && v < cap {
			c = v
		}
	}
	return Between(r, 0, c)
}
