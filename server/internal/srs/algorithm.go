package srs

import (
	"fmt"
	"math"

	fsrs "github.com/open-spaced-repetition/go-fsrs/v4"
)

// engine is FSRSAlgorithm from ts-fsrs 5.4.2 with the parameters src/lib/srs.ts uses. Every
// formula rounds to eight decimals exactly where the TypeScript does, and products that feed an
// addition are forced through float64() so the Go compiler cannot fuse them into an FMA — V8
// rounds each operation separately, and parity is judged at 1e-9.
type engine struct {
	p                fsrs.Parameters
	w                fsrs.Weights
	decay            float64
	factor           float64
	intervalModifier float64
}

func newEngine(retention float64) *engine {
	p := engineParameters(retention)
	e := &engine{p: p, w: p.W}
	e.decay, e.factor = computeDecayFactor(p.W[20])
	e.intervalModifier = roundTo((math.Pow(p.RequestRetention, 1/e.decay)-1)/e.factor, 8)
	return e
}

// jsRound is JavaScript's Math.round: halves round toward +∞ (V8: ceil(x), minus one when
// ceil(x) - 0.5 > x), unlike math.Round which rounds halves away from zero.
func jsRound(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	r := math.Ceil(x)
	if r-0.5 <= x {
		return r
	}
	return r - 1
}

// roundTo is ts-fsrs's roundTo: Math.round(num * 10**decimals) / 10**decimals.
func roundTo(num float64, decimals int) float64 {
	factor := 1.0
	for range decimals {
		factor *= 10 // exact: 10**decimals is an integer well below 2**53
	}
	return jsRound(float64(num*factor)) / factor
}

func clamp(value, lo, hi float64) float64 { return math.Min(math.Max(value, lo), hi) }

// computeDecayFactor: decay = -w20, factor = e^(log(0.9)/decay) - 1 rounded to eight decimals.
func computeDecayFactor(w20 float64) (decay, factor float64) {
	decay = -w20
	factor = roundTo(math.Exp(math.Pow(decay, -1)*math.Log(0.9))-1, 8)
	return decay, factor
}

// forgettingCurve is the retrievability after elapsedDays at the given stability.
func (e *engine) forgettingCurve(elapsedDays, stability float64) float64 {
	return roundTo(math.Pow(1+float64(e.factor*elapsedDays)/stability, e.decay), 8)
}

func (e *engine) initStability(g fsrs.Rating) float64 {
	return math.Max(e.w[g-1], 0.1)
}

// initDifficulty is unclamped, as in ts-fsrs: the New-card path clamps it, mean reversion does not.
func (e *engine) initDifficulty(g fsrs.Rating) float64 {
	return roundTo(e.w[4]-math.Exp(float64(g-1)*e.w[5])+1, 8)
}

// nextInterval is the scheduled days for a stability: round(s × modifier), at least 1, at most
// MaximumInterval. Fuzz is off; the ts-fsrs fuzz path (an Alea PRNG seeded with JavaScript's
// number formatting) is not ported, so enabling it is a programming error.
func (e *engine) nextInterval(s, elapsedDays float64) float64 {
	ivl := math.Min(math.Max(1, jsRound(float64(s*e.intervalModifier))), e.p.MaximumInterval)
	if !e.p.EnableFuzz || ivl < 2.5 {
		return jsRound(ivl)
	}
	panic("srs: interval fuzz is not ported; the scheduler must stay deterministic")
}

func (e *engine) linearDamping(deltaD, oldD float64) float64 {
	return roundTo(float64(deltaD*(10-oldD))/9, 8)
}

func (e *engine) nextDifficulty(d float64, g fsrs.Rating) float64 {
	deltaD := -e.w[6] * float64(g-3)
	nextD := d + e.linearDamping(deltaD, d)
	return clamp(e.meanReversion(e.initDifficulty(fsrs.Easy), nextD), 1, 10)
}

func (e *engine) meanReversion(initial, current float64) float64 {
	return roundTo(float64(e.w[7]*initial)+float64((1-e.w[7])*current), 8)
}

func (e *engine) nextRecallStability(d, s, r float64, g fsrs.Rating) float64 {
	hardPenalty := 1.0
	if g == fsrs.Hard {
		hardPenalty = e.w[15]
	}
	easyBound := 1.0
	if g == fsrs.Easy {
		easyBound = e.w[16]
	}
	growth := math.Exp(e.w[8]) * (11 - d) * math.Pow(s, -e.w[9]) * (math.Exp(float64((1-r)*e.w[10])) - 1) * hardPenalty * easyBound
	return roundTo(clamp(s*(1+float64(growth)), sMin, sMax), 8)
}

func (e *engine) nextForgetStability(d, s, r float64) float64 {
	v := e.w[11] * math.Pow(d, -e.w[12]) * (math.Pow(s+1, e.w[13]) - 1) * math.Exp(float64((1-r)*e.w[14]))
	return roundTo(clamp(v, sMin, sMax), 8)
}

func (e *engine) nextShortTermStability(s float64, g fsrs.Rating) float64 {
	sinc := math.Pow(s, -e.w[19]) * math.Exp(float64(e.w[17]*(float64(g-3)+e.w[18])))
	if g >= fsrs.Hard {
		sinc = math.Max(sinc, 1)
	}
	return roundTo(clamp(s*sinc, sMin, sMax), 8)
}

// nextState is FSRSAlgorithm.next_state: the memory state after grade g with t elapsed days.
// r overrides the retrievability when the caller already computed it (the Review state does).
func (e *engine) nextState(d, s float64, t int, g fsrs.Rating, r *float64) (newD, newS float64, err error) {
	if t < 0 {
		return 0, 0, fmt.Errorf("%w: invalid delta_t %d", ErrInvalidState, t)
	}
	if d == 0 && s == 0 {
		return clamp(e.initDifficulty(g), 1, 10), e.initStability(g), nil
	}
	if d < 1 || s < sMin {
		return 0, 0, fmt.Errorf("%w: invalid memory state { difficulty: %v, stability: %v }", ErrInvalidState, d, s)
	}
	retrievability := 0.0
	if r != nil {
		retrievability = *r
	} else {
		retrievability = e.forgettingCurve(float64(t), s)
	}
	switch {
	case t == 0 && e.p.EnableShortTerm:
		newS = e.nextShortTermStability(s, g)
	case g == fsrs.Again:
		afterFail := e.nextForgetStability(d, s, retrievability)
		w17, w18 := 0.0, 0.0
		if e.p.EnableShortTerm {
			w17, w18 = e.w[17], e.w[18]
		}
		floor := s / math.Exp(w17*w18)
		newS = clamp(roundTo(floor, 8), sMin, afterFail)
	default:
		newS = e.nextRecallStability(d, s, retrievability, g)
	}
	return e.nextDifficulty(d, g), newS, nil
}
