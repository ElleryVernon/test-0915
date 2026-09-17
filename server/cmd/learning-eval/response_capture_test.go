package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"memoryz/server/internal/ai"
	"memoryz/server/internal/planner"
)

func TestResponseCaptureCLIOptInOnly(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(strconv.FormatBool(enabled), func(t *testing.T) {
			_, _, casesPath, _ := resumeFixture(t)
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("X-Private-Header", "PRIVATE_HEADER_VALUE")
				writeFakeCompletion(w, map[string]any{"score": 100, "matched": []string{"Vmax"}, "missing": []string{}, "feedback": "최대 속도는 변하지 않는다는 설명이 정확합니다.", "privateDiagnostics": "CAPTURE_ONLY_MARKER"}, 0.001)
			}))
			defer srv.Close()
			out := filepath.Join(t.TempDir(), "captured")
			args := []string{"--allow-live", "--cases", casesPath, "--tasks", "grade", "--answers", "correct", "--count", "1", "--judge=false", "--out", out}
			if enabled {
				args = append(args, "--capture-responses")
			}
			console, exit := runnerCLI(t, srv.URL, args...)
			if exit != 0 || calls.Load() != 1 {
				t.Fatalf("local opt-in runner failed: calls=%d exit=%d %s", calls.Load(), exit, console)
			}
			b, err := os.ReadFile(filepath.Join(out, "report.json"))
			if err != nil {
				t.Fatal(err)
			}
			var report struct {
				CaptureResponses bool                         `json:"captureResponses"`
				BinarySHA256     string                       `json:"binarySHA256"`
				InputHash        string                       `json:"inputHash"`
				Results          []map[string]json.RawMessage `json:"results"`
			}
			if json.Unmarshal(b, &report) != nil || report.CaptureResponses != enabled || len(report.Results) != 1 || report.BinarySHA256 == "" || report.InputHash == "" {
				t.Fatal("capture/input/binary metadata missing", string(b))
			}
			value, present := report.Results[0]["modelResponses"]
			if present != enabled || strings.Contains(string(b), "CAPTURE_ONLY_MARKER") != enabled {
				t.Fatal("default exposure or opt-in data loss", string(b))
			}
			if enabled {
				var responses []ai.ModelResponse
				if json.Unmarshal(value, &responses) != nil || len(responses) != 1 || responses[0].Task != "memoryz_essay_grade" {
					t.Fatal("wrong captured calls", string(value))
				}
			}
			for _, secret := range []string{"CAPTURE_ONLY_MARKER", "local-test-key", "PRIVATE_HEADER_VALUE"} {
				if strings.Contains(console, secret) {
					t.Fatal("capture leaked to console", secret)
				}
			}
			for _, secret := range []string{"local-test-key", "PRIVATE_HEADER_VALUE", "Authorization"} {
				if strings.Contains(string(b), secret) {
					t.Fatal("request headers captured", secret)
				}
			}
			row, err := os.ReadFile(filepath.Join(out, "resume-case--grade_correct.json"))
			if err != nil || strings.Contains(string(row), "modelResponses") != enabled {
				t.Fatal("per-task opt-in differs from report", err)
			}
		})
	}
}

func TestResponseCaptureCLIRejectsMismatchedResumeBeforeCalls(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(strconv.FormatBool(enabled), func(t *testing.T) {
			cfg, _, casesPath, inputHash := resumeFixture(t)
			report := checkpointReport(cfg)
			report["inputHash"], report["captureResponses"] = inputHash, !enabled
			saved := saveCheckpoint(t, report)
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
			defer srv.Close()
			out := filepath.Join(t.TempDir(), "mismatch")
			args := []string{"--allow-live", "--cases", casesPath, "--tasks", "grade", "--count", "1", "--judge=false", "--resume-products", saved, "--out", out}
			if enabled {
				args = append(args, "--capture-responses")
			}
			console, exit := runnerCLI(t, srv.URL, args...)
			if exit != 2 || calls.Load() != 0 || !strings.Contains(console, "captureResponses mismatch") {
				t.Fatalf("incompatible reuse accepted: %d %d %s", exit, calls.Load(), console)
			}
			if _, err := os.Stat(out); !os.IsNotExist(err) {
				t.Fatal("mismatch created output directory", err)
			}
		})
	}
}

func TestResponseCaptureCLICompatibleResumeKeepsOriginalEvidence(t *testing.T) {
	cfg, c, casesPath, inputHash := resumeFixture(t)
	caseJSON, _ := json.Marshal(c)
	row := checkpointRow("grade/correct")
	row.CaseID, row.InputHash = c.ID, hash(caseJSON)
	row.Error = "terminal semantic refusal"
	responses := []ai.ModelResponse{{Task: "memoryz_essay_grade_review", DecodedJSON: json.RawMessage(`{"valid":false,"issues":["original diagnostic"]}`)}}
	row.ModelResponses = &responses
	report := checkpointReport(cfg, row)
	report["inputHash"], report["captureResponses"] = inputHash, true
	saved := saveCheckpoint(t, report)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer srv.Close()
	out := filepath.Join(t.TempDir(), "resumed")
	console, exit := runnerCLI(t, srv.URL, "--allow-live", "--cases", casesPath, "--tasks", "grade", "--answers", "correct", "--count", "1", "--judge=false", "--capture-responses", "--resume-products", saved, "--out", out)
	if exit != 1 || calls.Load() != 0 {
		t.Fatalf("terminal capture regenerated: %d %d %s", exit, calls.Load(), console)
	}
	b, err := os.ReadFile(filepath.Join(out, "report.json"))
	if err != nil || !strings.Contains(string(b), "original diagnostic") || !strings.Contains(string(b), `"checkpointReused": true`) {
		t.Fatal("original diagnostic was lost", err, string(b))
	}
}

func TestResponseCaptureMetadataShapeAndRejudging(t *testing.T) {
	for _, metadata := range []any{nil, "true", 1} {
		path := saveCheckpoint(t, map[string]any{"captureResponses": metadata, "results": []any{}})
		if validateCaptureResume(path, false) == nil {
			t.Fatal("invalid capture metadata accepted", metadata)
		}
	}
	for _, responses := range []any{nil, "bad", []any{1}, []any{map[string]any{}, map[string]any{}, map[string]any{}, map[string]any{}, map[string]any{}}} {
		path := saveCheckpoint(t, map[string]any{"captureResponses": true, "results": []any{map[string]any{"modelResponses": responses}}})
		if validateCaptureResume(path, true) == nil {
			t.Fatal("invalid capture rows accepted", responses)
		}
	}
	legacy := saveCheckpoint(t, map[string]any{"results": []any{}})
	if validateCaptureResume(legacy, false) != nil || validateCaptureResume(legacy, true) == nil {
		t.Fatal("legacy disabled capture compatibility lost")
	}
	for _, row := range []map[string]any{{}, {"modelResponses": []any{}}} {
		path := saveCheckpoint(t, map[string]any{"captureResponses": len(row) == 0, "results": []any{row}})
		if validateCaptureResume(path, len(row) == 0) == nil {
			t.Fatal("row capture presence disagrees with report but accepted")
		}
	}
	values := []ai.ModelResponse{{Task: "memoryz_essay_grade", DecodedJSON: json.RawMessage(`{"private":"original"}`)}}
	old := Result{Task: "grade/correct", ModelResponses: &values, Output: planner.GradeResult{Score: 100, Feedback: "정답입니다."}}
	c := Case{ID: "case"}
	a := Answer{ID: "correct", MinScore: 90, MaxScore: 100}
	defaultResult := run(nil, nil, c, "grade", &a, 1, false, &old)
	if defaultResult.ModelResponses != nil {
		t.Fatal("default rejudge exposed historical private responses")
	}
	captured := runWithResponseCapture(nil, nil, c, "grade", &a, 1, false, &old, true)
	if captured.ModelResponses == nil || len(*captured.ModelResponses) != 1 {
		t.Fatal("opt-in rejudge discarded original response")
	}
	(*captured.ModelResponses)[0].DecodedJSON[0] = '!'
	if !json.Valid(values[0].DecodedJSON) {
		t.Fatal("rejudged evidence aliases original bytes")
	}
}

func TestResponseCaptureFailedRequestHasEmptyResponses(t *testing.T) {
	_, _, casesPath, _ := resumeFixture(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTooManyRequests) }))
	defer srv.Close()
	out := filepath.Join(t.TempDir(), "failed")
	_, exit := runnerCLI(t, srv.URL, "--allow-live", "--cases", casesPath, "--tasks", "grade", "--answers", "correct", "--count", "1", "--judge=false", "--capture-responses", "--out", out)
	b, err := os.ReadFile(filepath.Join(out, "report.json"))
	if err != nil || exit != 1 || !strings.Contains(string(b), `"modelResponses": []`) || !strings.Contains(string(b), `"infrastructureError": true`) {
		t.Fatal("request failure masquerades as a model response", exit, err, string(b))
	}
}
