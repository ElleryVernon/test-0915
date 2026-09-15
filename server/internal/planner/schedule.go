// Package planner ports the pure schedule, planner, grading and AI-validation
// rules of src/lib/schedule.ts, src/lib/server/algorithms.ts and the validators
// of src/lib/server/ai.ts. Every function keeps the TS semantics so students see
// the same suggestions, grades and citation checks from the Go server; the
// golden in testdata/ is generated from the TS originals.
package planner

import (
	"cmp"
	"fmt"
	"slices"
	"strconv"
	"strings"
)

// DayEnd is the TS DAY_END: the latest minute a free slot may end at (23:59).
const DayEnd = 23*60 + 59

// StudyDay is the TS STUDY_DAY: a study day ends at 22:00; the server's evening
// fallback starts at 16:00.
var StudyDay = Interval{Start: "16:00", End: "22:00"}

// Interval is a start/end pair of "HH:MM" times.
type Interval struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

// Dated is a schedule's date ("YYYY-MM-DD") with its interval.
type Dated struct {
	Date  string `json:"date"`
	Start string `json:"start"`
	End   string `json:"end"`
}

// ScheduleRef is a Dated schedule with its id; ScheduleGaps reports which
// schedule a gap precedes.
type ScheduleRef struct {
	ID    string `json:"id"`
	Date  string `json:"date"`
	Start string `json:"start"`
	End   string `json:"end"`
}

// Window is a free "HH:MM" interval offered to fill.
type Window struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

// ScheduleGap is free time on Date before the schedule BeforeID.
type ScheduleGap struct {
	BeforeID string `json:"beforeId"`
	Date     string `json:"date"`
	Start    string `json:"start"`
	End      string `json:"end"`
}

// Options tunes ScheduleGaps, EveningWindow and FreeWindows.
type Options struct {
	// After clips a window that has partly passed; "" means none, like an
	// undefined `after` in TS.
	After string
	// Min is the shortest window in minutes; 0 selects the TS default
	// (15 for ScheduleGaps, 60 for EveningWindow and FreeWindows).
	Min int
	// End is where EveningWindow's window ends; "" selects StudyDay.End.
	End string
}

// Minutes is the TS minutes(): "HH:MM" to minutes since midnight. It is only
// meaningful for well-formed times; a malformed part counts as 0 where TS
// yields NaN.
func Minutes(t string) int {
	parts := strings.SplitN(t, ":", 3)
	hours, _ := strconv.Atoi(parts[0])
	mins := 0
	if len(parts) > 1 {
		mins, _ = strconv.Atoi(parts[1])
	}
	return hours*60 + mins
}

// TimeString is the TS timeString(): minutes since midnight to zero-padded "HH:MM".
func TimeString(m int) string {
	return fmt.Sprintf("%02d:%02d", m/60, m%60)
}

// FormatMinutes is the TS formatMinutes(): "N분" under an hour, otherwise
// "H시간" followed by " M분" when minutes remain.
func FormatMinutes(total int) string {
	if total < 60 {
		return fmt.Sprintf("%d분", total)
	}
	if total%60 != 0 {
		return fmt.Sprintf("%d시간 %d분", total/60, total%60)
	}
	return fmt.Sprintf("%d시간", total/60)
}

// dayOf is the TS `date.slice(0, 10)`.
func dayOf(date string) string {
	if len(date) > 10 {
		return date[:10]
	}
	return date
}

// ScheduleGaps is the TS scheduleGaps(): free time of at least opts.Min minutes
// (default 15) between schedules of the same date. Day boundaries are never
// invented: time before the first and after the last schedule is not a gap.
// opts.After clips a gap that has partly passed.
func ScheduleGaps(schedules []ScheduleRef, opts Options) []ScheduleGap {
	minGap := opts.Min
	if minGap == 0 {
		minGap = 15
	}
	sorted := slices.Clone(schedules)
	slices.SortStableFunc(sorted, func(a, b ScheduleRef) int {
		return cmp.Or(strings.Compare(dayOf(a.Date), dayOf(b.Date)), strings.Compare(a.Start, b.Start))
	})
	gaps := []ScheduleGap{}
	date, occupiedUntil := "", ""
	for _, schedule := range sorted {
		scheduleDate := dayOf(schedule.Date)
		if date != scheduleDate {
			date = scheduleDate
			occupiedUntil = schedule.End
			continue
		}
		start := occupiedUntil
		if opts.After != "" && opts.After > occupiedUntil {
			start = opts.After
		}
		if Minutes(schedule.Start)-Minutes(start) >= minGap {
			gaps = append(gaps, ScheduleGap{BeforeID: schedule.ID, Date: date, Start: start, End: schedule.Start})
		}
		if schedule.End > occupiedUntil {
			occupiedUntil = schedule.End
		}
	}
	return gaps
}

// EveningWindow is the TS eveningWindow(): free time after the last schedule
// until opts.End (default 22:00). There is none for an empty day or when less
// than opts.Min minutes (default 60) remain.
func EveningWindow(schedules []Interval, opts Options) (Window, bool) {
	if len(schedules) == 0 {
		return Window{}, false
	}
	minLen := opts.Min
	if minLen == 0 {
		minLen = 60
	}
	end := opts.End
	if end == "" {
		end = StudyDay.End
	}
	lastEnd := "00:00"
	for _, schedule := range schedules {
		if schedule.End > lastEnd {
			lastEnd = schedule.End
		}
	}
	start := lastEnd
	if opts.After != "" && opts.After > lastEnd {
		start = opts.After
	}
	if Minutes(end)-Minutes(start) >= minLen {
		return Window{Start: start, End: end}, true
	}
	return Window{}, false
}

// FreeWindows is the TS freeWindows(): every free window the timetable offers
// to fill — gaps between schedules and the evening — each at least opts.Min
// minutes (default 60).
func FreeWindows(schedules []ScheduleRef, opts Options) []Window {
	minLen := opts.Min
	if minLen == 0 {
		minLen = 60
	}
	intervals := make([]Interval, len(schedules))
	for i, schedule := range schedules {
		intervals[i] = Interval{Start: schedule.Start, End: schedule.End}
	}
	evening, hasEvening := EveningWindow(intervals, Options{After: opts.After, Min: minLen})
	gaps := ScheduleGaps(schedules, Options{After: opts.After, Min: minLen})
	windows := make([]Window, 0, len(gaps)+1)
	for _, gap := range gaps {
		windows = append(windows, Window{Start: gap.Start, End: gap.End})
	}
	if hasEvening {
		windows = append(windows, evening)
	}
	return windows
}

// FindFreeSlot is the TS findFreeSlot(): the earliest slot of duration minutes
// starting at or after from that overlaps none of others and ends by limit
// (DayEnd for a whole day).
func FindFreeSlot(others []Interval, from, duration, limit int) (Window, bool) {
	candidates := []int{from}
	for _, other := range others {
		if end := Minutes(other.End); end > from {
			candidates = append(candidates, end)
		}
	}
	slices.Sort(candidates)
	for _, start := range candidates {
		end := start + duration
		if end > limit {
			break
		}
		overlaps := slices.ContainsFunc(others, func(other Interval) bool {
			return start < Minutes(other.End) && Minutes(other.Start) < end
		})
		if !overlaps {
			return Window{Start: TimeString(start), End: TimeString(end)}, true
		}
	}
	return Window{}, false
}
