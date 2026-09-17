package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func TestResponseCaptureOptInProviderAndFailureSeparation(t *testing.T) {
	for _, mode := range []string{"json_schema", "tools"} {
		t.Run(mode, func(t *testing.T) {
			var logs bytes.Buffer
			p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer test-key" {
					http.Error(w, "missing fake key", http.StatusUnauthorized)
					return
				}
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				prompt := body["messages"].([]any)[1].(map[string]any)["content"].(string)
				if prompt == "PRIVATE_PROMPT_failure" {
					w.WriteHeader(http.StatusTooManyRequests)
					return
				}
				w.Header().Set("X-Private-Header", "PRIVATE_HEADER_VALUE")
				if prompt == "PRIVATE_PROMPT_bad_json" {
					_, _ = io.WriteString(w, `{"choices":[{"finish_reason":"stop","message":{"content":"not JSON"}}]}`)
					return
				}
				if prompt == "PRIVATE_PROMPT_refusal" {
					_, _ = io.WriteString(w, `{"choices":[{"finish_reason":"stop","message":{"refusal":"no"}}]}`)
					return
				}
				var task string
				if mode == "tools" {
					task = body["tools"].([]any)[0].(map[string]any)["function"].(map[string]any)["name"].(string)
				} else {
					task = body["response_format"].(map[string]any)["json_schema"].(map[string]any)["name"].(string)
				}
				payload := `{"marker":"PRIVATE_RESPONSE_VALUE","valid":false,"issues":["semantic refusal remains captured"]}`
				message := map[string]any{"content": payload}
				if mode == "tools" {
					message = map[string]any{"tool_calls": []any{map[string]any{"function": map[string]any{"name": task, "arguments": payload}}}}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"id": "PRIVATE_ENVELOPE_ID", "choices": []any{map[string]any{"finish_reason": "stop", "message": message}}})
			})
			p.cfg.OpenRouterStructuredMode = mode
			p.log = slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelWarn}))
			ctx, capture := CaptureResponses(context.Background())
			// Merely creating another collector must not enable global capture.
			_, err := p.JSON(context.Background(), "PRIVATE_PROMPT_default", object(map[string]any{}), "memoryz_essay_grade", nil)
			if err != nil || len(capture.Responses()) != 0 || responseRecorder(context.Background(), "memoryz_essay_grade") != nil {
				t.Fatal("default call exposed a response", err)
			}
			for _, step := range []struct {
				task, prompt string
				failed       bool
			}{
				{"memoryz_essay_grade", "PRIVATE_PROMPT_grade", false},
				{"memoryz_essay_grade_review", "PRIVATE_PROMPT_review", false},
				{"memoryz_essay", "PRIVATE_PROMPT_generation", false},
				{"memoryz_ocr", "PRIVATE_PROMPT_ocr", false},
				{"memoryz_essay_grade", "PRIVATE_PROMPT_failure", true},
				{"memoryz_essay_grade", "PRIVATE_PROMPT_bad_json", true},
				{"memoryz_essay_grade_review", "PRIVATE_PROMPT_refusal", true},
			} {
				value, err := p.JSON(ctx, step.prompt, object(map[string]any{}), step.task, nil)
				if (err != nil) != step.failed {
					t.Fatal("unexpected local call result", step.prompt, err)
				}
				if value != nil {
					value.(map[string]any)["marker"] = "MUTATED_CALLER_VALUE"
				}
			}
			rows := capture.Responses()
			if len(rows) != 2 || rows[0].Task != "memoryz_essay_grade" || rows[1].Task != "memoryz_essay_grade_review" {
				t.Fatal("generation, transport failure or malformed response captured", rows)
			}
			encoded, _ := json.Marshal(rows)
			for _, secret := range []string{"PRIVATE_PROMPT", "test-key", "Authorization", "PRIVATE_HEADER_VALUE", "PRIVATE_ENVELOPE_ID", "MUTATED_CALLER_VALUE"} {
				if strings.Contains(string(encoded), secret) || strings.Contains(logs.String(), secret) {
					t.Fatal("capture or log retained request/envelope data", secret)
				}
			}
			if !strings.Contains(string(encoded), "PRIVATE_RESPONSE_VALUE") || strings.Contains(logs.String(), "PRIVATE_RESPONSE_VALUE") {
				t.Fatal("response capture leaked into ordinary logs or was lost")
			}
			var fields []map[string]any
			_ = json.Unmarshal(encoded, &fields)
			for _, row := range fields {
				if len(row) != 2 || row["task"] == nil || row["decodedJSON"] == nil {
					t.Fatal("capture contains fields beyond task and decoded JSON", row)
				}
			}
		})
	}
}

func TestResponseCaptureConcurrentOrderLimitAndDetachedSnapshots(t *testing.T) {
	ctx, collector := CaptureResponses(context.Background())
	recorders := make([]func(any), 24)
	for i := range recorders {
		recorders[i] = responseRecorder(ctx, "memoryz_essay_grade")
	}
	// Completion order differs from request order. Concurrent snapshots must
	// still be detached, valid and bounded while earlier requests finish later.
	var wg sync.WaitGroup
	for i := len(recorders) - 1; i >= 4; i-- {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			recorders[i](map[string]any{"request": i, "nested": map[string]any{"value": "original"}})
			rows := collector.Responses()
			if len(rows) > 4 {
				t.Error("capture exceeded four responses")
			}
			for _, row := range rows {
				if !json.Valid(row.DecodedJSON) {
					t.Error("concurrent snapshot corrupted")
				}
			}
		}(i)
	}
	wg.Wait()
	// The earliest requests finish last, after the collector already hit its
	// limit. They must replace later completions rather than be discarded.
	for i := 3; i >= 0; i-- {
		recorders[i](map[string]any{"request": i})
	}
	rows := collector.Responses()
	if len(rows) != 4 {
		t.Fatal("wrong capture bound", len(rows))
	}
	for i, row := range rows {
		var value struct {
			Request int `json:"request"`
		}
		if json.Unmarshal(row.DecodedJSON, &value) != nil || value.Request != i {
			t.Fatal("request order lost", i, string(row.DecodedJSON))
		}
	}
	rows[0].DecodedJSON[0] = '!'
	if !json.Valid(collector.Responses()[0].DecodedJSON) {
		t.Fatal("snapshot mutation changed stored evidence")
	}
	_, isolated := CaptureResponses(ctx)
	if len(isolated.Responses()) != 0 || len(collector.Responses()) != 4 {
		t.Fatal("per-answer collectors share state")
	}
}

func TestResponseCaptureProviderMaxFour(t *testing.T) {
	p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"choices":[{"finish_reason":"stop","message":{"content":"{\"value\":1}"}}]}`)
	})
	ctx, collector := CaptureResponses(context.Background())
	for i := range 7 {
		if _, err := p.JSON(ctx, strconv.Itoa(i), object(map[string]any{}), "memoryz_essay_grade", nil); err != nil {
			t.Fatal(err)
		}
	}
	if len(collector.Responses()) != 4 {
		t.Fatal("provider integration did not enforce maximum")
	}
}
