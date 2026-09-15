package srs

import (
	"math"

	fsrs "github.com/open-spaced-repetition/go-fsrs/v4"
)

// Bounds shared with ts-fsrs (S_MIN, S_MAX, INIT_S_MAX, W17_W18_Ceiling).
const (
	sMin          = 1e-3
	sMax          = 36500
	initSMax      = 100
	w17w18Ceiling = 2
)

// engineParameters mirrors the options src/lib/srs.ts hands to fsrs(): go-fsrs's FSRS-6 default
// weights (the same 21 values as ts-fsrs 5.4.2's default_w — the tests pin them), the requested
// retention, no fuzz, short-term scheduling on, learning steps of 1 and 10 minutes, one relearning
// step of 10 minutes and a 36500-day ceiling. Decay and Factor on the go-fsrs struct are ignored:
// the engine recomputes them with ts-fsrs's rounding. testdata/mutation.mjs rewrites single values
// here to prove the golden tells them apart.
func engineParameters(retention float64) fsrs.Parameters {
	p := fsrs.DefaultParam()
	p.RequestRetention = retention
	p.MaximumInterval = 36500
	p.EnableFuzz = false
	p.EnableShortTerm = true
	p.LearningSteps = []float64{1, 10}
	p.RelearningSteps = []float64{10}
	p.W = clipParameters(p.W, len(p.RelearningSteps), p.EnableShortTerm)
	return p
}

// clampRanges is CLAMP_PARAMETERS: the admissible interval of each weight.
func clampRanges(ceiling float64, enableShortTerm bool) [21][2]float64 {
	w19Min := 0.0
	if enableShortTerm {
		w19Min = 0.01
	}
	return [21][2]float64{
		{sMin, initSMax}, {sMin, initSMax}, {sMin, initSMax}, {sMin, initSMax},
		{1, 10},
		{1e-3, 4}, {1e-3, 4},
		{1e-3, 0.75},
		{0, 4.5},
		{0, 0.8},
		{1e-3, 3.5},
		{1e-3, 5},
		{1e-3, 0.25},
		{1e-3, 0.9},
		{0, 4},
		{0, 1},
		{1, 6},
		{0, ceiling}, {0, ceiling},
		{w19Min, 0.8},
		{0.1, 0.8},
	}
}

// clipParameters is ts-fsrs's clipParameters: every weight is clamped into its range, and with
// more than one relearning step w17/w18 get a tighter ceiling derived from w11, w13 and w14.
func clipParameters(w fsrs.Weights, numRelearningSteps int, enableShortTerm bool) fsrs.Weights {
	clip := clampRanges(w17w18Ceiling, enableShortTerm)
	if numRelearningSteps > 1 {
		w11 := clamp(w[11], clip[11][0], clip[11][1])
		w13 := clamp(w[13], clip[13][0], clip[13][1])
		w14 := clamp(w[14], clip[14][0], clip[14][1])
		value := -(math.Log(w11) + math.Log(math.Pow(2, w13)-1) + float64(w14*0.3)) / float64(numRelearningSteps)
		ceiling := clamp(roundTo(math.Sqrt(math.Max(value, 0)), 8), 0.01, w17w18Ceiling)
		clip[17][1] = ceiling
		clip[18][1] = ceiling
	}
	for i := range w {
		w[i] = clamp(w[i], clip[i][0], clip[i][1])
	}
	return w
}
