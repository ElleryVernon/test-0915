package ai

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

const essayChoiceTestSource = "A can occur while B predominates.\nIdentical connectivity need not mean identical stereochemistry."

func essayChoiceTestKey() []map[int]bool {
	return []map[int]bool{{0: true, 2: true, 3: true, 6: true}}
}

func essayChoiceTestReview(keys []map[int]bool) map[string]any {
	items := make([]any, len(keys))
	for i, key := range keys {
		choices := make([]any, 8)
		for j := range choices {
			status := "contradicted"
			if key[j] {
				status = "supported"
			}
			choices[j] = map[string]any{"index": j, "status": status, "targetAmbiguous": false, "sourceQuote": "A can occur while B predominates.", "reason": "주어진 조건과 원문을 비교한 판정입니다.", "counterexample": ""}
		}
		coverage := []any{}
		for j := range 8 {
			if key[j] {
				coverage = append(coverage, map[string]any{"requirement": "문항이 요구한 핵심 결과", "choiceIndices": []any{j}})
			}
		}
		items[i] = map[string]any{"index": i, "choices": choices, "coverage": coverage, "duplicates": []any{}}
	}
	return map[string]any{"items": items}
}

func essayChoiceTestRow(raw map[string]any, item, choice int) map[string]any {
	return raw["items"].([]any)[item].(map[string]any)["choices"].([]any)[choice].(map[string]any)
}

func TestEssayChoiceReviewValidationPositiveAndReorderedCoverage(t *testing.T) {
	keys := append(essayChoiceTestKey(), map[int]bool{1: true, 4: true, 5: true, 7: true})
	raw := essayChoiceTestReview(keys)
	items := raw["items"].([]any)
	for _, item := range items {
		choices := item.(map[string]any)["choices"].([]any)
		choices[0], choices[7] = choices[7], choices[0]
	}
	items[0], items[1] = items[1], items[0]
	if issues, err := essayChoiceReviewProblems(raw, essayChoiceTestSource, keys); err != nil || issues != "" {
		t.Fatalf("valid full coverage rejected: %q %v", issues, err)
	}
}

func TestEssayChoiceReviewValidationMaxBatch(t *testing.T) {
	keys := make([]map[int]bool, 10)
	for i := range keys {
		keys[i] = map[int]bool{}
		for j := 0; j < 4; j++ {
			keys[i][(i+j*2)%8] = true
		}
	}
	raw := essayChoiceTestReview(keys)
	if issues, err := essayChoiceReviewProblems(raw, essayChoiceTestSource, keys); err != nil || issues != "" {
		t.Fatalf("80-choice positive control rejected: %q %v", issues, err)
	}
	last := raw["items"].([]any)[9].(map[string]any)
	last["choices"] = last["choices"].([]any)[:7]
	if _, err := essayChoiceReviewProblems(raw, essayChoiceTestSource, keys); !errors.Is(err, errSemanticQuality) {
		t.Fatal("last of 80 choices can be omitted", err)
	}
}

func TestEssayChoiceReviewValidationRejectsMalformedCoverageAndEvidence(t *testing.T) {
	mutations := map[string]func(map[string]any){
		"missing item":       func(m map[string]any) { m["items"] = []any{} },
		"duplicate item":     func(m map[string]any) { m["items"] = append(m["items"].([]any), m["items"].([]any)[0]) },
		"missing item index": func(m map[string]any) { delete(m["items"].([]any)[0].(map[string]any), "index") },
		"null item index":    func(m map[string]any) { m["items"].([]any)[0].(map[string]any)["index"] = nil },
		"out of range item":  func(m map[string]any) { m["items"].([]any)[0].(map[string]any)["index"] = 1 },
		"missing choice": func(m map[string]any) {
			i := m["items"].([]any)[0].(map[string]any)
			i["choices"] = i["choices"].([]any)[:7]
		},
		"extra choice": func(m map[string]any) {
			i := m["items"].([]any)[0].(map[string]any)
			i["choices"] = append(i["choices"].([]any), i["choices"].([]any)[0])
		},
		"duplicate choice":           func(m map[string]any) { essayChoiceTestRow(m, 0, 7)["index"] = 0 },
		"negative choice":            func(m map[string]any) { essayChoiceTestRow(m, 0, 0)["index"] = -1 },
		"out of range choice":        func(m map[string]any) { essayChoiceTestRow(m, 0, 7)["index"] = 8 },
		"fractional choice":          func(m map[string]any) { essayChoiceTestRow(m, 0, 0)["index"] = 0.5 },
		"missing choice index":       func(m map[string]any) { delete(essayChoiceTestRow(m, 0, 0), "index") },
		"null choice index":          func(m map[string]any) { essayChoiceTestRow(m, 0, 0)["index"] = nil },
		"unknown status":             func(m map[string]any) { essayChoiceTestRow(m, 0, 0)["status"] = "probably supported" },
		"missing status":             func(m map[string]any) { delete(essayChoiceTestRow(m, 0, 0), "status") },
		"missing target ambiguity":   func(m map[string]any) { delete(essayChoiceTestRow(m, 0, 0), "targetAmbiguous") },
		"null target ambiguity":      func(m map[string]any) { essayChoiceTestRow(m, 0, 0)["targetAmbiguous"] = nil },
		"string target ambiguity":    func(m map[string]any) { essayChoiceTestRow(m, 0, 0)["targetAmbiguous"] = "false" },
		"supported without quote":    func(m map[string]any) { essayChoiceTestRow(m, 0, 0)["sourceQuote"] = "" },
		"contradicted without quote": func(m map[string]any) { essayChoiceTestRow(m, 0, 1)["sourceQuote"] = "" },
		"missing quote field":        func(m map[string]any) { delete(essayChoiceTestRow(m, 0, 0), "sourceQuote") },
		"null quote":                 func(m map[string]any) { essayChoiceTestRow(m, 0, 0)["sourceQuote"] = nil },
		"whitespace quote":           func(m map[string]any) { essayChoiceTestRow(m, 0, 0)["sourceQuote"] = "\n" },
		"invented quote":             func(m map[string]any) { essayChoiceTestRow(m, 0, 0)["sourceQuote"] = "A is the only possible pathway." },
		"translated quote": func(m map[string]any) {
			essayChoiceTestRow(m, 0, 0)["sourceQuote"] = "A가 가능하고 B가 우세하다."
		},
		"stitched quote": func(m map[string]any) {
			essayChoiceTestRow(m, 0, 0)["sourceQuote"] = "A can occur ... identical stereochemistry."
		},
		"distant clauses without ellipsis": func(m map[string]any) {
			essayChoiceTestRow(m, 0, 0)["sourceQuote"] = "A can occur identical stereochemistry."
		},
		"ambiguous fabricated quote": func(m map[string]any) {
			c := essayChoiceTestRow(m, 0, 1)
			c["status"], c["sourceQuote"] = "ambiguous", "not present in source"
		},
		"empty reason":   func(m map[string]any) { essayChoiceTestRow(m, 0, 0)["reason"] = "  " },
		"missing reason": func(m map[string]any) { delete(essayChoiceTestRow(m, 0, 0), "reason") },
		"overlong reason": func(m map[string]any) {
			essayChoiceTestRow(m, 0, 0)["reason"] = strings.Repeat("가", essayChoiceReasonLimit+1)
		},
		"padded overlong reason": func(m map[string]any) {
			essayChoiceTestRow(m, 0, 0)["reason"] = strings.Repeat(" ", essayChoiceReasonLimit) + "이유"
		},
		"missing counterexample": func(m map[string]any) { delete(essayChoiceTestRow(m, 0, 0), "counterexample") },
		"null counterexample":    func(m map[string]any) { essayChoiceTestRow(m, 0, 0)["counterexample"] = nil },
		"overlong counterexample": func(m map[string]any) {
			essayChoiceTestRow(m, 0, 1)["counterexample"] = strings.Repeat("가", essayChoiceCounterLimit+1)
		},
		"unexpected field": func(m map[string]any) { essayChoiceTestRow(m, 0, 0)["answer"] = true },
	}
	// A known valid review is the positive control for every mutation below.
	if issues, err := essayChoiceReviewProblems(essayChoiceTestReview(essayChoiceTestKey()), essayChoiceTestSource, essayChoiceTestKey()); issues != "" || err != nil {
		t.Fatal(issues, err)
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			raw := essayChoiceTestReview(essayChoiceTestKey())
			mutate(raw)
			if _, err := essayChoiceReviewProblems(raw, essayChoiceTestSource, essayChoiceTestKey()); !errors.Is(err, errSemanticQuality) {
				t.Fatalf("malformed or ungrounded review accepted: %v", err)
			}
		})
	}
	longQuote := strings.Repeat("가", essayChoiceQuoteLimit)
	raw := essayChoiceTestReview(essayChoiceTestKey())
	essayChoiceTestRow(raw, 0, 0)["sourceQuote"] = longQuote
	source := essayChoiceTestSource + longQuote + "가"
	if issues, err := essayChoiceReviewProblems(raw, source, essayChoiceTestKey()); err != nil || issues != "" {
		t.Fatalf("quote at rune limit rejected: %q %v", issues, err)
	}
	essayChoiceTestRow(raw, 0, 0)["sourceQuote"] = longQuote + "가"
	if _, err := essayChoiceReviewProblems(raw, source, essayChoiceTestKey()); !errors.Is(err, errSemanticQuality) {
		t.Fatal("actual but oversized quote accepted", err)
	}
}

func TestEssayChoiceReviewValidationWhitespaceOnlyNormalization(t *testing.T) {
	raw := essayChoiceTestReview(essayChoiceTestKey())
	row := essayChoiceTestRow(raw, 0, 0)
	for _, quote := range []string{
		strings.ReplaceAll(essayChoiceTestSource, "\n", " "),
		"  A can\n\toccur   while B predominates.  ",
	} {
		row["sourceQuote"] = quote
		if issues, err := essayChoiceReviewProblems(raw, essayChoiceTestSource, essayChoiceTestKey()); err != nil || issues != "" {
			t.Fatalf("whitespace-only quote rejected: %q %v", issues, err)
		}
	}
	source := essayChoiceTestSource + "\nV0 \u0007 Vmax[S] / (\u0002Km + [S]).\nT n R transition."
	for _, quote := range []string{
		"V0 = Vmax[S] / (αKm + [S]).", // Invented repair of damaged source glyphs.
		"T→R transition.",             // No arrow repair in private review evidence.
		"B predominates. A can occur", // Reordered claims.
		"A can occur identical stereochemistry.",
	} {
		row["sourceQuote"] = quote
		if _, err := essayChoiceReviewProblems(raw, source, essayChoiceTestKey()); !errors.Is(err, errSemanticQuality) {
			t.Fatalf("non-whitespace rewrite accepted: %q %v", quote, err)
		}
	}
}

func TestEssayChoiceReviewValidationRejectsAmbiguityCounterexamplesAndWrongKey(t *testing.T) {
	for name, mutate := range map[string]func(map[string]any){
		"target omitted across compared objects": func(m map[string]any) {
			c := essayChoiceTestRow(m, 0, 1)
			c["targetAmbiguous"], c["reason"], c["counterexample"] = true, "비교하는 여러 대상 중 어느 것을 가리키는지 없습니다.", "다른 비교 대상에 적용하면 같은 주장이 참입니다."
		},
		"ambiguous missing condition": func(m map[string]any) {
			c := essayChoiceTestRow(m, 0, 1)
			c["status"], c["sourceQuote"], c["reason"] = "ambiguous", "", "비교 기준을 제시하지 않아 판단할 수 없습니다."
		},
		"possible does not exclude predominant": func(m map[string]any) {
			c := essayChoiceTestRow(m, 0, 1)
			c["counterexample"] = "같은 조건에서 A가 가능하면서 B가 우세할 수 있습니다."
		},
		"identity depends on comparison": func(m map[string]any) {
			c := essayChoiceTestRow(m, 0, 1)
			c["sourceQuote"] = "Identical connectivity need not mean identical stereochemistry."
			c["counterexample"] = "동일한 구조가 원자 연결을 뜻하면 두 표현은 양립합니다."
		},
		"supported carries counterexample": func(m map[string]any) {
			essayChoiceTestRow(m, 0, 0)["counterexample"] = "판정을 확정할 수 없는 다른 해석이 있습니다."
		},
		"too few supported":  func(m map[string]any) { essayChoiceTestRow(m, 0, 0)["status"] = "contradicted" },
		"too many supported": func(m map[string]any) { essayChoiceTestRow(m, 0, 1)["status"] = "supported" },
		"same count wrong key": func(m map[string]any) {
			essayChoiceTestRow(m, 0, 0)["status"] = "contradicted"
			essayChoiceTestRow(m, 0, 1)["status"] = "supported"
		},
	} {
		t.Run(name, func(t *testing.T) {
			raw := essayChoiceTestReview(essayChoiceTestKey())
			mutate(raw)
			issues, err := essayChoiceReviewProblems(raw, essayChoiceTestSource, essayChoiceTestKey())
			if err != nil || !strings.Contains(issues, "선택지") {
				t.Fatalf("semantic rejection lost actionable detail: %q %v", issues, err)
			}
			if strings.Contains(name, "does not exclude") && !strings.Contains(issues, "A가 가능하면서 B가 우세") {
				t.Fatal("counterexample not returned for regeneration", issues)
			}
		})
	}
}

func TestEssayChoiceReviewValidationRejectsInvalidPrivateKey(t *testing.T) {
	for _, wanted := range [][]map[int]bool{nil, {{0: true}}, {{0: true, 1: true, 2: true, 8: true}}, {{0: true, 1: true, 2: true, 3: false}}} {
		if _, err := essayChoiceReviewProblems(essayChoiceTestReview(essayChoiceTestKey()), essayChoiceTestSource, wanted); !errors.Is(err, errSemanticQuality) {
			t.Fatal("invalid private key accepted", wanted, err)
		}
	}
	keys := append(essayChoiceTestKey(), essayChoiceTestKey()[0])
	raw := essayChoiceTestReview(keys)
	raw["items"].([]any)[1].(map[string]any)["index"] = 0
	if _, err := essayChoiceReviewProblems(raw, essayChoiceTestSource, keys); !errors.Is(err, errSemanticQuality) {
		t.Fatal("duplicate item with otherwise correct count accepted", err)
	}
	if _, err := essayChoiceReviewProblems(make(chan int), essayChoiceTestSource, essayChoiceTestKey()); !errors.Is(err, errSemanticQuality) {
		t.Fatal("unmarshalable review accepted", err)
	}
}

func TestEssayChoiceReviewValidationRejectsUncoveredRequirementsAndDuplicates(t *testing.T) {
	for name, change := range map[string]func(map[string]any){
		"conditions do not cover result": func(item map[string]any) {
			item["coverage"] = []any{map[string]any{"requirement": "조건별로 나타나는 결과의 차이", "choiceIndices": []any{}}}
		},
		"only wrong choice covers result": func(item map[string]any) {
			item["coverage"] = []any{map[string]any{"requirement": "조건별 결과", "choiceIndices": []any{1}}}
		},
		"correct and wrong coverage mixed": func(item map[string]any) {
			item["coverage"] = []any{map[string]any{"requirement": "조건별 결과", "choiceIndices": []any{0, 1}}}
		},
		"same misconception repeated": func(item map[string]any) {
			item["duplicates"] = []any{map[string]any{"choiceIndices": []any{1, 4}, "reason": "두 선택지 모두 같은 조건의 결과를 부정하며 표현만 다릅니다."}}
		},
		"same correct concept repeated": func(item map[string]any) {
			item["duplicates"] = []any{map[string]any{"choiceIndices": []any{0, 2}, "reason": "두 선택지가 같은 결론을 다른 명칭으로 반복합니다."}}
		},
	} {
		t.Run(name, func(t *testing.T) {
			raw := essayChoiceTestReview(essayChoiceTestKey())
			change(raw["items"].([]any)[0].(map[string]any))
			issues, err := essayChoiceReviewProblems(raw, essayChoiceTestSource, essayChoiceTestKey())
			if err != nil || !strings.Contains(issues, "문항 1") || (strings.Contains(name, "cover") && !strings.Contains(issues, "결과")) || (strings.Contains(name, "repeated") && !strings.Contains(issues, "같은")) {
				t.Fatalf("set defect lost actionable feedback: %q %v", issues, err)
			}
		})
	}
	// One genuine concept may answer more than one related subrequirement; the
	// review does not invent a one-keyword-per-requirement constraint.
	raw := essayChoiceTestReview(essayChoiceTestKey())
	item := raw["items"].([]any)[0].(map[string]any)
	item["coverage"] = []any{
		map[string]any{"requirement": "비교의 방향", "choiceIndices": []any{0, 2}},
		map[string]any{"requirement": "비교 결과", "choiceIndices": []any{2}},
	}
	if issues, err := essayChoiceReviewProblems(raw, essayChoiceTestSource, essayChoiceTestKey()); issues != "" || err != nil {
		t.Fatal("legitimate shared coverage rejected", issues, err)
	}
}

func TestEssayChoiceReviewValidationRejectsMalformedSetMetadata(t *testing.T) {
	for name, change := range map[string]func(map[string]any){
		"missing coverage": func(item map[string]any) { delete(item, "coverage") },
		"null coverage":    func(item map[string]any) { item["coverage"] = nil },
		"empty coverage":   func(item map[string]any) { item["coverage"] = []any{} },
		"too many requirements": func(item map[string]any) {
			row := item["coverage"].([]any)[0]
			item["coverage"] = []any{row, row, row, row, row, row, row}
		},
		"missing duplicates": func(item map[string]any) { delete(item, "duplicates") },
		"null duplicates":    func(item map[string]any) { item["duplicates"] = nil },
		"unknown set field":  func(item map[string]any) { item["complete"] = true },
	} {
		t.Run(name, func(t *testing.T) {
			raw := essayChoiceTestReview(essayChoiceTestKey())
			change(raw["items"].([]any)[0].(map[string]any))
			if _, err := essayChoiceReviewProblems(raw, essayChoiceTestSource, essayChoiceTestKey()); !errors.Is(err, errSemanticQuality) {
				t.Fatal("malformed set metadata accepted", err)
			}
		})
	}
	for _, row := range []any{
		nil, map[string]any{}, map[string]any{"requirement": "요구", "choiceIndices": nil},
		map[string]any{"requirement": "요구", "choiceIndices": []any{nil}},
		map[string]any{"requirement": "요구", "choiceIndices": []any{0, 0}},
		map[string]any{"requirement": "요구", "choiceIndices": []any{-1}},
		map[string]any{"requirement": "요구", "choiceIndices": []any{8}},
		map[string]any{"requirement": "요구", "choiceIndices": []any{0.5}},
		map[string]any{"requirement": " ", "choiceIndices": []any{0}},
		map[string]any{"requirement": strings.Repeat("가", 161), "choiceIndices": []any{0}},
		map[string]any{"requirement": "요구", "choiceIndices": []any{0}, "extra": true},
	} {
		raw := essayChoiceTestReview(essayChoiceTestKey())
		raw["items"].([]any)[0].(map[string]any)["coverage"] = []any{row}
		if _, err := essayChoiceReviewProblems(raw, essayChoiceTestSource, essayChoiceTestKey()); !errors.Is(err, errSemanticQuality) {
			t.Fatal("invalid coverage row accepted", row, err)
		}
	}
	for _, groups := range []any{
		[]any{nil}, []any{map[string]any{}},
		[]any{map[string]any{"choiceIndices": nil, "reason": "중복"}},
		[]any{map[string]any{"choiceIndices": []any{nil, 2}, "reason": "중복"}},
		[]any{map[string]any{"choiceIndices": []any{0}, "reason": "중복"}},
		[]any{map[string]any{"choiceIndices": []any{0, 0}, "reason": "중복"}},
		[]any{map[string]any{"choiceIndices": []any{-1, 2}, "reason": "중복"}},
		[]any{map[string]any{"choiceIndices": []any{0, 8}, "reason": "중복"}},
		[]any{map[string]any{"choiceIndices": []any{0, 0.5}, "reason": "중복"}},
		[]any{map[string]any{"choiceIndices": []any{0, 2}, "reason": " "}},
		[]any{map[string]any{"choiceIndices": []any{0, 2}, "reason": strings.Repeat("가", 201)}},
		[]any{map[string]any{"choiceIndices": []any{0, 2}, "reason": "중복", "extra": true}},
		[]any{map[string]any{"choiceIndices": []any{0, 2}, "reason": "중복"}, map[string]any{"choiceIndices": []any{2, 3}, "reason": "겹친 그룹"}},
	} {
		raw := essayChoiceTestReview(essayChoiceTestKey())
		raw["items"].([]any)[0].(map[string]any)["duplicates"] = groups
		if _, err := essayChoiceReviewProblems(raw, essayChoiceTestSource, essayChoiceTestKey()); !errors.Is(err, errSemanticQuality) {
			t.Fatal("invalid duplicate groups accepted", groups, err)
		}
	}
}

func TestEssayChoiceReviewBlindRequestAndLocalProvider(t *testing.T) {
	for _, mode := range []string{"json_schema", "tools"} {
		t.Run(mode, func(t *testing.T) {
			keys := []string{"높은 친화도", "가역적 결합", "후속 결합 촉진", "구조 변화 전달"}
			falseChoices := []string{"낮은 친화도만", "비가역적 결합만", "후속 결합 차단", "구조 변화 없음"}
			questions := []EssayItem{{Prompt: "명시된 조건에서 결합의 관계를 설명하시오.", Keywords: keys, Distractors: falseChoices, ModelAnswer: "PRIVATE_MODEL_ANSWER_DO_NOT_SEND", Citation: "PRIVATE_CITATION_DO_NOT_SEND"}}
			questions = append(questions, questions[0])
			captured := make(chan map[string]any, 1)
			var calls atomic.Int32
			p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				select {
				case captured <- body:
				default:
				}
				content := body["messages"].([]any)[1].(map[string]any)["content"].(string)
				input := strings.TrimPrefix(content, essayChoiceReviewPrompt)
				var request struct {
					Source    string `json:"source"`
					Questions []struct {
						Index   int      `json:"index"`
						Choices []string `json:"choices"`
					} `json:"questions"`
				}
				if err := json.Unmarshal([]byte(input), &request); err != nil {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				wanted := make([]map[int]bool, len(request.Questions))
				for i, q := range request.Questions {
					wanted[i] = map[int]bool{}
					for j, text := range q.Choices {
						for _, key := range keys {
							if text == key {
								wanted[i][j] = true
							}
						}
					}
				}
				answer, _ := json.Marshal(essayChoiceTestReview(wanted))
				message := map[string]any{"content": string(answer)}
				if mode == "tools" {
					message = map[string]any{"tool_calls": []any{map[string]any{"function": map[string]any{"name": "memoryz_essay_keyword_solve", "arguments": string(answer)}}}}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": message}}})
			})
			if mode == "json_schema" {
				p.cfg.OpenRouterStructuredMode = mode
			}
			issues, err := solveEssayChoicesBlind(context.Background(), p, essayChoiceTestSource, 2, map[string]any{"items": questions})
			if err != nil || issues != "" || calls.Load() != 1 {
				t.Fatalf("valid local provider review failed: %q %v", issues, err)
			}
			body := <-captured
			content := body["messages"].([]any)[1].(map[string]any)["content"].(string)
			if !strings.HasPrefix(content, essayChoiceReviewPrompt) {
				t.Fatal("review instruction missing")
			}
			for _, leaked := range []string{"PRIVATE_MODEL_ANSWER", "PRIVATE_CITATION", "supportedIndices", "ambiguousIndices", "\"keywords\"", "\"distractors\"", "정답 4", "정답은 4", "네 개"} {
				if strings.Contains(content, leaked) {
					t.Fatal("key or count leaked to blind reviewer", leaked)
				}
			}
			var input map[string]any
			_ = json.Unmarshal([]byte(strings.TrimPrefix(content, essayChoiceReviewPrompt)), &input)
			if len(input) != 2 || input["source"] != essayChoiceTestSource {
				t.Fatal("blind input is not source/questions only", input)
			}
			for _, q := range input["questions"].([]any) {
				item := q.(map[string]any)
				if len(item) != 3 || item["prompt"] == nil || item["index"] == nil || len(item["choices"].([]any)) != 8 {
					t.Fatal("unexpected question shape", item)
				}
				seen := map[string]bool{}
				for _, c := range item["choices"].([]any) {
					seen[c.(string)] = true
				}
				if len(seen) != 8 {
					t.Fatal("shuffle lost a choice", seen)
				}
			}
			var schema map[string]any
			if mode == "json_schema" {
				schema = body["response_format"].(map[string]any)["json_schema"].(map[string]any)["schema"].(map[string]any)
			} else {
				schema = body["tools"].([]any)[0].(map[string]any)["function"].(map[string]any)["parameters"].(map[string]any)
			}
			items := schema["properties"].(map[string]any)["items"].(map[string]any)
			itemProps := items["items"].(map[string]any)["properties"].(map[string]any)
			choices := itemProps["choices"].(map[string]any)
			if choices["minItems"] != float64(8) || choices["maxItems"] != float64(8) {
				t.Fatal("schema does not require every choice", choices)
			}
			properties := choices["items"].(map[string]any)["properties"].(map[string]any)
			if properties["targetAmbiguous"].(map[string]any)["type"] != "boolean" || itemProps["coverage"].(map[string]any)["minItems"] != float64(1) || itemProps["coverage"].(map[string]any)["maxItems"] != float64(6) || itemProps["duplicates"].(map[string]any)["maxItems"] != float64(4) {
				t.Fatal("bounded coverage, duplicate or target schema missing", itemProps)
			}
			if !reflect.DeepEqual(properties["status"].(map[string]any)["enum"], []any{"supported", "contradicted", "ambiguous"}) {
				t.Fatal("review statuses weakened", properties)
			}
			for field, limit := range map[string]int{"sourceQuote": 600, "reason": 200, "counterexample": 200} {
				if properties[field].(map[string]any)["maxLength"] != float64(limit) {
					t.Fatal("unbounded review output", field)
				}
			}
		})
	}
}

func TestEssayChoiceReviewBlindRejectsInvalidInputWithoutModel(t *testing.T) {
	valid := map[string]any{"items": []EssayItem{{Prompt: "질문", Keywords: []string{"a", "b", "c", "d"}, Distractors: []string{"e", "f", "g", "h"}}}}
	for _, count := range []int{0, 11} {
		if _, _, err := essayChoiceReviewInput(essayChoiceTestSource, count, valid); !errors.Is(err, errItemShape) {
			t.Fatal("invalid count accepted", count, err)
		}
	}
	for _, raw := range []any{nil, make(chan int), map[string]any{"items": []EssayItem{}}, map[string]any{"items": []EssayItem{{Prompt: "Q", Keywords: []string{"a"}, Distractors: []string{"b"}}}}} {
		if _, err := solveEssayChoicesBlind(context.Background(), nil, essayChoiceTestSource, 1, raw); !errors.Is(err, errItemShape) {
			t.Fatal("invalid input reached provider", err)
		}
	}
	if _, _, err := essayChoiceReviewInput(" ", 1, valid); !errors.Is(err, errItemShape) {
		t.Fatal("missing source accepted", err)
	}
	input, wanted, err := essayChoiceReviewInput(essayChoiceTestSource, 1, valid)
	if err != nil || len(wanted) != 1 || len(wanted[0]) != 4 || input == "" {
		t.Fatal("positive input control failed", input, wanted, err)
	}
}

func TestEssayChoiceReviewBlindPropagatesProviderError(t *testing.T) {
	p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "temporary", http.StatusServiceUnavailable)
	})
	raw := map[string]any{"items": []EssayItem{{Prompt: "질문", Keywords: []string{"a", "b", "c", "d"}, Distractors: []string{"e", "f", "g", "h"}}}}
	issues, err := solveEssayChoicesBlind(context.Background(), p, essayChoiceTestSource, 1, raw)
	if err == nil || issues != "" || errors.Is(err, errSemanticQuality) {
		t.Fatalf("provider failure became a science judgment: %q %v", issues, err)
	}
}
