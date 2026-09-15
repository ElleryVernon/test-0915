package planner

import (
	"cmp"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"memoryz/server/internal/textmatch"
)

// Conflict is the TS conflict(): same date and overlapping intervals; touching
// endpoints do not conflict.
func Conflict(a, b Dated) bool {
	return a.Date == b.Date && Minutes(a.Start) < Minutes(b.End) && Minutes(b.Start) < Minutes(a.End)
}

// ValidDate is the TS validDate(): "YYYY-MM-DD" naming a real calendar date.
// V8 rolls "2026-02-30" over to March 2, so the TS round-trip comparison fails
// there; time.Parse rejects such a day outright, which is the same verdict.
func ValidDate(s string) bool {
	if len(s) != 10 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if i == 4 || i == 7 {
			if s[i] != '-' {
				return false
			}
			continue
		}
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	parsed, err := time.Parse("2006-01-02", s)
	return err == nil && parsed.Format("2006-01-02") == s
}

// PlanSubject is a subject the planner may schedule; DueCards is how many
// cards wait for review (0 when unknown, as the TS `dueCards ?? 0`).
type PlanSubject struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	DueCards int    `json:"dueCards"`
}

// PlanLimit is the TS PLAN_LIMIT: at most 4 blocks and 240 minutes per plan,
// with 10 minutes of rest between blocks.
var PlanLimit = struct{ Blocks, Minutes, Rest int }{Blocks: 4, Minutes: 240, Rest: 10}

// Block is a proposed FLEXIBLE schedule without an id (the TS Omit<Schedule, 'id'>).
type Block struct {
	Title     string  `json:"title"`
	Date      string  `json:"date"`
	Start     string  `json:"start"`
	End       string  `json:"end"`
	Kind      string  `json:"kind"`
	SubjectID *string `json:"subjectId,omitempty"`
	Done      bool    `json:"done"`
}

// Plan is one planner proposal.
type Plan struct {
	Name   string  `json:"name"`
	Reason string  `json:"reason"`
	Blocks []Block `json:"blocks"`
}

// Plans is the TS proposePlans() result.
type Plans struct {
	Plans []Plan `json:"plans"`
}

type blockSpec struct {
	title     string
	subjectID string
	duration  int
}

// ProposePlans is the TS proposePlans(): the rule-based fallback for the two
// planner proposals. Blocks fill the free windows the timetable shows (gaps
// between schedules and the evening until 22:00); an empty day uses
// 16:00–22:00. after keeps today's proposals out of time that has already
// passed; nil or "" means no limit.
func ProposePlans(date string, existing []Dated, subjects []PlanSubject, after *string) Plans {
	afterTime := ""
	if after != nil {
		afterTime = *after
	}
	occupied := []Interval{}
	refs := []ScheduleRef{}
	for _, block := range existing {
		if block.Date != date {
			continue
		}
		refs = append(refs, ScheduleRef{ID: strconv.Itoa(len(refs)), Date: block.Date, Start: block.Start, End: block.End})
		occupied = append(occupied, Interval{Start: block.Start, End: block.End})
	}
	free := FreeWindows(refs, Options{After: afterTime, Min: 60})
	floor := 0
	if afterTime != "" {
		floor = Minutes(afterTime)
	}
	windows := make([][2]int, 0, len(free))
	for _, window := range free {
		windows = append(windows, [2]int{Minutes(window.Start), Minutes(window.End)})
	}
	if len(windows) == 0 {
		windows = append(windows, [2]int{max(Minutes(StudyDay.Start), floor), Minutes(StudyDay.End)})
	}
	targets := subjects
	if len(targets) == 0 {
		targets = []PlanSubject{{ID: "", Name: "자율 학습", DueCards: 0}}
	}
	place := func(specs []blockSpec) []Block {
		blocks := []Block{}
		cursor, total := 0, 0
		for _, spec := range specs {
			if len(blocks) >= PlanLimit.Blocks {
				break
			}
			// The TS tries the spec's duration first and 25 minutes as the fallback,
			// each in every window, and takes the first slot that fits the day's total.
			durations := []int{spec.duration}
			if spec.duration != 25 {
				durations = append(durations, 25)
			}
			slot, found := Window{}, false
			for _, duration := range durations {
				if total+duration > PlanLimit.Minutes {
					continue
				}
				for _, window := range windows {
					if slot, found = FindFreeSlot(occupied, max(window[0], cursor), duration, window[1]); found {
						break
					}
				}
				if found {
					break
				}
			}
			if !found {
				continue
			}
			var subjectID *string
			if spec.subjectID != "" {
				id := spec.subjectID
				subjectID = &id
			}
			blocks = append(blocks, Block{Title: spec.title, Date: date, Start: slot.Start, End: slot.End, Kind: "FLEXIBLE", SubjectID: subjectID, Done: false})
			cursor = Minutes(slot.End) + PlanLimit.Rest
			total += Minutes(slot.End) - Minutes(slot.Start)
		}
		return blocks
	}
	title := func(subject PlanSubject, activity string) string {
		if subject.ID != "" {
			return subject.Name + " " + activity
		}
		return subject.Name
	}
	byDue := slices.Clone(targets)
	slices.SortStableFunc(byDue, func(a, b PlanSubject) int { return cmp.Compare(b.DueCards, a.DueCards) })
	top := byDue[0]
	reviewSpecs := make([]blockSpec, PlanLimit.Blocks)
	for index := range reviewSpecs {
		subject := byDue[index%len(byDue)]
		cycle := index / len(byDue)
		activity, duration := [3]string{"개념 정리", "문제 풀이", "개념 복습"}[min(cycle, 2)], 50
		if cycle == 0 && subject.DueCards > 0 {
			activity, duration = "복습 카드", 25
		}
		reviewSpecs[index] = blockSpec{title: title(subject, activity), subjectID: subject.ID, duration: duration}
	}
	evenSpecs := make([]blockSpec, PlanLimit.Blocks)
	for index := range evenSpecs {
		subject := targets[index%len(targets)]
		cycle := index / len(targets)
		activity := [3]string{"핵심 복습", "문제 풀이", "개념 정리"}[min(cycle, 2)]
		evenSpecs[index] = blockSpec{title: title(subject, activity), subjectID: subject.ID, duration: 25}
	}
	review := place(reviewSpecs)
	even := place(evenSpecs)
	evenSubjects := map[string]struct{}{}
	for _, block := range even {
		id := ""
		if block.SubjectID != nil {
			id = *block.SubjectID
		}
		evenSubjects[id] = struct{}{}
	}
	reviewReason := "복습할 카드가 없어서 개념 정리부터 담았어요"
	if top.DueCards > 0 {
		withDue := 0
		for _, subject := range targets {
			if subject.DueCards > 0 {
				withDue++
			}
		}
		most := ""
		if withDue > 1 {
			most = "가장 많이 "
		}
		reviewReason = fmt.Sprintf("%s 복습 카드 %d장이 %s기다려요", top.Name, top.DueCards, most)
	}
	evenReason := "25분씩 나눠서 · 사이 10분 이상 쉬어요"
	if len(evenSubjects) > 1 {
		evenReason = fmt.Sprintf("과목 %d개를 25분씩 · 사이 10분 이상 쉬어요", len(evenSubjects))
	}
	return Plans{Plans: []Plan{
		{Name: "복습 우선", Reason: reviewReason, Blocks: review},
		{Name: "골고루", Reason: evenReason, Blocks: even},
	}}
}

// Grade is the TS gradeEssay() result: a transparent practice rubric, not a
// claim of semantic AI evaluation.
type Grade struct {
	Score    int      `json:"score"`
	Matched  []string `json:"matched"`
	Missing  []string `json:"missing"`
	Feedback string   `json:"feedback"`
}

// GradeEssay is the TS gradeEssay(): 60 points for the share of keywords found,
// 25 when two or more found keywords appear in the given (causal) order, 15
// when the answer is at least 40 characters and 45% of the model answer, both
// measured as JavaScript string lengths.
func GradeEssay(answer string, keywords []string, modelAnswer string) Grade {
	text := textmatch.Normalized(answer)
	matched, missing := []string{}, []string{}
	present := []int{}
	for _, word := range keywords {
		// Byte offsets order the same way as the TS UTF-16 offsets; only the order matters.
		position := strings.Index(text, textmatch.Normalized(word))
		if position >= 0 {
			matched = append(matched, word)
			present = append(present, position)
		} else {
			missing = append(missing, word)
		}
	}
	ordered := len(present) >= 2
	for index := 1; index < len(present) && ordered; index++ {
		ordered = present[index] > present[index-1]
	}
	modelLength := float64(textmatch.UTF16Len(textmatch.Normalized(modelAnswer)))
	sufficientLength := float64(textmatch.UTF16Len(text)) >= math.Max(40, float64(modelLength*0.45))
	share := float64(len(matched)) / float64(max(len(keywords), 1))
	score := int(math.Round(float64(share * 60)))
	if ordered {
		score += 25
	}
	if sufficientLength {
		score += 15
	}
	score = min(100, score)
	order := "핵심 키워드를 원인부터 결과 순서로 연결해 보세요."
	if ordered {
		order = "키워드의 인과 순서가 맞아요."
	}
	length := "키워드 사이의 관계를 문장으로 더 설명해 보세요."
	if sufficientLength {
		length = "설명 분량이 충분해요."
	}
	feedback := fmt.Sprintf("키워드·순서 기반 연습 채점입니다. AI 의미 평가가 아닙니다. 핵심 키워드 %d/%d개가 포함됐어요. %s %s", len(matched), len(keywords), order, length)
	return Grade{Score: score, Matched: matched, Missing: missing, Feedback: feedback}
}
