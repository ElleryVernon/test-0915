package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"memoryz/server/internal/ai"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/config"
	"memoryz/server/internal/planner"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestInfrastructureFailuresDoNotMasqueradeAsQualityFailures(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{"quota", apierr.New(503, "quota"), true},
		{"rate limit", apierr.New(429, "busy"), true},
		{"timeout", apierr.New(504, "slow"), true},
		{"wrapped deadline", fmt.Errorf("judge: %w", context.DeadlineExceeded), true},
		{"cancelled", context.Canceled, true},
		{"quality refusal", apierr.New(422, "refused"), false},
		{"malformed generated content", apierr.New(502, "invalid output"), false},
		{"no error", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := infrastructureError(tc.err); got != tc.want {
				t.Fatalf("infrastructureError = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestResumeOptionsAndCaseHashGuards(t *testing.T) {
	if validateResumeOptions("report.json", "", false) != nil {
		t.Fatal("product-only resume rejected")
	}
	if validateResumeOptions("report.json", "", true) == nil || validateResumeOptions("report.json", "review.json", false) == nil {
		t.Fatal("conflicting resume flags accepted")
	}
	c := Case{ID: "case", Source: "original source"}
	b, _ := json.Marshal(c)
	job := evalJob{c: c, task: "quiz"}
	saved := map[string]Result{job.key(): {CaseID: c.ID, Task: "quiz", InputHash: hash(b)}}
	if err := validateQueuedCheckpoints([]evalJob{job}, saved, false); err != nil {
		t.Fatal(err)
	}
	changed := job
	changed.c.Source = "changed extraction"
	if validateQueuedCheckpoints([]evalJob{changed}, saved, false) == nil {
		t.Fatal("changed per-case source accepted")
	}
	if validateQueuedCheckpoints([]evalJob{job, job}, saved, false) == nil {
		t.Fatal("duplicate queued task accepted")
	}
	if validateQueuedCheckpoints([]evalJob{job}, nil, true) == nil {
		t.Fatal("offline review accepted missing output")
	}
}

func TestSummaryExcludesHistoricalUsageButKeepsQualityFailures(t *testing.T) {
	oldCost, newCost := 0.75, 0.025
	rows := []Result{{CheckpointReused: true, Error: "422 quality refusal", Usage: []ai.Usage{{Cost: &oldCost}, {Cost: nil}}}, {CheckpointReused: true, Failures: []string{"known quality failure"}}, {Usage: []ai.Usage{{Cost: &newCost}, {Cost: nil}}}}
	got := summarizeResults(rows)
	if got.passed != 1 || got.reused != 2 || got.calls != 2 || got.unknownCost != 1 || got.cost != newCost {
		t.Fatalf("historical billing or lost failures: %+v", got)
	}
}

func TestFeedbackReviewChecksSemanticKeywordAccounting(t *testing.T) {
	for _, tc := range []struct {
		name, answer     string
		matched, missing []string
		semantic         bool
		wantFailure      bool
	}{
		{"concise proposition", "Vmax is unchanged.", []string{"Vmax"}, []string{}, true, false},
		{"mere term incorrectly matched", "Vmax", []string{"Vmax"}, []string{}, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := Case{}
			c.Grade.Keywords = []string{"Vmax"}
			c.Grade.Prompt = "State the effect on Vmax."
			c.Grade.Citation = "Vmax is unchanged."
			g := planner.GradeResult{Score: 100, Matched: tc.matched, Missing: tc.missing, Feedback: "최대 속도 변화에 대한 답변입니다."}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					w.WriteHeader(400)
					return
				}
				prompt := body["messages"].([]any)[1].(map[string]any)["content"].(string)
				var data map[string]any
				if err := json.Unmarshal([]byte(prompt[strings.Index(prompt, "{"):]), &data); err != nil {
					t.Error(err)
				}
				for key, want := range map[string]any{"keywords": []any{"Vmax"}, "matched": []any{"Vmax"}, "missing": []any{}, "studentAnswer": tc.answer} {
					if !reflect.DeepEqual(data[key], want) {
						t.Errorf("review omitted %s: %v", key, data[key])
					}
				}
				schema := body["response_format"].(map[string]any)["json_schema"].(map[string]any)["schema"].(map[string]any)
				if schema["properties"].(map[string]any)["semanticAccounting"] == nil {
					t.Error("semantic accounting absent from schema")
				}
				if !strings.Contains(prompt, "concise correct propositions") || !strings.Contains(prompt, "bare list of terms") {
					t.Error("semantic boundary missing from rubric")
				}
				writeFakeCompletion(w, map[string]any{"accurate": true, "answerSpecific": true, "actionable": true, "semanticAccounting": tc.semantic, "issues": []string{}}, 0.001)
			}))
			defer srv.Close()
			cfg := checkpointConfig()
			cfg.OpenRouterAPIKey = "local-test-key"
			p := ai.NewProvider(cfg, srv.URL, slog.Default())
			issues, err := reviewFeedback(context.Background(), p, c, Answer{Answer: tc.answer}, g)
			if err != nil || (len(issues) > 0) != tc.wantFailure {
				t.Fatalf("semantic verdict lost: issues=%v error=%v", issues, err)
			}
		})
	}
}

func writeFakeCompletion(w http.ResponseWriter, value any, cost float64) {
	b, _ := json.Marshal(value)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"id": "local-only", "model": "openai/gpt-5.6-luna", "provider": "OpenAI", "choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": string(b)}}}, "usage": map[string]any{"prompt_tokens": 3, "completion_tokens": 2, "cost": cost}})
}

// The subprocess exercises real flag parsing/main/report behavior. It has only
// a fake key and a loopback endpoint, never the parent's provider credentials.
func TestRunnerCLIHelper(t *testing.T) {
	if os.Getenv("LEARNING_EVAL_TEST_HELPER") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Args = append([]string{os.Args[0]}, os.Args[i+1:]...)
			break
		}
	}
	flag.CommandLine = flag.NewFlagSet("learning-eval", flag.ExitOnError)
	main()
	os.Exit(0)
}

func runnerCLI(t *testing.T, endpoint string, args ...string) (string, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], append([]string{"-test.run=^TestRunnerCLIHelper$", "--"}, args...)...)
	cmd.Env = []string{"LEARNING_EVAL_TEST_HELPER=1", "ENV=development", "DATABASE_URL=postgres://unused/unused", "OPENROUTER_API_KEY=local-test-key", "OPENROUTER_MODEL=openai/gpt-5.6-luna", "OPENROUTER_PROVIDER_ORDER=openai/fast", "OPENROUTER_REASONING_EFFORT=high", "OPENROUTER_STRUCTURED_MODE=json_schema", "OPENROUTER_BASE_URL=" + endpoint, "AI_QUALITY_REVIEW=false"}
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("local runner timed out: %s", output)
	}
	if err == nil {
		return string(output), 0
	}
	if e, ok := err.(*exec.ExitError); ok {
		return string(output), e.ExitCode()
	}
	t.Fatal(err)
	return "", -1
}

func resumeFixture(t *testing.T) (*config.Config, Case, string, string) {
	t.Helper()
	cfg := checkpointConfig()
	cfg.AIQualityReview = false
	c := Case{ID: "resume-case", Split: "dev", Source: "Competitive inhibition leaves Vmax unchanged."}
	c.Grade.Prompt = "What changes?"
	c.Grade.Keywords = []string{"Vmax"}
	c.Grade.ModelAnswer = "Vmax is unchanged."
	c.Grade.Citation = c.Source
	c.Grade.Answers = []Answer{{ID: "correct", Answer: "Vmax is unchanged.", MinScore: 90, MaxScore: 100}, {ID: "refused", Answer: "Vmax", MinScore: 0, MaxScore: 20}, {ID: "retry", Answer: "It changes.", MinScore: 0, MaxScore: 20}}
	b, _ := json.Marshal(map[string]any{"version": 1, "cases": []Case{c}})
	path := filepath.Join(t.TempDir(), "cases.json")
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
	return cfg, c, path, hash(b)
}

func TestCLIResumeReusesTerminalRowsAndOnlyCallsForInfrastructure(t *testing.T) {
	cfg, c, casesPath, inputHash := resumeFixture(t)
	cb, _ := json.Marshal(c)
	caseHash := hash(cb)
	oldCost := 0.5
	correct := checkpointRow("grade/correct")
	correct.CaseID = c.ID
	correct.InputHash = caseHash
	correct.Output = planner.GradeResult{Score: 100, Matched: []string{"Vmax"}, Missing: []string{}, Feedback: "최대 속도가 변하지 않는다는 설명이 정확합니다."}
	correct.ProductDurationMs = 45000
	correct.Usage = []ai.Usage{{Cost: &oldCost}}
	refused := checkpointRow("grade/refused")
	refused.CaseID = c.ID
	refused.InputHash = caseHash
	refused.Error = "422 quality refusal"
	refused.Usage = []ai.Usage{{Cost: &oldCost}}
	retry := checkpointRow("grade/retry")
	retry.CaseID = c.ID
	retry.InputHash = caseHash
	retry.Error = "504 timeout"
	retry.InfrastructureError = true
	report := checkpointReport(cfg, correct, refused, retry)
	report["inputHash"] = inputHash
	saved := saveCheckpoint(t, report)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeFakeCompletion(w, map[string]any{"score": 0, "matched": []string{}, "missing": []string{"Vmax"}, "feedback": "최대 속도는 변하지 않습니다. 변화 방향을 다시 확인하세요."}, 0.004)
	}))
	defer srv.Close()
	out := filepath.Join(t.TempDir(), "resumed")
	output, exit := runnerCLI(t, srv.URL, "--allow-live", "--cases", casesPath, "--tasks", "grade", "--count", "1", "--judge=false", "--resume-products", saved, "--out", out)
	if exit != 1 || calls.Load() != 1 {
		t.Fatalf("terminal tasks regenerated or wrong exit: calls=%d exit=%d %s", calls.Load(), exit, output)
	}
	var got struct {
		CheckpointVersion                                 int    `json:"checkpointVersion"`
		BinarySHA256                                      string `json:"binarySHA256"`
		RequestedCount                                    int    `json:"requestedCount"`
		ProductBudgetMs                                   int64  `json:"productBudgetMs"`
		ResumedReport                                     string `json:"resumedReport"`
		RubricVersion                                     string `json:"rubricVersion"`
		Tasks, Passed, Failed, ProviderCalls, ReusedTasks int
		ReportedCostUSD                                   float64
		Results                                           []Result
	}
	b, err := os.ReadFile(filepath.Join(out, "report.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	binaryHash, err := currentBinarySHA256()
	if err != nil || got.BinarySHA256 != binaryHash || len(binaryHash) != 64 {
		t.Fatalf("runner fingerprint differs from checkpoint: %q, %v", got.BinarySHA256, err)
	}
	if got.CheckpointVersion != 1 || got.RequestedCount != 1 || got.ProductBudgetMs != ai.RequestTimeout.Milliseconds() || got.ResumedReport != saved || got.RubricVersion != "2.2.1" || got.Tasks != 3 || got.Passed != 2 || got.Failed != 1 || got.ProviderCalls != 1 || got.ReusedTasks != 2 || got.ReportedCostUSD != 0.004 {
		t.Fatalf("wrong report accounting: %s", b)
	}
	if !got.Results[0].CheckpointReused || got.Results[0].ProductDurationMs != 45000 || got.Results[1].Error != refused.Error || got.Results[2].CheckpointReused {
		t.Fatalf("checkpoint evidence lost: %+v", got.Results)
	}
}

func TestCLIRejectsChangedBinaryBeforeCalls(t *testing.T) {
	cfg, _, casesPath, inputHash := resumeFixture(t)
	report := checkpointReport(cfg)
	report["inputHash"] = inputHash
	report["binarySHA256"] = strings.Repeat("0", 64)
	saved := saveCheckpoint(t, report)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer srv.Close()
	out := filepath.Join(t.TempDir(), "mismatched")
	output, exit := runnerCLI(t, srv.URL, "--allow-live", "--cases", casesPath, "--tasks", "grade", "--count", "1", "--judge=false", "--resume-products", saved, "--out", out)
	if exit != 2 || calls.Load() != 0 || !strings.Contains(output, "binarySHA256 mismatch") {
		t.Fatalf("changed executable accepted: exit=%d calls=%d %s", exit, calls.Load(), output)
	}
	if _, err := os.Stat(out); !os.IsNotExist(err) {
		t.Fatalf("mismatched run wrote output: %v", err)
	}
}

func TestCLIConcurrentTasksPreserveAllCheckpointRows(t *testing.T) {
	_, _, casesPath, _ := resumeFixture(t)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeFakeCompletion(w, map[string]any{"score": 0, "matched": []string{}, "missing": []string{"Vmax"}, "feedback": "최대 속도는 변하지 않습니다."}, 0.004)
	}))
	defer srv.Close()
	out := filepath.Join(t.TempDir(), "parallel")
	output, exit := runnerCLI(t, srv.URL, "--allow-live", "--cases", casesPath, "--tasks", "grade", "--count", "1", "--jobs", "3", "--judge=false", "--out", out)
	if exit != 1 || calls.Load() != 3 {
		t.Fatalf("concurrent local tasks failed: exit=%d calls=%d %s", exit, calls.Load(), output)
	}
	var report struct {
		Incomplete    bool     `json:"incomplete"`
		ProviderCalls int      `json:"providerCalls"`
		Results       []Result `json:"results"`
	}
	b, err := os.ReadFile(filepath.Join(out, "report.json"))
	if err != nil || json.Unmarshal(b, &report) != nil {
		t.Fatalf("final atomic checkpoint unreadable: %s, %v", b, err)
	}
	if report.Incomplete || report.ProviderCalls != 3 || len(report.Results) != 3 {
		t.Fatalf("concurrent checkpoint lost rows: %s", b)
	}
	for i, task := range []string{"grade/correct", "grade/refused", "grade/retry"} {
		if report.Results[i].Task != task || report.Results[i].CheckpointReused || report.Results[i].Error != "" {
			t.Fatalf("invalid concurrent row %d: %+v", i, report.Results[i])
		}
	}
	if remnants, err := filepath.Glob(filepath.Join(out, ".checkpoint-*")); err != nil || len(remnants) != 0 {
		t.Fatalf("atomic checkpoint left temporary files: %v, %v", remnants, err)
	}
}

func TestCLIInfrastructureStopStillPreservesLaterCheckpoints(t *testing.T) {
	cfg, c, casesPath, inputHash := resumeFixture(t)
	cb, _ := json.Marshal(c)
	later := checkpointRow("grade/retry")
	later.CaseID = c.ID
	later.InputHash = hash(cb)
	later.Error = "422 terminal refusal"
	report := checkpointReport(cfg, later)
	report["inputHash"] = inputHash
	saved := saveCheckpoint(t, report)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(http.StatusTooManyRequests) }))
	defer srv.Close()
	out := filepath.Join(t.TempDir(), "stopped")
	output, exit := runnerCLI(t, srv.URL, "--allow-live", "--cases", casesPath, "--tasks", "grade", "--count", "1", "--judge=false", "--stop-on-infrastructure-error", "--resume-products", saved, "--out", out)
	// The provider re-sends a never-billed 429 ai.UpstreamRetries times before it counts as an outage.
	if exit != 2 || calls.Load() != int32(1+ai.UpstreamRetries) {
		t.Fatalf("infrastructure did not stop: exit=%d calls=%d %s", exit, calls.Load(), output)
	}
	kept, err := loadProductCheckpoints(filepath.Join(out, "report.json"), cfg, inputHash, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(kept) != 1 || kept[c.ID+"--grade/retry"].Error != later.Error {
		t.Fatalf("later saved row lost after earlier outage: %+v", kept)
	}
	// Every completed task is already in an atomically replaced report.
	if _, err := os.Stat(filepath.Join(out, "resume-case--grade_correct.json")); err != nil {
		t.Fatal(err)
	}
}

func TestRejudgingPreservesOriginalProductLatency(t *testing.T) {
	old := Result{Task: "grade/correct", SkillVersion: "2.4.0", ProductDurationMs: 12345,
		Output: planner.GradeResult{Score: 100, Matched: []string{"Vmax"}, Missing: []string{}, Feedback: "최대 속도가 변하지 않는다는 설명이 정확합니다."}}
	c := Case{ID: "test"}
	a := Answer{ID: "correct", MinScore: 90, MaxScore: 100, ExpectedMatched: []string{"Vmax"}}
	got := run(nil, nil, c, "grade", &a, 1, false, &old)
	if got.ProductDurationMs != old.ProductDurationMs || got.Error != "" || len(got.Failures) != 0 || len(got.Usage) != 0 {
		t.Fatalf("rejudging changed the original product measurement: %+v", got)
	}
}

func TestGradeOracleRejectsPlausibleButWrongOutputs(t *testing.T) {
	a := Answer{MinScore: 0, MaxScore: 25, ExpectedMatched: []string{"경쟁"}, ExpectedMissing: []string{"Vmax"}, MustMention: []string{"maximum", "최대"}}
	g := planner.GradeResult{Score: 25, Matched: []string{"경쟁"}, Missing: []string{"Vmax"}, Feedback: "Maximum 속도는 변하지 않습니다."}
	if fs := gradeFailures(g, a); len(fs) > 0 {
		t.Fatal(fs)
	}
	g.Score = 42
	if len(gradeFailures(g, a)) == 0 {
		t.Fatal("overgraded central misconception passed")
	}
	g.Score = 20
	g.Matched = []string{"Vmax"}
	g.Missing = []string{"경쟁"}
	if len(gradeFailures(g, a)) < 2 {
		t.Fatal("contradictory keyword membership passed")
	}
	g.Matched = []string{"경쟁"}
	g.Missing = []string{"Vmax"}
	g.Feedback = "다시 공부하세요."
	if len(gradeFailures(g, a)) == 0 {
		t.Fatal("generic feedback passed")
	}
}

func TestProductionPagesCannotSilentlyDisappear(t *testing.T) {
	dir := t.TempDir()
	writeJSON := func(name string, v any) {
		t.Helper()
		b, _ := json.Marshal(v)
		if err := os.WriteFile(filepath.Join(dir, name), b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeJSON("audit.json", map[string]any{"files": []any{map[string]any{"file": "actual.pdf", "pagesPath": "pages.json"}}})
	writeJSON("pages.json", []any{map[string]any{"page": 1, "text": "first"}, map[string]any{"page": 2, "text": "second"}})
	c := []Case{{ID: "case", PDFFile: "actual.pdf", PageStart: 1, PageEnd: 2, Source: "gold"}}
	if err := useProductionExtraction(c, dir); err != nil {
		t.Fatal(err)
	}
	if c[0].Source != "firstsecond" || c[0].ReferenceSource != "gold" {
		t.Fatal("extraction was not used")
	}
	for _, pages := range [][]any{
		{map[string]any{"page": 1, "text": "first"}, map[string]any{"page": 1, "text": "duplicate"}, map[string]any{"page": 2, "text": "second"}},
		{map[string]any{"page": 2, "text": "second"}, map[string]any{"page": 1, "text": "first"}},
	} {
		writeJSON("pages.json", pages)
		if useProductionExtraction(c, dir) == nil {
			t.Fatal("duplicate or out-of-order pages accepted")
		}
	}
	writeJSON("pages.json", []any{map[string]any{"page": 1, "text": "first"}, map[string]any{"page": 2, "text": "second"}})
	c[0].PageEnd = 3
	if useProductionExtraction(c, dir) == nil {
		t.Fatal("missing page accepted")
	}
	c[0].PDFFile = "unknown.pdf"
	if useProductionExtraction(c, dir) == nil {
		t.Fatal("unknown source accepted")
	}
}
