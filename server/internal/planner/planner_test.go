package planner

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"memoryz/server/internal/textmatch"
)

type goldenCase struct {
	Name     string          `json:"name"`
	Input    json.RawMessage `json:"input"`
	Expected json.RawMessage `json:"expected"`
}

type goldenFile struct {
	Suites map[string][]goldenCase `json:"suites"`
}

// requiredSuites must all be present: a truncated golden must not pass quietly.
var requiredSuites = []string{
	"freeWindows", "findFreeSlot", "proposePlans", "validateAiPlans", "validateAiGrade",
	"gradeEssay", "hasCitation", "validDate",
}

func loadGolden(t *testing.T) goldenFile {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatalf("read golden: %v (run `npx tsx server/internal/planner/testdata/gen.ts` from the repo root)", err)
	}
	var golden goldenFile
	if err := json.Unmarshal(data, &golden); err != nil {
		t.Fatalf("decode golden: %v", err)
	}
	for _, suite := range requiredSuites {
		if len(golden.Suites[suite]) == 0 {
			t.Fatalf("golden suite %q is missing or empty", suite)
		}
	}
	return golden
}

// TestParity replays every golden case through the Go port and compares the
// JSON shape with what the TypeScript original produced.
func TestParity(t *testing.T) {
	golden := loadGolden(t)
	total := 0
	for _, suite := range slices.Sorted(maps.Keys(golden.Suites)) {
		for _, c := range golden.Suites[suite] {
			total++
			var want any
			if err := json.Unmarshal(c.Expected, &want); err != nil {
				t.Fatalf("%s/%s: expected: %v", suite, c.Name, err)
			}
			got := canonical(t, replay(t, suite, c.Input))
			if !reflect.DeepEqual(got, want) {
				t.Errorf("%s/%s:\n  input: %s\n  got:   %s\n  want:  %s", suite, c.Name, c.Input, mustJSON(got), mustJSON(want))
			}
		}
	}
	if t.Failed() {
		return
	}
	fmt.Printf("PLANNER_PARITY_OK cases=%d\n", total)
}

// replay runs one case of a suite and returns the Go result in the JSON shape
// gen.ts recorded: a thrown ApiError is {"error":{"status","message"}}.
func replay(t *testing.T, suite string, input json.RawMessage) any {
	t.Helper()
	decode := func(target any) {
		t.Helper()
		if err := json.Unmarshal(input, target); err != nil {
			t.Fatalf("%s input %s: %v", suite, input, err)
		}
	}
	switch suite {
	case "freeWindows":
		var in struct {
			Schedules []ScheduleRef `json:"schedules"`
			After     string        `json:"after"`
			Min       int           `json:"min"`
		}
		decode(&in)
		return FreeWindows(in.Schedules, Options{After: in.After, Min: in.Min})
	case "scheduleGaps":
		var in struct {
			Schedules []ScheduleRef `json:"schedules"`
			After     string        `json:"after"`
			Min       int           `json:"min"`
		}
		decode(&in)
		return ScheduleGaps(in.Schedules, Options{After: in.After, Min: in.Min})
	case "eveningWindow":
		var in struct {
			Schedules []Interval `json:"schedules"`
			After     string     `json:"after"`
			Min       int        `json:"min"`
			End       string     `json:"end"`
		}
		decode(&in)
		return nullable(EveningWindow(in.Schedules, Options{After: in.After, Min: in.Min, End: in.End}))
	case "findFreeSlot":
		var in struct {
			Others   []Interval `json:"others"`
			From     int        `json:"from"`
			Duration int        `json:"duration"`
			Limit    int        `json:"limit"`
		}
		decode(&in)
		return nullable(FindFreeSlot(in.Others, in.From, in.Duration, in.Limit))
	case "proposePlans":
		var in struct {
			Date     string        `json:"date"`
			Existing []Dated       `json:"existing"`
			Subjects []PlanSubject `json:"subjects"`
			After    *string       `json:"after"`
		}
		decode(&in)
		return ProposePlans(in.Date, in.Existing, in.Subjects, in.After)
	case "validateAiPlans":
		var in struct {
			Value    any           `json:"value"`
			Date     string        `json:"date"`
			Existing []Dated       `json:"existing"`
			Subjects []PlanSubject `json:"subjects"`
			After    *string       `json:"after"`
		}
		decode(&in)
		result, err := ValidateAiPlans(in.Value, in.Date, in.Existing, in.Subjects, in.After)
		return resultOrError(t, result, err)
	case "validateAiGrade":
		var in struct {
			Value    any      `json:"value"`
			Keywords []string `json:"keywords"`
		}
		decode(&in)
		result, err := ValidateAiGrade(in.Value, in.Keywords)
		return resultOrError(t, result, err)
	case "gradeEssay":
		var in struct {
			Answer      string   `json:"answer"`
			Keywords    []string `json:"keywords"`
			ModelAnswer string   `json:"modelAnswer"`
		}
		decode(&in)
		return GradeEssay(in.Answer, in.Keywords, in.ModelAnswer)
	case "hasCitation":
		var in struct {
			Source   string `json:"source"`
			Citation string `json:"citation"`
		}
		decode(&in)
		return textmatch.HasCitation(in.Source, in.Citation)
	case "validDate":
		var in struct {
			Value string `json:"value"`
		}
		decode(&in)
		return ValidDate(in.Value)
	case "conflict":
		var in struct {
			A Dated `json:"a"`
			B Dated `json:"b"`
		}
		decode(&in)
		return Conflict(in.A, in.B)
	case "formatMinutes":
		var in struct {
			Total int `json:"total"`
		}
		decode(&in)
		return FormatMinutes(in.Total)
	}
	t.Fatalf("golden suite %q has no Go replay", suite)
	return nil
}

func nullable(window Window, ok bool) any {
	if !ok {
		return nil
	}
	return window
}

func resultOrError(t *testing.T, result any, err error) any {
	t.Helper()
	if err == nil {
		return result
	}
	var rule *RuleError
	if !errors.As(err, &rule) {
		t.Fatalf("unexpected error type %T: %v", err, err)
	}
	return map[string]any{"error": map[string]any{"status": rule.Status, "message": rule.Message}}
}

// canonical round-trips v through JSON so struct results compare with the
// decoded golden shape (maps, slices, float64, nil) regardless of key order.
func canonical(t *testing.T, v any) any {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	return out
}

func mustJSON(v any) string {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%#v", v)
	}
	return string(data)
}

// TestValidDate pins the calendar corners of the TS validDate(): V8 rolls an
// impossible day into the next month, and the round-trip check rejects it.
func TestValidDate(t *testing.T) {
	cases := map[string]bool{
		"2026-09-15":                       true,
		"2024-02-29":                       true,
		"2000-02-29":                       true,
		"2026-04-30":                       true,
		"0000-01-01":                       true,
		"9999-12-31":                       true,
		"2026-02-29":                       false,
		"2026-02-30":                       false,
		"1900-02-29":                       false,
		"2100-02-29":                       false,
		"2026-04-31":                       false,
		"2026-13-01":                       false,
		"2026-00-10":                       false,
		"2026-01-00":                       false,
		"2026-01-32":                       false,
		"9/15/2026":                        false,
		"2026-1-01":                        false,
		"20260915":                         false,
		"2026-09-15T00:00":                 false,
		" 2026-09-15":                      false,
		"2026-09-15 ":                      false,
		"2026-09-15\n":                     false,
		"2026-09-1" + string(rune(0xFF15)): false,
		"2026/09/15":                       false,
		"":                                 false,
	}
	for in, want := range cases {
		if got := ValidDate(in); got != want {
			t.Errorf("ValidDate(%q) = %v, want %v", in, got, want)
		}
	}
}
