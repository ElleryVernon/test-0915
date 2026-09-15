package srs

import (
	"fmt"
	"math"
	"time"

	fsrs "github.com/open-spaced-repetition/go-fsrs/v4"
)

// card is ts-fsrs's Card with times as Unix milliseconds, the unit JavaScript computes in.
// learningSteps is the current step index (ts-fsrs), not go-fsrs's RemainingSteps.
type card struct {
	due           int64
	stability     float64
	difficulty    float64
	elapsedDays   int
	scheduledDays int
	reps          int
	lapses        int
	learningSteps int
	state         fsrs.State
	lastReview    int64
	hasLastReview bool
}

const (
	minuteMs = int64(60_000)
	dayMs    = int64(86_400_000)
)

// dateDiffInDays counts UTC calendar days between two instants, like ts-fsrs: 23:59 to 00:01
// the next day is one day, an hour earlier the same day is zero.
func dateDiffInDays(lastMs, curMs int64) int {
	l := time.UnixMilli(lastMs).UTC()
	c := time.UnixMilli(curMs).UTC()
	utc1 := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, time.UTC).UnixMilli()
	utc2 := time.Date(c.Year(), c.Month(), c.Day(), 0, 0, 0, 0, time.UTC).UnixMilli()
	return int(math.Floor(float64(utc2-utc1) / 864e5))
}

// scheduler is one scheduling pass (AbstractScheduler): last is the card as stored, current the
// same card with the review applied to its counters, reviewTime the review instant.
type scheduler struct {
	e           *engine
	last        card
	current     card
	reviewTime  int64
	elapsedDays int
}

// next is FSRS.next: the card after one review.
func (e *engine) next(c card, nowMs int64, g fsrs.Rating) (card, error) {
	s := &scheduler{e: e, last: c, current: c, reviewTime: nowMs}
	if c.state != fsrs.New && c.hasLastReview {
		s.elapsedDays = dateDiffInDays(c.lastReview, nowMs)
	}
	s.current.lastReview = nowMs
	s.current.hasLastReview = true
	s.current.elapsedDays = s.elapsedDays
	s.current.reps++
	if !e.p.EnableShortTerm {
		return s.longTerm(g)
	}
	switch c.state {
	case fsrs.New:
		return s.newState(g)
	case fsrs.Learning, fsrs.Relearning:
		return s.learningState(g)
	case fsrs.Review:
		return s.reviewState(g)
	}
	return card{}, fmt.Errorf("%w: state %d", ErrInvalidState, c.state)
}

// nextDs copies the current card with the memory state grade g produces after t elapsed days.
func (s *scheduler) nextDs(t int, g fsrs.Rating, r *float64) (card, error) {
	d, st, err := s.e.nextState(s.current.difficulty, s.current.stability, t, g, r)
	if err != nil {
		return card{}, err
	}
	c := s.current
	c.difficulty = d
	c.stability = st
	return c, nil
}

// learningInfo is BasicLearningStepsStrategy + getLearningInfo: the minutes until the next step
// for grade g from the current state and step index, and the step index it leads to. Zero
// minutes means "no step: graduate to Review".
func (s *scheduler) learningInfo(g fsrs.Rating) (minutes float64, nextStep int) {
	state := s.current.state
	curStep := s.current.learningSteps
	steps := s.e.p.LearningSteps
	if state == fsrs.Relearning || state == fsrs.Review {
		steps = s.e.p.RelearningSteps
	}
	n := len(steps)
	if n == 0 || curStep >= n {
		return 0, 0
	}
	stepAt := func(i int) (float64, bool) {
		if i < 0 || i >= n {
			return 0, false
		}
		return steps[i], true
	}
	first := steps[0]
	ok := false
	if state == fsrs.Review {
		// Only Again leaves Review, onto the first relearning step.
		if g == fsrs.Again {
			minutes, _ = stepAt(max(0, curStep))
			nextStep, ok = 0, true
		}
	} else {
		switch g {
		case fsrs.Again:
			minutes, nextStep, ok = first, 0, true
		case fsrs.Hard:
			if n == 1 {
				minutes = jsRound(float64(first * 1.5))
			} else {
				minutes = jsRound((first + steps[1]) / 2)
			}
			nextStep, ok = curStep, true
		case fsrs.Good:
			if m, found := stepAt(curStep + 1); found && m != 0 {
				minutes, nextStep, ok = jsRound(m), curStep+1, true
			}
		}
	}
	if !ok {
		return 0, 0
	}
	return math.Max(0, minutes), max(0, nextStep)
}

// applyLearningSteps places next on its learning step, or graduates it to Review.
func (s *scheduler) applyLearningSteps(next *card, g fsrs.Rating, toState fsrs.State) {
	minutes, nextStep := s.learningInfo(g)
	if minutes > 0 && minutes < 1440 {
		next.learningSteps = nextStep
		next.scheduledDays = 0
		next.state = toState
		next.due = s.reviewTime + int64(jsRound(minutes))*minuteMs
		return
	}
	next.state = fsrs.Review
	if minutes >= 1440 {
		next.learningSteps = nextStep
		next.due = s.reviewTime + int64(jsRound(minutes))*minuteMs
		next.scheduledDays = int(math.Floor(minutes / 1440))
		return
	}
	next.learningSteps = 0
	interval := s.e.nextInterval(next.stability, float64(s.elapsedDays))
	next.scheduledDays = int(interval)
	next.due = s.reviewTime + int64(interval)*dayMs
}

func (s *scheduler) setReview(c *card, interval float64) {
	c.scheduledDays = int(interval)
	c.due = s.reviewTime + int64(interval)*dayMs
	c.state = fsrs.Review
	c.learningSteps = 0
}

func (s *scheduler) newState(g fsrs.Rating) (card, error) {
	next, err := s.nextDs(s.elapsedDays, g, nil)
	if err != nil {
		return card{}, err
	}
	s.applyLearningSteps(&next, g, fsrs.Learning)
	return next, nil
}

func (s *scheduler) learningState(g fsrs.Rating) (card, error) {
	next, err := s.nextDs(s.elapsedDays, g, nil)
	if err != nil {
		return card{}, err
	}
	s.applyLearningSteps(&next, g, s.last.state)
	return next, nil
}

// reviewState computes all four outcomes, as ts-fsrs does: Hard is capped by Good, Good exceeds
// Hard and Easy exceeds Good by at least a day, and Again enters relearning with a lapse.
func (s *scheduler) reviewState(g fsrs.Rating) (card, error) {
	interval := s.elapsedDays
	r := s.e.forgettingCurve(float64(interval), s.current.stability)
	again, hard, good, easy, err := s.fourWays(interval, &r)
	if err != nil {
		return card{}, err
	}
	hardIvl := s.e.nextInterval(hard.stability, float64(interval))
	goodIvl := s.e.nextInterval(good.stability, float64(interval))
	hardIvl = math.Min(hardIvl, goodIvl)
	goodIvl = math.Max(goodIvl, hardIvl+1)
	easyIvl := math.Max(s.e.nextInterval(easy.stability, float64(interval)), goodIvl+1)
	s.setReview(&hard, hardIvl)
	s.setReview(&good, goodIvl)
	s.setReview(&easy, easyIvl)
	s.applyLearningSteps(&again, fsrs.Again, fsrs.Relearning)
	again.lapses++
	return pickGrade(g, again, hard, good, easy), nil
}

// longTerm is LongTermScheduler (enable_short_term false): no learning steps, every rating lands
// in Review with strictly increasing intervals.
func (s *scheduler) longTerm(g fsrs.Rating) (card, error) {
	if s.last.state == fsrs.New {
		s.current.scheduledDays = 0
		s.current.elapsedDays = 0
		again, hard, good, easy, err := s.fourWays(0, nil)
		if err != nil {
			return card{}, err
		}
		s.longTermIntervals(&again, &hard, &good, &easy, 0)
		return pickGrade(g, again, hard, good, easy), nil
	}
	interval := s.elapsedDays
	r := s.e.forgettingCurve(float64(interval), s.current.stability)
	again, hard, good, easy, err := s.fourWays(interval, &r)
	if err != nil {
		return card{}, err
	}
	s.longTermIntervals(&again, &hard, &good, &easy, interval)
	again.lapses++
	return pickGrade(g, again, hard, good, easy), nil
}

func (s *scheduler) longTermIntervals(again, hard, good, easy *card, elapsedDays int) {
	againIvl := s.e.nextInterval(again.stability, float64(elapsedDays))
	hardIvl := s.e.nextInterval(hard.stability, float64(elapsedDays))
	goodIvl := s.e.nextInterval(good.stability, float64(elapsedDays))
	easyIvl := s.e.nextInterval(easy.stability, float64(elapsedDays))
	againIvl = math.Min(againIvl, hardIvl)
	hardIvl = math.Max(hardIvl, againIvl+1)
	goodIvl = math.Max(goodIvl, hardIvl+1)
	easyIvl = math.Max(easyIvl, goodIvl+1)
	s.setReview(again, againIvl)
	s.setReview(hard, hardIvl)
	s.setReview(good, goodIvl)
	s.setReview(easy, easyIvl)
}

func (s *scheduler) fourWays(t int, r *float64) (again, hard, good, easy card, err error) {
	if again, err = s.nextDs(t, fsrs.Again, r); err != nil {
		return
	}
	if hard, err = s.nextDs(t, fsrs.Hard, r); err != nil {
		return
	}
	if good, err = s.nextDs(t, fsrs.Good, r); err != nil {
		return
	}
	easy, err = s.nextDs(t, fsrs.Easy, r)
	return
}

func pickGrade(g fsrs.Rating, again, hard, good, easy card) card {
	switch g {
	case fsrs.Again:
		return again
	case fsrs.Hard:
		return hard
	case fsrs.Good:
		return good
	default:
		return easy
	}
}
