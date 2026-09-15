package jitter

import (
	"math/rand/v2"
	"testing"
	"time"
)

const almostOne = 1 - 1.0/(1<<53)

func TestBetween(t *testing.T) {
	zero := func() float64 { return 0 }
	top := func() float64 { return almostOne }
	if got := Between(zero, 3*time.Second, 7*time.Second); got != 3*time.Second {
		t.Fatalf("r=0 gives lo: %v", got)
	}
	if got := Between(top, 3*time.Second, 7*time.Second); got >= 7*time.Second || got < 6*time.Second {
		t.Fatalf("r→1 stays below hi: %v", got)
	}
	if got := Between(top, 5*time.Second, 5*time.Second); got != 5*time.Second {
		t.Fatalf("an empty window gives lo: %v", got)
	}
	if got := Between(top, 5*time.Second, 3*time.Second); got != 5*time.Second {
		t.Fatalf("an inverted window gives lo: %v", got)
	}
	// 100000 draws from a seeded source stay in range with the mean at the midpoint.
	src := rand.New(rand.NewPCG(1, 2)).Float64
	var sum time.Duration
	for range 100000 {
		d := Between(src, 10*time.Second, 20*time.Second)
		if d < 10*time.Second || d >= 20*time.Second {
			t.Fatalf("out of range: %v", d)
		}
		sum += d
	}
	mean := sum / 100000
	if mean < 14850*time.Millisecond || mean > 15150*time.Millisecond {
		t.Fatalf("mean %v is not the midpoint within 1%%", mean)
	}
}

func TestFull(t *testing.T) {
	half := func() float64 { return 0.5 }
	for _, c := range []struct {
		attempt int
		want    time.Duration
	}{
		{0, 12500 * time.Microsecond}, // U[0, 25ms) at 0.5
		{1, 25 * time.Millisecond},    // U[0, 50ms)
		{2, 50 * time.Millisecond},    // capped at 100ms
		{100, 50 * time.Millisecond},  // no overflow past the cap
		{-1, 50 * time.Millisecond},   // a negative attempt is the cap too
	} {
		if got := Full(half, c.attempt, 25*time.Millisecond, 100*time.Millisecond); got != c.want {
			t.Fatalf("Full(attempt %d) = %v, want %v", c.attempt, got, c.want)
		}
	}
}
