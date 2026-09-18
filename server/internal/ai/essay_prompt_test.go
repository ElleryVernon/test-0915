package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// Verify the actual outbound contract, including the non-quality legacy path.
// These checks prevent contradictory field instructions; they do not certify
// scientific quality, which is measured separately with frozen source cases.
func TestEssayPromptMatchesActiveSchema(t *testing.T) {
	for _, quality := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy", true: "grounded"}[quality], func(t *testing.T) {
			var prompt string
			var properties map[string]any
			p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
				var request map[string]any
				_ = json.NewDecoder(r.Body).Decode(&request)
				prompt = request["messages"].([]any)[1].(map[string]any)["content"].(string)
				function := request["tools"].([]any)[0].(map[string]any)["function"].(map[string]any)
				properties = function["parameters"].(map[string]any)["properties"].(map[string]any)["items"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)
				w.WriteHeader(http.StatusTooManyRequests)
			})
			p.cfg.AIQualityReview = quality
			source := "실제 자료의 본문과 조건을 온전하게 보존해야 하는 테스트 문장입니다."
			_, err := GenerateItemsForTopic(context.Background(), p, source, KindEssay, 2, "학습 주제")
			if err == nil || !strings.Contains(prompt, source) || !strings.Contains(prompt, "학습 주제") {
				t.Fatal("request not inspected", err)
			}
			for _, field := range []string{"modelAnswer", "keywords", "citation"} {
				_, inSchema := properties[field]
				if quality && (inSchema || strings.Contains(prompt, field+":")) {
					t.Fatalf("legacy output instruction survived for %s", field)
				}
				if !quality && !inSchema {
					t.Fatalf("legacy schema lost %s", field)
				}
			}
			if quality {
				for _, field := range []string{"annotatedAnswer", "citationIds"} {
					if properties[field] == nil || !strings.Contains(prompt, field+":") {
						t.Fatalf("prompt/schema mismatch: %s", field)
					}
				}
				if !strings.HasSuffix(prompt, "</source>") {
					t.Fatal("instructions appended after variable source")
				}
			}
		})
	}
}
