package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"memoryz/server/internal/apierr"
)

func qualityItem(index int, good bool) map[string]any {
	return map[string]any{"index": index, "supported": good, "answersQuestion": good, "unambiguous": good, "usableWithoutMissingVisual": good, "issues": []any{}}
}

func TestQualityModelUsesSharedBudgetAndDoesNotMutateGenerator(t *testing.T) {
	p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["model"] != "openai/reviewer" {
			t.Fatalf("wrong review model: %v", body["model"])
		}
		io.WriteString(w, `{"choices":[{"finish_reason":"stop","message":{"tool_calls":[{"function":{"name":"memoryz_learning_quality","arguments":"{\"items\":[{\"index\":0,\"supported\":true,\"answersQuestion\":true,\"unambiguous\":true,\"usableWithoutMissingVisual\":true,\"issues\":[] }]}"}}]}}]}`)
	})
	original := p.Model()
	if p.qualityReviewer() != p {
		t.Fatal("unset override changed provider")
	}
	p.cfg.OpenRouterQualityModel = "openai/reviewer"
	reviewer := p.qualityReviewer()
	if reviewer.slots != p.slots || reviewer.client != p.client {
		t.Fatal("reviewer bypassed shared admission budget")
	}
	if issues, err := reviewItems(context.Background(), p, "source", KindCards, 1, map[string]any{}); err != nil || issues != "" {
		t.Fatal(issues, err)
	}
	if p.Model() != original {
		t.Fatal("generator model mutated")
	}
}
func TestSemanticReviewFailsClosed(t *testing.T) {
	positive := map[string]any{"items": []any{qualityItem(0, true), qualityItem(1, true)}}
	if issues, err := qualityProblems(positive, 2); err != nil || issues != "" {
		t.Fatalf("positive: %q %v", issues, err)
	}
	for name, raw := range map[string]any{"omitted": map[string]any{"items": []any{qualityItem(0, true)}}, "duplicate": map[string]any{"items": []any{qualityItem(0, true), qualityItem(0, true)}}, "wrong-index": map[string]any{"items": []any{qualityItem(0, true), qualityItem(2, true)}}, "malformed": map[string]any{"items": "fine"}} {
		t.Run(name, func(t *testing.T) {
			if _, err := qualityProblems(raw, 2); !errors.Is(err, errSemanticQuality) {
				t.Fatal("missing coverage accepted", err)
			}
		})
	}
	for _, field := range []string{"supported", "answersQuestion", "unambiguous", "usableWithoutMissingVisual"} {
		t.Run(field, func(t *testing.T) {
			bad := qualityItem(0, true)
			bad[field] = false
			issues, err := qualityProblems(map[string]any{"items": []any{bad}}, 1)
			if err != nil || issues == "" {
				t.Fatalf("unsupported item accepted: %q %v", issues, err)
			}
		})
	}
}

func TestEssayAnswerAgreementRequiresActualQuestionAndAnswerEvidence(t *testing.T) {
	candidate := map[string]any{"items": []any{map[string]any{
		"prompt":      "A와 B 중 우세한 반응을 각각 비교하세요.",
		"modelAnswer": "A에서 X가 가능하고 B에서는 Y가 우세합니다.",
	}}}
	makeReview := func() map[string]any {
		return map[string]any{"items": []any{map[string]any{"index": 0, "requirements": []any{
			map[string]any{"requestQuote": "우세한 반응", "answerQuote": "A에서 X가 가능하고", "fulfilled": false, "reason": "가능하다는 설명만으로 우세한 반응에 답하지 않았습니다."},
		}}}}
	}
	if issues, err := essayAnswerAgreement(makeReview(), candidate, 1); err != nil || !strings.Contains(issues, "가능하다는") {
		t.Fatalf("unfulfilled requirement escaped: %q %v", issues, err)
	}
	for _, tc := range []struct {
		name, key string
		value     any
	}{
		{"invented-question", "requestQuote", "반응 속도를 구하세요"},
		{"invented-answer", "answerQuote", "A에서 X가 우세합니다"},
		{"missing-answer", "answerQuote", nil},
		{"null-verdict", "fulfilled", nil},
		{"empty-reason", "reason", " "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			x := makeReview()
			r := x["items"].([]any)[0].(map[string]any)["requirements"].([]any)[0].(map[string]any)
			r[tc.key] = tc.value
			if _, err := essayAnswerAgreement(x, candidate, 1); !errors.Is(err, errSemanticQuality) {
				t.Fatal("bad evidence accepted", err)
			}
		})
	}
	x := makeReview()
	r := x["items"].([]any)[0].(map[string]any)["requirements"].([]any)[0].(map[string]any)
	r["fulfilled"], r["answerQuote"] = true, "B에서는 Y가 우세합니다."
	if issues, err := essayAnswerAgreement(x, candidate, 1); err != nil || issues != "" {
		t.Fatal(issues, err)
	}
	r["answerQuote"] = ""
	if _, err := essayAnswerAgreement(x, candidate, 1); !errors.Is(err, errSemanticQuality) {
		t.Fatal("unsubstantiated pass accepted", err)
	}
	r["fulfilled"] = false
	if issues, err := essayAnswerAgreement(x, candidate, 1); err != nil || issues == "" {
		t.Fatal("missing answer should remain actionable", issues, err)
	}
	delete(x["items"].([]any)[0].(map[string]any), "requirements")
	if _, err := essayAnswerAgreement(x, candidate, 1); !errors.Is(err, errSemanticQuality) {
		t.Fatal("missing requirements accepted", err)
	}
}
func TestSemanticRegenerationRequiresFreshApproval(t *testing.T) {
	card := map[string]any{"items": []any{map[string]any{"front": "경쟁적 저해에서 Vmax는 어떻게 되는가?", "back": "충분한 기질에서 Vmax는 변하지 않는다.", "type": "CONCEPT", "citationIds": []any{"s0"}}}}
	denied := map[string]any{"items": []any{map[string]any{"index": 0, "supported": false, "answersQuestion": true, "unambiguous": true, "usableWithoutMissingVisual": true, "issues": []any{"기질 조건 누락"}}}}
	approved := map[string]any{"items": []any{qualityItem(0, true)}}
	for _, approveSecond := range []bool{false, true} {
		t.Run(map[bool]string{false: "still-invalid", true: "repaired"}[approveSecond], func(t *testing.T) {
			calls := 0
			p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				var req map[string]any
				_ = json.Unmarshal(body, &req)
				answer := any(card)
				if calls%2 == 1 {
					answer = denied
					if calls == 3 && approveSecond {
						answer = approved
					}
				}
				calls++
				args, _ := json.Marshal(answer)
				encoded, _ := json.Marshal(string(args))
				name, _ := json.Marshal(req["tool_choice"].(map[string]any)["function"].(map[string]any)["name"])
				_, _ = io.WriteString(w, `{"choices":[{"finish_reason":"stop","message":{"tool_calls":[{"function":{"name":`+string(name)+`,"arguments":`+string(encoded)+`}}]}}]}`)
			})
			p.cfg.AIQualityReview = true
			items, err := GenerateItems(context.Background(), p, "경쟁적 저해는 기질과 경쟁한다. 충분한 기질에서 Vmax는 변하지 않는다.", KindCards, 1)
			if calls != 4 {
				t.Fatalf("bounded retry calls=%d", calls)
			}
			if approveSecond {
				if err != nil || len(items.Cards) != 1 {
					t.Fatalf("repaired: %v", err)
				}
			} else if !errors.Is(err, errSemanticQuality) || len(items.Cards) > 0 {
				t.Fatalf("unverified result escaped: %v", err)
			}
		})
	}
}
func TestDetailedGradeCapsAndArithmetic(t *testing.T) {
	for _, tc := range []struct {
		kind string
		want int
	}{{"reasoned", 100}, {"keyword_list", 20}, {"central_contradiction", 25}, {"off_topic", 0}} {
		t.Run(tc.kind, func(t *testing.T) {
			raw := map[string]any{"concepts": float64(60), "reasoning": float64(25), "completeness": float64(15), "answerType": tc.kind, "matchedIndices": []any{float64(0)}, "feedback": "Vmax의 변화와 그 이유를 조건과 함께 설명해 주세요."}
			got, err := validatedDetailedGrade(raw, []string{"Vmax"})
			if err != nil || got.Score != tc.want {
				t.Fatalf("got %+v %v", got, err)
			}
			raw["concepts"] = 61.0
			if _, err = validatedDetailedGrade(raw, []string{"Vmax"}); err == nil {
				t.Fatal("out of range score accepted")
			}
		})
	}
}

func TestConfiguredXHighIsActuallySent(t *testing.T) {
	p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["reasoning"].(map[string]any)["effort"] != "xhigh" {
			t.Error("xhigh was not forwarded")
		}
		if body["max_tokens"] != float64(16384) {
			t.Error("comparison changed output-token budget")
		}
		io.WriteString(w, `{"choices":[{"finish_reason":"stop","message":{"tool_calls":[{"function":{"name":"memoryz_test","arguments":"{\"ok\":true}"}}]}}]}`)
	})
	p.cfg.OpenRouterEffort = "xhigh"
	if _, err := p.JSON(context.Background(), "test", object(map[string]any{"ok": map[string]any{"type": "boolean"}}, "ok"), "memoryz_test", nil); err != nil {
		t.Fatal(err)
	}
}

func TestJSONSchemaModeKeepsProviderPinAndValidatesJSON(t *testing.T) {
	p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["tools"] != nil || body["tool_choice"] != nil {
			t.Fatal("forced function sent to JSON endpoint")
		}
		format := body["response_format"].(map[string]any)
		if format["type"] != "json_schema" || format["json_schema"].(map[string]any)["strict"] != true {
			t.Fatal("schema weakened")
		}
		routing := body["provider"].(map[string]any)
		if routing["allow_fallbacks"] != false || routing["require_parameters"] != true || routing["order"].([]any)[0] != "baseten/fp8" {
			t.Fatal("provider pin lost")
		}
		io.WriteString(w, `{"model":"z-ai/glm-5.3-flash","provider":"BaseTen","choices":[{"finish_reason":"stop","message":{"content":"{\"ok\":true}"}}]}`)
	})
	p.cfg.OpenRouterStructuredMode = "json_schema"
	p.cfg.OpenRouterProviderOrder = []string{"baseten/fp8"}
	ctx, usage := CaptureUsage(context.Background())
	got, err := p.JSON(ctx, "test", object(map[string]any{"ok": map[string]any{"type": "boolean"}}, "ok"), "memoryz_test", nil)
	if err != nil || got.(map[string]any)["ok"] != true {
		t.Fatal(got, err)
	}
	if len(usage.Requests()) != 1 || usage.Requests()[0].Provider != "BaseTen" {
		t.Fatal("actual provider not captured")
	}
}

func TestUpstreamFailureKeepsUnknownUsageAndInfrastructureStatus(t *testing.T) {
	for _, status := range []int{429, 500, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			p := testProvider(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status) })
			ctx, usage := CaptureUsage(context.Background())
			_, err := p.JSON(ctx, "test", object(map[string]any{"ok": map[string]any{"type": "boolean"}}, "ok"), "memoryz_test", nil)
			e, ok := apierr.From(err)
			if !ok || (e.Status != 429 && e.Status != 503) {
				t.Fatalf("upstream failure was classified as invalid model output: %v", err)
			}
			rows := usage.Requests()
			if len(rows) != 1 || !rows[0].TransportFailure || rows[0].HTTPStatus != status || rows[0].Cost != nil || rows[0].ModelReported || rows[0].ProviderReported {
				t.Fatalf("unknown failed usage was lost or attributed as confirmed: %+v", rows)
			}
		})
	}
}

func TestEssayBlindKeywordSelectionFailsClosed(t *testing.T) {
	wanted := []map[int]bool{{0: true, 2: true, 3: true, 6: true}}
	for _, tc := range []struct {
		supported, ambiguous []int
		valid                bool
	}{
		{[]int{0, 2, 3, 6}, nil, true},
		{[]int{0, 2, 3, 6}, []int{5}, false},
		{[]int{0, 2, 3, 5}, nil, false},
		{[]int{0, 2, 3}, nil, false},
		{[]int{0, 2, 3, 3}, nil, false},
	} {
		raw := map[string]any{"items": []any{map[string]any{"index": 0, "supportedIndices": tc.supported, "ambiguousIndices": tc.ambiguous, "reason": "조건과 용어의 의미 비교"}}}
		issues, err := essayKeywordProblems(raw, wanted)
		if (issues == "" && err == nil) != tc.valid {
			t.Fatalf("unsafe selection: %+v %q %v", tc, issues, err)
		}
	}
}

func TestBlindSolverRejectsNonUniqueOrWrongKey(t *testing.T) {
	questions := []QuestionItem{{Answer: 2}, {Answer: 0}}
	item := func(i int, answers ...int) any {
		return map[string]any{"index": i, "defensibleIndices": answers, "reason": "원문의 예외 조건을 확인했습니다."}
	}
	for name, rows := range map[string][]any{
		"correct":          {item(0, 2), item(1, 0)},
		"wrong key":        {item(0, 1), item(1, 0)},
		"multiple answers": {item(0, 2, 4), item(1, 0)},
		"missing answer":   {item(0), item(1, 0)},
		"duplicate item":   {item(0, 2), item(0, 2)},
	} {
		t.Run(name, func(t *testing.T) {
			issues, err := blindQuizProblems(map[string]any{"items": rows}, questions)
			if name == "correct" {
				if issues != "" || err != nil {
					t.Fatal(issues, err)
				}
			} else if issues == "" && err == nil {
				t.Fatal("unsafe key accepted")
			}
		})
	}
}

func TestBlindSolverCannotSeeAuthorKey(t *testing.T) {
	p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if strings.Contains(string(body), "AUTHOR_EXPLANATION_SENTINEL") || strings.Contains(string(body), `\"answer\"`) {
			t.Error("author key leaked into independent solver")
		}
		io.WriteString(w, `{"choices":[{"finish_reason":"stop","message":{"tool_calls":[{"function":{"name":"memoryz_quiz_blind_solve","arguments":"{\"items\":[{\"index\":0,\"defensibleIndices\":[0],\"reason\":\"근거가 분명함\"}]}"}}]}}]}`)
	})
	raw := map[string]any{"items": []any{map[string]any{"prompt": "어느 조건이 맞나요?", "options": []string{"a", "b", "c", "d", "e"}, "answer": 0, "explanation": "AUTHOR_EXPLANATION_SENTINEL"}}}
	if issues, err := solveQuizBlind(context.Background(), p, "조건 a에서만 관찰된다.", 1, raw); issues != "" || err != nil {
		t.Fatal(issues, err)
	}
}
