package planner

import (
	"encoding/json"
	"math"
	"slices"
	"strings"
	"unicode/utf8"
)

// RuleError is the TS ApiError the AI validators raise: the HTTP status and the
// Korean message the client shows.
type RuleError struct {
	Status  int
	Message string
}

func (e *RuleError) Error() string { return e.Message }

// RuleMethod is the TS RULE_METHOD: the method reported when both plans came
// from the rules.
const RuleMethod = "규칙 기반 일정 추천"

// The validators' errors, with the TS status and text.
var (
	ErrPlansShape        = &RuleError{Status: 502, Message: "AI 추천 일정의 형식을 확인하지 못했어요."}
	ErrGradeShape        = &RuleError{Status: 502, Message: "AI 채점 결과 형식이 올바르지 않아요."}
	ErrGradeKeywords     = &RuleError{Status: 502, Message: "AI 채점 결과의 핵심 키워드를 확인하지 못했어요."}
	ErrGradeInconsistent = &RuleError{Status: 502, Message: "AI 점수와 피드백이 일치하지 않아요."}
)

// PlansResult is the TS validateAiPlans() result.
type PlansResult struct {
	Plans   []Plan `json:"plans"`
	Method  string `json:"method"`
	Dropped int    `json:"dropped"`
}

// GradeResult is the TS validateAiGrade() result.
type GradeResult struct {
	Score    int      `json:"score"`
	Matched  []string `json:"matched"`
	Missing  []string `json:"missing"`
	Feedback string   `json:"feedback"`
	Method   string   `json:"method"`
}

// ValidateAiPlans is the TS validateAiPlans(). raw is the decoded JSON the model
// returned (map[string]any, []any, string, float64, bool, nil); a shape the plans
// schema rejects is ErrPlansShape. It keeps only AI blocks that satisfy every
// schedule rule (date, 06:00–23:00, not before after, known subject, 25–60
// minutes, no overlap with existing schedules, 10-minute rest, 4 hours and 4
// blocks per plan). A plan left empty is replaced by the rule-based plan of the
// same intent, and Method says which source was used: "AI", "AI+규칙" or
// RuleMethod.
func ValidateAiPlans(raw any, date string, existing []Dated, subjects []PlanSubject, after *string) (PlansResult, error) {
	parsed, ok := parseAiPlans(raw)
	if !ok {
		return PlansResult{}, ErrPlansShape
	}
	dropped := 0
	plans := make([]Plan, 0, len(parsed))
	for _, plan := range parsed {
		blocks := slices.Clone(plan.blocks)
		slices.SortStableFunc(blocks, func(x, y aiBlock) int { return strings.Compare(x.start, y.start) })
		kept := []Block{}
		total := 0
		for _, block := range blocks {
			duration := Minutes(block.end) - Minutes(block.start)
			knownSubject := block.subjectID == nil || *block.subjectID == "" ||
				slices.ContainsFunc(subjects, func(subject PlanSubject) bool { return subject.ID == *block.subjectID })
			overlapsExisting := slices.ContainsFunc(existing, func(other Dated) bool {
				return Conflict(Dated{Date: block.date, Start: block.start, End: block.end}, other)
			})
			rested := len(kept) == 0 || Minutes(block.start)-Minutes(kept[len(kept)-1].End) >= PlanLimit.Rest
			valid := block.date == date &&
				block.start < block.end &&
				block.start >= "06:00" &&
				block.end <= "23:00" &&
				(after == nil || block.start >= *after) &&
				knownSubject &&
				duration >= 25 &&
				duration <= 60 &&
				!overlapsExisting &&
				rested &&
				total+duration <= PlanLimit.Minutes &&
				len(kept) < PlanLimit.Blocks
			if !valid {
				dropped++
				continue
			}
			kept = append(kept, Block{Title: block.title, Date: block.date, Start: block.start, End: block.end, Kind: "FLEXIBLE", SubjectID: block.subjectID, Done: false})
			total += duration
		}
		plans = append(plans, Plan{Name: plan.name, Reason: plan.reason, Blocks: kept})
	}
	fromAI := make([]bool, len(plans))
	allAI, anyAI := true, false
	for i, plan := range plans {
		fromAI[i] = len(plan.Blocks) > 0
		allAI = allAI && fromAI[i]
		anyAI = anyAI || fromAI[i]
	}
	if allAI {
		return PlansResult{Plans: plans, Method: "AI", Dropped: dropped}, nil
	}
	rules := ProposePlans(date, existing, subjects, after).Plans
	for i := range plans {
		if !fromAI[i] {
			plans[i] = rules[i]
		}
	}
	method := RuleMethod
	if anyAI {
		method = "AI+규칙"
	}
	return PlansResult{Plans: plans, Method: method, Dropped: dropped}, nil
}

// ValidateAiGrade is the TS validateAiGrade(): raw must match the grade schema
// (integer score 0–100, matched and missing of at most 20 strings, feedback of
// 10–3000 characters), matched and missing together must name every keyword
// exactly once, and a score of 100 leaves nothing missing.
func ValidateAiGrade(raw any, keywords []string) (GradeResult, error) {
	object, ok := asObject(raw)
	if !ok {
		return GradeResult{}, ErrGradeShape
	}
	score, ok := asNumber(object["score"])
	if !ok || !isSafeInteger(score) || score < 0 || score > 100 {
		return GradeResult{}, ErrGradeShape
	}
	matched, ok := asStringList(object["matched"], 20)
	if !ok {
		return GradeResult{}, ErrGradeShape
	}
	missing, ok := asStringList(object["missing"], 20)
	if !ok {
		return GradeResult{}, ErrGradeShape
	}
	feedback, ok := asBoundedString(object["feedback"], 10, 3000)
	if !ok {
		return GradeResult{}, ErrGradeShape
	}
	all := append(slices.Clone(matched), missing...)
	distinct := map[string]struct{}{}
	for _, word := range all {
		distinct[word] = struct{}{}
	}
	unknown := slices.ContainsFunc(all, func(word string) bool { return !slices.Contains(keywords, word) })
	if len(all) != len(keywords) || len(distinct) != len(keywords) || unknown {
		return GradeResult{}, ErrGradeKeywords
	}
	if score == 100 && len(missing) > 0 {
		return GradeResult{}, ErrGradeInconsistent
	}
	return GradeResult{Score: int(score), Matched: matched, Missing: missing, Feedback: feedback, Method: "AI"}, nil
}

// The parsers below mirror the zod schemas of ai.ts on values decoded by
// encoding/json. Unknown object keys are ignored, as zod strips them; a
// missing key is an undefined value, which every field here rejects.

type aiBlock struct {
	title, date, start, end string
	subjectID               *string
}

type aiPlan struct {
	name, reason string
	blocks       []aiBlock
}

// parseAiPlans is plansSchema: exactly two plans, each with a name and reason of
// 1–80 characters and at most 8 blocks.
func parseAiPlans(raw any) ([]aiPlan, bool) {
	root, ok := asObject(raw)
	if !ok {
		return nil, false
	}
	plansRaw, ok := asArray(root["plans"])
	if !ok || len(plansRaw) != 2 {
		return nil, false
	}
	plans := make([]aiPlan, 0, len(plansRaw))
	for _, planRaw := range plansRaw {
		plan, ok := asObject(planRaw)
		if !ok {
			return nil, false
		}
		name, ok := asBoundedString(plan["name"], 1, 80)
		if !ok {
			return nil, false
		}
		reason, ok := asBoundedString(plan["reason"], 1, 80)
		if !ok {
			return nil, false
		}
		blocksRaw, ok := asArray(plan["blocks"])
		if !ok || len(blocksRaw) > 8 {
			return nil, false
		}
		blocks := make([]aiBlock, 0, len(blocksRaw))
		for _, blockRaw := range blocksRaw {
			block, ok := parseAiBlock(blockRaw)
			if !ok {
				return nil, false
			}
			blocks = append(blocks, block)
		}
		plans = append(plans, aiPlan{name: name, reason: reason, blocks: blocks})
	}
	return plans, true
}

// parseAiBlock is one block of plansSchema: title 1–100 characters, any date
// string, HH:MM start and end, kind 'FLEXIBLE', subjectId string or null (the
// key must be present) and done false.
func parseAiBlock(raw any) (aiBlock, bool) {
	object, ok := asObject(raw)
	if !ok {
		return aiBlock{}, false
	}
	title, ok := asBoundedString(object["title"], 1, 100)
	if !ok {
		return aiBlock{}, false
	}
	date, ok := asString(object["date"])
	if !ok {
		return aiBlock{}, false
	}
	start, ok := asString(object["start"])
	if !ok || !isTimeValue(start) {
		return aiBlock{}, false
	}
	end, ok := asString(object["end"])
	if !ok || !isTimeValue(end) {
		return aiBlock{}, false
	}
	if kind, ok := asString(object["kind"]); !ok || kind != "FLEXIBLE" {
		return aiBlock{}, false
	}
	subjectRaw, present := object["subjectId"]
	if !present {
		return aiBlock{}, false
	}
	var subjectID *string
	if subjectRaw != nil {
		id, ok := asString(subjectRaw)
		if !ok {
			return aiBlock{}, false
		}
		subjectID = &id
	}
	if done, ok := object["done"].(bool); !ok || done {
		return aiBlock{}, false
	}
	return aiBlock{title: title, date: date, start: start, end: end, subjectID: subjectID}, true
}

// isTimeValue is the TS timeValue regex /^([01]\d|2[0-3]):[0-5]\d$/.
func isTimeValue(s string) bool {
	if len(s) != 5 || s[2] != ':' {
		return false
	}
	digit := func(c byte) bool { return c >= '0' && c <= '9' }
	if !digit(s[1]) || !digit(s[4]) || s[3] < '0' || s[3] > '5' {
		return false
	}
	switch s[0] {
	case '0', '1':
		return true
	case '2':
		return s[1] <= '3'
	}
	return false
}

func asObject(v any) (map[string]any, bool) {
	object, ok := v.(map[string]any)
	return object, ok
}

func asArray(v any) ([]any, bool) {
	array, ok := v.([]any)
	return array, ok
}

func asString(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok
}

// asBoundedString is z.string().min(minLen).max(maxLen). zod 4 measures strings
// in Unicode code points (its util.codePointLength), unlike the plain JS
// String.length the grading and citation rules use, so a rune count is exact.
func asBoundedString(v any, minLen, maxLen int) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	n := utf8.RuneCountInString(s)
	return s, n >= minLen && n <= maxLen
}

// asStringList is z.array(z.string()).max(maxLen).
func asStringList(v any, maxLen int) ([]string, bool) {
	items, ok := asArray(v)
	if !ok || len(items) > maxLen {
		return nil, false
	}
	list := make([]string, 0, len(items))
	for _, item := range items {
		s, ok := asString(item)
		if !ok {
			return nil, false
		}
		list = append(list, s)
	}
	return list, true
}

// asNumber accepts what encoding/json produces for a JSON number (float64, or
// json.Number under UseNumber) and Go integer values handed in directly.
func asNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

const maxSafeInteger = 1<<53 - 1

// isSafeInteger is z.number().int(): a finite integer within JavaScript's safe range.
func isSafeInteger(n float64) bool {
	return !math.IsNaN(n) && !math.IsInf(n, 0) && n == math.Trunc(n) && math.Abs(n) <= maxSafeInteger
}
