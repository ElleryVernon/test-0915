// Package srs is the server half of the deterministic spaced-repetition scheduler the browser runs
// offline (src/lib/srs.ts on ts-fsrs 5.4.2, FSRS-6). Students review cards without a network and
// sync later; the server replays those reviews, so both sides must produce the same next review
// time to the millisecond or the sync is rejected.
//
// The scheduling arithmetic is therefore a literal port of the TypeScript engine — including
// ts-fsrs's rounding to eight decimals after every formula, JavaScript's Math.round, and its UTC
// calendar-day elapsed time — while the FSRS-6 weights, the option set and the enums come from
// go-fsrs v4. go-fsrs's own scheduler skips that rounding and drifts past the 1e-9 parity budget
// (21 of 1479 golden due times differ), so it is not used for scheduling.
//
// Two modes exist, mirroring scheduleCard:
//
//   - FIXED: AGAIN +10 minutes, HARD +1 day, GOOD +3 days, EASY +7 days; two EASY answers in a row
//     mark the card MASTERED; no FSRS state is kept (Result.Fsrs is nil).
//   - FSRS: FSRS-6 with the requested retention (0.80–0.97), no fuzz, short-term scheduling on,
//     learning steps of 1 and 10 minutes, one relearning step of 10 minutes, at most 36500 days.
//
// Timestamps cross the API as ISO-8601 strings with milliseconds and a Z suffix, byte-identical to
// JavaScript's Date.prototype.toISOString(); FormatISO and ParseISO produce and accept them. Every
// time.Time passed in is read at millisecond precision, as JavaScript would.
package srs

import (
	"errors"
	"fmt"
	"math"
	"time"

	fsrs "github.com/open-spaced-repetition/go-fsrs/v4"
)

// Version names the engine, the counterpart of SRS_VERSION in src/lib/srs.ts.
const Version = "go-fsrs@v4.0.0 / FSRS-6"

// Scheduling modes.
const (
	ModeFixed = "FIXED"
	ModeFSRS  = "FSRS"
)

// Review ratings, as the client sends them.
const (
	RatingAgain = "AGAIN"
	RatingHard  = "HARD"
	RatingGood  = "GOOD"
	RatingEasy  = "EASY"
)

// Buckets: the last rating, or MASTERED after two consecutive EASY answers.
const (
	BucketAgain    = RatingAgain
	BucketHard     = RatingHard
	BucketGood     = RatingGood
	BucketEasy     = RatingEasy
	BucketMastered = "MASTERED"
)

// Ratings lists the review ratings in the order PreviewIntervals reports them.
var Ratings = []string{RatingAgain, RatingHard, RatingGood, RatingEasy}

// Retention bounds accepted in FSRS mode.
const (
	MinRetention = 0.8
	MaxRetention = 0.97
)

// Errors, matching the TypeScript scheduler's cases (Go error strings stay lowercase). ErrInvalidState also wraps the
// engine's own rejection of a stored memory state it cannot schedule from.
var (
	ErrInvalidMode   = errors.New("invalid SRS mode")
	ErrInvalidRating = errors.New("invalid review rating")
	ErrInvalidTime   = errors.New("invalid review time")
	ErrRetention     = errors.New("retention must be between 0.80 and 0.97")
	ErrInvalidState  = errors.New("invalid stored FSRS state")
	ErrReviewOrder   = errors.New("review time precedes the last review")
)

// Serialized is the stored FSRS state of a card: SerializedFsrs in src/lib/contracts.ts, with the
// same JSON keys. Due and LastReview are ISO-8601 strings (see FormatISO); State is 0 New,
// 1 Learning, 2 Review, 3 Relearning.
type Serialized struct {
	Due           string  `json:"due"`
	Stability     float64 `json:"stability"`
	Difficulty    float64 `json:"difficulty"`
	ElapsedDays   int     `json:"elapsed_days"`
	ScheduledDays int     `json:"scheduled_days"`
	LearningSteps int     `json:"learning_steps"`
	Reps          int     `json:"reps"`
	Lapses        int     `json:"lapses"`
	State         int     `json:"state"`
	LastReview    string  `json:"last_review,omitempty"`
}

// Input is the part of a card the scheduler reads. Bucket and NextReviewAt are carried for
// symmetry with Result; Schedule only reads ConsecutiveEasy and Fsrs (nil when the card has never
// been scheduled by FSRS, mirroring fsrs: null).
type Input struct {
	ConsecutiveEasy int
	Bucket          string
	NextReviewAt    time.Time
	Fsrs            *Serialized
}

// Result is the card after a review. Fsrs is nil in FIXED mode. NextReviewAt is a UTC instant at
// millisecond precision; format it with FormatISO when it leaves the server.
type Result struct {
	ConsecutiveEasy int
	Bucket          string
	NextReviewAt    time.Time
	Fsrs            *Serialized
}

// Preview is the next review time one rating would produce, as PreviewIntervals reports it.
type Preview struct {
	Rating string `json:"rating"`
	Due    string `json:"due"`
}

// isoLayout renders exactly what Date.prototype.toISOString() renders.
const isoLayout = "2006-01-02T15:04:05.000Z"

// jitter: none — fixed intervals and no FSRS fuzz: due times are evaluated on the device and nothing fires at one [site server/internal/srs/srs.go:123]
var fixedIntervalMs = map[string]int64{
	RatingAgain: 600000,
	RatingHard:  86400000,
	RatingGood:  259200000,
	RatingEasy:  604800000,
}

var grades = map[string]fsrs.Rating{
	RatingAgain: fsrs.Again,
	RatingHard:  fsrs.Hard,
	RatingGood:  fsrs.Good,
	RatingEasy:  fsrs.Easy,
}

// Schedule applies one review and returns the updated card, exactly as scheduleCard does in the
// browser. Validation happens in the same order as there: mode, rating, time, then — in FSRS mode
// only — retention, the stored state, and that now is not before the last review.
func Schedule(in Input, rating, mode string, retention float64, now time.Time) (Result, error) {
	if mode != ModeFixed && mode != ModeFSRS {
		return Result{}, ErrInvalidMode
	}
	grade, ok := grades[rating]
	if !ok {
		return Result{}, ErrInvalidRating
	}
	if now.IsZero() {
		return Result{}, ErrInvalidTime
	}
	nowMs := now.UnixMilli() // JavaScript time is whole milliseconds
	consecutiveEasy := 0
	if rating == RatingEasy {
		consecutiveEasy = in.ConsecutiveEasy + 1
	}
	bucket := rating
	if consecutiveEasy >= 2 {
		bucket = BucketMastered
	}
	if mode == ModeFixed {
		return Result{
			ConsecutiveEasy: consecutiveEasy,
			Bucket:          bucket,
			NextReviewAt:    fromMs(nowMs + fixedIntervalMs[rating]),
		}, nil
	}
	if math.IsNaN(retention) || math.IsInf(retention, 0) || retention < MinRetention || retention > MaxRetention {
		return Result{}, ErrRetention
	}
	old, err := restore(in.Fsrs, nowMs)
	if err != nil {
		return Result{}, err
	}
	if old.hasLastReview && nowMs < old.lastReview {
		return Result{}, ErrReviewOrder
	}
	next, err := newEngine(retention).next(old, nowMs, grade)
	if err != nil {
		return Result{}, err
	}
	serialized := next.serialize()
	return Result{
		ConsecutiveEasy: consecutiveEasy,
		Bucket:          bucket,
		NextReviewAt:    fromMs(next.due),
		Fsrs:            &serialized,
	}, nil
}

// IsDue reports whether a card should be reviewed at now: not deleted, not MASTERED in FIXED mode
// (a MASTERED card with FSRS state keeps coming back), and due no later than now, compared at
// millisecond precision. A zero nextReviewAt is never due, like an unparsable date in JavaScript.
func IsDue(deleted bool, bucket string, fsrs *Serialized, nextReviewAt, now time.Time) bool {
	if deleted || nextReviewAt.IsZero() {
		return false
	}
	if bucket == BucketMastered && fsrs == nil {
		return false
	}
	return nextReviewAt.UnixMilli() <= now.UnixMilli()
}

// PreviewIntervals returns the next review time each rating would produce, in Ratings order; the
// first scheduling error is returned as is.
func PreviewIntervals(in Input, mode string, retention float64, now time.Time) ([]Preview, error) {
	out := make([]Preview, 0, len(Ratings))
	for _, rating := range Ratings {
		res, err := Schedule(in, rating, mode, retention, now)
		if err != nil {
			return nil, err
		}
		out = append(out, Preview{Rating: rating, Due: FormatISO(res.NextReviewAt)})
	}
	return out, nil
}

// FormatISO renders t the way Date.prototype.toISOString() does: UTC, milliseconds, Z.
func FormatISO(t time.Time) string {
	return t.UTC().Format(isoLayout)
}

// ParseISO accepts what the app stores and sends: RFC 3339 timestamps with any fractional-second
// precision and either Z or an offset, or a bare YYYY-MM-DD (UTC midnight, as Date.parse reads it).
func ParseISO(s string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, nil
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t, nil
	}
	return time.Time{}, fmt.Errorf("srs: cannot parse time %q", s)
}

func fromMs(ms int64) time.Time { return time.UnixMilli(ms).UTC() }

func formatMs(ms int64) string { return fromMs(ms).Format(isoLayout) }

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// restore rebuilds the engine's card from the stored state (createEmptyCard(now) when there is
// none) and rejects what the TypeScript restore rejects: a non-finite stability or difficulty, a
// state outside 0..3, a due date that does not parse. An unparsable last_review is rejected too —
// TypeScript would carry NaN into the arithmetic and fail while serializing the result.
func restore(v *Serialized, nowMs int64) (card, error) {
	if v == nil {
		return card{due: nowMs, state: fsrs.New}, nil
	}
	if !finite(v.Stability) || !finite(v.Difficulty) || v.State < int(fsrs.New) || v.State > int(fsrs.Relearning) {
		return card{}, ErrInvalidState
	}
	due, err := ParseISO(v.Due)
	if err != nil {
		return card{}, ErrInvalidState
	}
	c := card{
		due:           due.UnixMilli(),
		stability:     v.Stability,
		difficulty:    v.Difficulty,
		elapsedDays:   v.ElapsedDays,
		scheduledDays: v.ScheduledDays,
		reps:          v.Reps,
		lapses:        v.Lapses,
		learningSteps: v.LearningSteps,
		state:         fsrs.State(v.State),
	}
	if v.LastReview != "" {
		last, err := ParseISO(v.LastReview)
		if err != nil {
			return card{}, ErrInvalidState
		}
		c.lastReview = last.UnixMilli()
		c.hasLastReview = true
	}
	return c, nil
}

func (c card) serialize() Serialized {
	s := Serialized{
		Due:           formatMs(c.due),
		Stability:     c.stability,
		Difficulty:    c.difficulty,
		ElapsedDays:   c.elapsedDays,
		ScheduledDays: c.scheduledDays,
		LearningSteps: c.learningSteps,
		Reps:          c.reps,
		Lapses:        c.lapses,
		State:         int(c.state),
	}
	if c.hasLastReview {
		s.LastReview = formatMs(c.lastReview)
	}
	return s
}
