package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"memoryz/server/internal/ai"
	"memoryz/server/internal/config"
	"memoryz/server/internal/planner"
)

func checkpointConfig() *config.Config {
	return &config.Config{OpenRouterModel: "openai/gpt-5.6-luna", OpenRouterQualityModel: "", OpenRouterEffort: "high", OpenRouterProviderOrder: []string{"openai/fast"}, OpenRouterStructuredMode: "json_schema", AIQualityReview: true}
}
func checkpointReport(cfg *config.Config, results ...Result) map[string]any {
	if results == nil {
		results = []Result{}
	}
	binaryHash, err := currentBinarySHA256()
	if err != nil {
		panic(err)
	}
	return map[string]any{"checkpointVersion": 1, "binarySHA256": binaryHash, "judgeEnabled": false, "model": cfg.OpenRouterModel, "productionQualityReview": cfg.AIQualityReview, "productionReviewModel": cfg.OpenRouterQualityModel, "reasoningEffort": cfg.OpenRouterEffort, "providerOrder": cfg.OpenRouterProviderOrder, "structuredMode": cfg.OpenRouterStructuredMode, "inputHash": "suite-hash", "requestedCount": 1, "productBudgetMs": ai.RequestTimeout.Milliseconds(), "results": results}
}
func saveCheckpoint(t *testing.T, report any) string {
	t.Helper()
	raw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "report.json")
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}
func checkpointRow(task string) Result {
	base, _, _ := strings.Cut(task, "/")
	return Result{CaseID: "case", Task: task, SkillVersion: ai.Skills[ai.Kind(base)].Version, InputHash: "case-hash", Failures: []string{}, DurationMs: 123, ProductDurationMs: 123}
}

func TestCheckpointMetadataMustMatch(t *testing.T) {
	cfg := checkpointConfig()
	mismatches := map[string]any{"checkpointVersion": 2, "binarySHA256": strings.Repeat("0", 64), "judgeEnabled": true, "model": "other/model", "productionQualityReview": false, "productionReviewModel": "other/reviewer", "reasoningEffort": "low", "providerOrder": []string{"together"}, "structuredMode": "function", "inputHash": "other-suite", "requestedCount": 2, "productBudgetMs": 300000}
	for key, value := range mismatches {
		t.Run(key, func(t *testing.T) {
			r := checkpointReport(cfg)
			r[key] = value
			if _, err := loadProductCheckpoints(saveCheckpoint(t, r), cfg, "suite-hash", 1); err == nil || !strings.Contains(err.Error(), key) {
				t.Fatalf("mismatch %s accepted or unclear: %v", key, err)
			}
		})
	}
	for key := range checkpointReport(cfg) {
		for _, null := range []bool{false, true} {
			t.Run(key+map[bool]string{false: "-missing", true: "-null"}[null], func(t *testing.T) {
				r := checkpointReport(cfg)
				if null {
					r[key] = nil
				} else {
					delete(r, key)
				}
				if _, err := loadProductCheckpoints(saveCheckpoint(t, r), cfg, "suite-hash", 1); err == nil {
					t.Fatalf("required %s accepted when missing/null", key)
				}
			})
		}
	}
	// Routing order is meaningful, not a set of interchangeable providers.
	cfg.OpenRouterProviderOrder = []string{"openai/fast", "amazon-bedrock/us-east-1"}
	r := checkpointReport(cfg)
	r["providerOrder"] = []string{"amazon-bedrock/us-east-1", "openai/fast"}
	if _, err := loadProductCheckpoints(saveCheckpoint(t, r), cfg, "suite-hash", 1); err == nil {
		t.Fatal("reordered providers accepted")
	}
	// An explicitly empty provider order is valid for an unpinned configuration.
	cfg.OpenRouterProviderOrder = nil
	r = checkpointReport(cfg)
	r["providerOrder"] = []string{}
	if _, err := loadProductCheckpoints(saveCheckpoint(t, r), cfg, "suite-hash", 1); err != nil {
		t.Fatalf("explicit empty provider order rejected: %v", err)
	}
}

func TestCheckpointRetainsProductsAndQualityRefusalsOnlyRetriesInfrastructure(t *testing.T) {
	cfg := checkpointConfig()
	graded := checkpointRow("grade/correct")
	graded.Output = planner.GradeResult{Score: 100, Feedback: "구체적인 설명입니다.", Matched: []string{"개념"}, Missing: []string{}}
	graded.Failures = []string{"known evaluator failure stays in denominator"}
	cost := 0.003
	graded.Usage = []ai.Usage{{Model: cfg.OpenRouterModel, Provider: "OpenAI", Cost: &cost, DurationMs: 120, Task: "memoryz_grade"}}
	graded.Retries = []ai.Retry{{Kind: "grade", Reason: "preserved reason"}}
	refused := checkpointRow("essay")
	refused.Error = "422 quality refusal: unsupported explanation"
	malformed := checkpointRow("quiz")
	malformed.Error = "502 generated output invalid"
	timeout := checkpointRow("cards")
	timeout.InfrastructureError = true
	timeout.Error = "504 timeout"
	path := saveCheckpoint(t, checkpointReport(cfg, graded, refused, malformed, timeout))
	before, _ := os.ReadFile(path)
	got, err := loadProductCheckpoints(path, cfg, "suite-hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("kept %d, want all 3 terminal outcomes", len(got))
	}
	if _, exists := got["case--cards"]; exists {
		t.Fatal("infrastructure failure was not left for retry")
	}
	for _, want := range []Result{graded, refused, malformed} {
		// Compare JSON because decoding any Output intentionally yields a map.
		w, _ := json.Marshal(want)
		g, _ := json.Marshal(got[want.CaseID+"--"+want.Task])
		var wo, goValue any
		_ = json.Unmarshal(w, &wo)
		_ = json.Unmarshal(g, &goValue)
		if !reflect.DeepEqual(wo, goValue) {
			t.Fatalf("terminal evidence changed: got %s, want %s", g, w)
		}
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("loader modified original evidence")
	}
}

func TestCheckpointRejectsDuplicateAndStaleResults(t *testing.T) {
	cfg := checkpointConfig()
	row := checkpointRow("quiz")
	row.Error = "422 refused"
	for _, infra := range []bool{false, true} {
		duplicate := row
		duplicate.InfrastructureError = infra
		if _, err := loadProductCheckpoints(saveCheckpoint(t, checkpointReport(cfg, duplicate, row)), cfg, "suite-hash", 1); err == nil || !strings.Contains(err.Error(), "duplicate") {
			t.Fatalf("duplicate accepted (infrastructure=%t): %v", infra, err)
		}
	}
	for _, mutate := range []func(*Result){
		func(r *Result) { r.SkillVersion = "stale" }, func(r *Result) { r.Task = "unknown" }, func(r *Result) { r.CaseID = " " }, func(r *Result) { r.Task = "grade/" }, func(r *Result) { r.Task = "quiz/answer" }, func(r *Result) { r.Judge = &Judgment{} },
	} {
		bad := row
		mutate(&bad)
		if _, err := loadProductCheckpoints(saveCheckpoint(t, checkpointReport(cfg, bad)), cfg, "suite-hash", 1); err == nil {
			t.Fatalf("bad row accepted: %+v", bad)
		}
	}
	// Check stale skills even for an infrastructure row that will be retried.
	row.InfrastructureError = true
	row.SkillVersion = "stale"
	if _, err := loadProductCheckpoints(saveCheckpoint(t, checkpointReport(cfg, row)), cfg, "suite-hash", 1); err == nil {
		t.Fatal("stale infrastructure checkpoint accepted")
	}
}

func TestCheckpointRequiresUsableOutputOrExplicitError(t *testing.T) {
	cfg := checkpointConfig()
	for _, output := range []any{nil, map[string]any{}, []any{}, "text", ai.Items{}, map[string]any{"Questions": []any{nil}}} {
		r := checkpointRow("quiz")
		r.Output = output
		if _, err := loadProductCheckpoints(saveCheckpoint(t, checkpointReport(cfg, r)), cfg, "suite-hash", 1); err == nil {
			t.Fatalf("unusable output accepted: %#v", output)
		}
	}
	for _, output := range []any{map[string]any{"feedback": "missing score"}, map[string]any{"score": nil, "feedback": "null score"}, map[string]any{"score": 101, "feedback": "bad score"}} {
		r := checkpointRow("grade/correct")
		r.Output = output
		if _, err := loadProductCheckpoints(saveCheckpoint(t, checkpointReport(cfg, r)), cfg, "suite-hash", 1); err == nil {
			t.Fatalf("unusable grade accepted: %#v", output)
		}
	}
	products := map[string]any{
		"quiz":            ai.Items{Questions: []ai.QuestionItem{{Prompt: "Which?", Options: []string{"A", "B", "C", "D", "E"}, Answer: 0, Explanation: "Because the source says so.", Citation: "Source evidence."}}},
		"essay":           ai.Items{Essays: []ai.EssayItem{{Prompt: "Explain.", ModelAnswer: "Explanation.", Citation: "Source evidence."}}},
		"cards":           ai.Items{Cards: []ai.CardItem{{Front: "What?", Back: "Answer.", Citation: "Source evidence."}}},
		"grade/incorrect": planner.GradeResult{Score: 0, Feedback: "정답과 다른 이유를 설명합니다."},
	}
	for task, output := range products {
		r := checkpointRow(task)
		r.Output = output
		if got, err := loadProductCheckpoints(saveCheckpoint(t, checkpointReport(cfg, r)), cfg, "suite-hash", 1); err != nil || len(got) != 1 {
			t.Fatalf("usable %s rejected: %v", task, err)
		}
	}
}

func TestCheckpointEmptyAndInvalidReports(t *testing.T) {
	cfg := checkpointConfig()
	if got, err := loadProductCheckpoints(saveCheckpoint(t, checkpointReport(cfg)), cfg, "suite-hash", 1); err != nil || len(got) != 0 {
		t.Fatalf("empty initial checkpoint: %v", err)
	}
	path := filepath.Join(t.TempDir(), "report.json")
	if _, err := loadProductCheckpoints(path, cfg, "suite-hash", 1); err == nil {
		t.Fatal("missing file accepted")
	}
	if err := os.WriteFile(path, []byte(`{"checkpointVersion":`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadProductCheckpoints(path, cfg, "suite-hash", 1); err == nil {
		t.Fatal("partial report accepted")
	}
	if _, err := loadProductCheckpoints(path, nil, "suite-hash", 1); err == nil {
		t.Fatal("nil config accepted")
	}
	// A serialized previous reuse marker must not claim this loader already reused it.
	r := checkpointRow("quiz")
	r.Error = "422 refusal"
	b, _ := json.Marshal(r)
	var fields map[string]any
	_ = json.Unmarshal(b, &fields)
	fields["checkpointReused"] = true
	report := checkpointReport(cfg)
	report["results"] = []any{fields}
	got, err := loadProductCheckpoints(saveCheckpoint(t, report), cfg, "suite-hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	b, _ = json.Marshal(got["case--quiz"])
	var saved map[string]any
	_ = json.Unmarshal(b, &saved)
	if saved["checkpointReused"] == true {
		t.Fatal("loader retained prior reuse marker")
	}
}
