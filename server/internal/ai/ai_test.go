package ai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/config"
)

func testProvider(t *testing.T, handler http.HandlerFunc) *Provider {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	cfg := &config.Config{OpenRouterAPIKey: "test-key", OpenRouterModel: "openai/gpt-5.6-luna", OpenRouterEffort: "high", OpenRouterProviderOrder: []string{"openai/fast", "amazon-bedrock/us-east-1"}}
	return NewProvider(cfg, srv.URL, slog.Default())
}

func TestStrictSchema(t *testing.T) {
	schema := object(map[string]any{"a": str(1, 5), "b": map[string]any{"type": "integer"}}, "a")
	schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
	strict := strictSchema(schema)
	if _, ok := strict["$schema"]; ok {
		t.Fatal("$schema must be dropped")
	}
	required, _ := strict["required"].([]any)
	if len(required) != 2 || strict["additionalProperties"] != false {
		t.Fatalf("every property becomes required and extras are refused: %v", strict)
	}
	props := strict["properties"].(map[string]any)
	if _, nullable := props["b"].(map[string]any)["anyOf"]; !nullable {
		t.Fatalf("an optional property becomes nullable: %v", props["b"])
	}
	if _, plain := props["a"].(map[string]any)["anyOf"]; plain {
		t.Fatal("a required property stays as it was")
	}
	if schema["$schema"] == nil {
		t.Fatal("the caller's schema must not be mutated")
	}
}

func TestProviderJSON(t *testing.T) {
	var lastBody map[string]any
	p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &lastBody)
		if r.Header.Get("Authorization") != "Bearer test-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.Header.Get("X-Test") {
		case "content":
			_, _ = io.WriteString(w, `{"choices":[{"finish_reason":"stop","message":{"content":"{\"text\":\"from content\"}"}}]}`)
		case "402":
			w.WriteHeader(http.StatusPaymentRequired)
		case "429":
			w.WriteHeader(http.StatusTooManyRequests)
		case "500":
			w.WriteHeader(http.StatusInternalServerError)
		case "length":
			_, _ = io.WriteString(w, `{"choices":[{"finish_reason":"length","message":{"content":"{}"}}]}`)
		case "refusal":
			_, _ = io.WriteString(w, `{"choices":[{"finish_reason":"stop","message":{"refusal":"no"}}]}`)
		case "garbage":
			_, _ = io.WriteString(w, `{"choices":[{"finish_reason":"stop","message":{"content":"not json"}}]}`)
		default:
			_, _ = io.WriteString(w, `{"id":"gen-1","model":"openai/gpt-5.6-luna","provider":"Amazon Bedrock","choices":[{"finish_reason":"stop","message":{"tool_calls":[{"function":{"name":"memoryz_ocr","arguments":"{\"text\":\"hello\"}"}}]}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}`)
		}
	})
	// The forced function call is the normal path.
	p.client.Transport = headerTransport{"X-Test": ""}
	value, err := p.JSON(context.Background(), "prompt", object(map[string]any{"text": str(0, 10)}, "text"), "memoryz_ocr", nil)
	if err != nil || value.(map[string]any)["text"] != "hello" {
		t.Fatalf("tool call result: %v %v", value, err)
	}
	tools := lastBody["tools"].([]any)[0].(map[string]any)["function"].(map[string]any)
	if tools["name"] != "memoryz_ocr" || tools["strict"] != true || lastBody["tool_choice"].(map[string]any)["function"].(map[string]any)["name"] != "memoryz_ocr" {
		t.Fatalf("request forces the function: %v", lastBody)
	}
	if order := lastBody["provider"].(map[string]any)["order"].([]any); len(order) != 2 || lastBody["provider"].(map[string]any)["allow_fallbacks"] != false {
		t.Fatalf("provider routing: %v", lastBody["provider"])
	}
	for header, want := range map[string]int{"content": 0, "402": 503, "429": 429, "500": 502, "length": 502, "refusal": 422, "garbage": 502} {
		p.client.Transport = headerTransport{"X-Test": header}
		value, err := p.JSON(context.Background(), "prompt", object(map[string]any{"text": str(0, 10)}, "text"), "memoryz_ocr", nil)
		if want == 0 {
			if err != nil || value.(map[string]any)["text"] != "from content" {
				t.Fatalf("%s: %v %v", header, value, err)
			}
			continue
		}
		var e *apierr.Error
		if !errors.As(err, &e) || e.Status != want {
			t.Fatalf("%s: want %d, got %v", header, want, err)
		}
	}
	unavailable := NewProvider(&config.Config{}, "", slog.Default())
	if _, err := unavailable.JSON(context.Background(), "p", object(nil), "x", nil); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("no key: %v", err)
	}
}

type headerTransport map[string]string

func (h headerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	for k, v := range h {
		r.Header.Set(k, v)
	}
	return http.DefaultTransport.RoundTrip(r)
}

func TestParseItems(t *testing.T) {
	source := "나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다. 칼륨 이온이 세포 밖으로 나가면 재분극이 일어난다."
	good := map[string]any{"items": []any{map[string]any{"prompt": "탈분극을 일으키는 이온은?", "options": []any{"a", "b", "c", "d", "e"}, "answer": 0, "explanation": "나트륨 이온이 유입됩니다.", "citation": "나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.", "past": "세포막", "future": "막전위"}}}
	items, err := parseItems(good, KindQuiz, 1, source)
	if err != nil || len(items.Questions) != 1 {
		t.Fatalf("valid quiz: %v", err)
	}
	status := func(raw map[string]any, mode Kind, count int) int {
		_, err := parseItems(raw, mode, count, source)
		var e *apierr.Error
		if errors.As(err, &e) {
			return e.Status
		}
		return 0
	}
	if status(good, KindQuiz, 2) != 502 {
		t.Fatal("wrong count is a shape error")
	}
	bad := map[string]any{"items": []any{map[string]any{"prompt": "탈분극을 일으키는 이온은?", "options": []any{"a", "a", "c", "d", "e"}, "answer": 0, "explanation": "나트륨 이온이 유입됩니다.", "citation": "나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.", "past": "세포막", "future": "막전위"}}}
	if status(bad, KindQuiz, 1) != 422 {
		t.Fatal("duplicate options are refused")
	}
	fake := map[string]any{"items": []any{map[string]any{"prompt": "탈분극을 일으키는 이온은?", "options": []any{"a", "b", "c", "d", "e"}, "answer": 0, "explanation": "나트륨 이온이 유입됩니다.", "citation": "원문에 없는 전혀 다른 출처 문장이에요.", "past": "세포막", "future": "막전위"}}}
	if status(fake, KindQuiz, 1) != 422 {
		t.Fatal("a citation not in the source is refused")
	}
	essay := map[string]any{"items": []any{map[string]any{"prompt": "탈분극 과정을 설명하세요.", "keywords": []any{"자극", "통로", "유입", "탈분극"}, "distractors": []any{"항체", "호르몬", "광합성", "자극"}, "modelAnswer": strings.Repeat("설명 ", 10), "citation": "칼륨 이온이 세포 밖으로 나가면 재분극이 일어난다."}}}
	if status(essay, KindEssay, 1) != 422 {
		t.Fatal("overlapping keywords are refused")
	}
	card := map[string]any{"items": []any{map[string]any{"front": "뉴런", "back": "단위", "type": "BLIND", "citation": "칼륨 이온이 세포 밖으로 나가면 재분극이 일어난다."}}}
	if status(card, KindCards, 1) != 502 {
		t.Fatal("an unknown card type is a shape error")
	}
}

func TestRuntimeStages(t *testing.T) {
	rt := NewRuntime(KindGrade, nil)
	if _, err := Tool(context.Background(), rt, "GENERATE", func(context.Context) (int, error) { return 1, nil }); !errors.Is(err, errStage) {
		t.Fatalf("stages must run in order: %v", err)
	}
	ctx := WithRuntime(context.Background(), rt)
	out, err := Rule(ctx, KindGrade, func() (string, error) { return "graded", nil })
	if err != nil || out != "graded" {
		t.Fatalf("rule: %v %v", out, err)
	}
	stages := []string{}
	for _, s := range rt.Steps {
		stages = append(stages, s.Stage+":"+s.Status)
	}
	if strings.Join(stages, ",") != "LOAD_CONTEXT:COMPLETED,GENERATE:COMPLETED,VALIDATE:COMPLETED" {
		t.Fatalf("recorded stages: %v", stages)
	}
	if _, err := Rule(ctx, KindPlanner, func() (string, error) { return "", nil }); !errors.Is(err, errSkillMatch) {
		t.Fatalf("a runtime of another kind is refused: %v", err)
	}
}
