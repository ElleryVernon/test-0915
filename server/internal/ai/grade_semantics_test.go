package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"
)

func semanticGradeFixture() (GradeInput, map[string]any) {
	input := GradeInput{Prompt: "A와 B에서 우세한 반응을 각각 쓰세요.", Keywords: []string{"A의 SN2", "B의 E2"}, ModelAnswer: "A에서는 SN2, B에서는 E2가 우세합니다.", Citation: "A는 SN2, B는 E2 조건이다.", Answer: "A: SN2, B: E2"}
	raw := map[string]any{
		"concepts": 60.0, "reasoning": 25.0, "completeness": 15.0, "answerType": "reasoned",
		"keywordAssessments": []any{
			map[string]any{"index": 0.0, "status": "explained", "evidence": "A: SN2", "reason": "A의 조건과 반응을 바르게 연결합니다."},
			map[string]any{"index": 1.0, "status": "explained", "evidence": "B: E2", "reason": "B의 조건과 반응을 바르게 연결합니다."},
		},
		"feedback": map[string]any{"strengths": []any{"두 조건에 맞는 반응을 정확히 구별했어요."}, "corrections": []any{}, "nextStep": "", "completion": "A와 B의 대응을 모두 설명했어요."},
	}
	return input, raw
}

func TestEvidenceGradeAcceptsShortCorrectRelations(t *testing.T) {
	in, raw := semanticGradeFixture()
	got, err := validatedEvidenceGrade(raw, in)
	if err != nil || got.Score != 100 || !slices.Equal(got.Matched, in.Keywords) || len(got.Missing) != 0 {
		t.Fatalf("short correct answer lost credit: %+v %v", got, err)
	}
}

func TestEvidenceGradeCompleteFeedbackHasOneConfirmation(t *testing.T) {
	in, raw := semanticGradeFixture()
	f := raw["feedback"].(map[string]any)
	f["nextStep"] = "추가 연습: 조건을 바꾼 두 반응을 비교해 보세요."
	got, err := validatedEvidenceGrade(raw, in)
	if err != nil || got.Feedback != f["completion"].(string)+"\n\n"+f["nextStep"].(string) {
		t.Fatalf("completion repeated strengths or lost optional practice: %+v %v", got, err)
	}
}

func TestEvidenceGradeFullCreditStrengthsNeedNoRegrade(t *testing.T) {
	in, raw := semanticGradeFixture()
	f := raw["feedback"].(map[string]any)
	f["completion"] = ""
	f["nextStep"] = "추가 연습: 조건을 바꾸어 보세요."
	want := "두 조건에 맞는 반응을 정확히 구별했어요.\n\n추가 연습: 조건을 바꾸어 보세요."
	got, err := validatedEvidenceGrade(raw, in)
	if err != nil || got.Score != 100 || got.Feedback != want || len(got.Missing) != 0 {
		t.Fatalf("cosmetic confirmation placement changed the grade: %+v %v", got, err)
	}
	if f["completion"] != "" {
		t.Fatal("raw response mutated; diagnostics must retain model output")
	}
	// This is not a score-promotion or empty-feedback fallback.
	raw["concepts"] = 59.0
	if _, err := validatedEvidenceGrade(raw, in); err == nil {
		t.Fatal("unexplained deduction silently promoted")
	}
	raw["concepts"] = 60.0
	f["strengths"] = []any{}
	if _, err := validatedEvidenceGrade(raw, in); err == nil {
		t.Fatal("missing feedback accepted")
	}
}

func TestGradeReviewFullCreditConfirmationDoesNotSpendRepair(t *testing.T) {
	in, raw := semanticGradeFixture()
	raw["feedback"].(map[string]any)["completion"] = ""
	calls := 0
	p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			writeGradeTestResponse(w, raw)
		} else {
			writeGradeTestResponse(w, map[string]any{"valid": true, "issues": []any{}})
		}
	})
	p.cfg.AIQualityReview = true
	got, err := GradeWithAI(context.Background(), p, in)
	if err != nil || got.Score != 100 || calls != 2 {
		t.Fatalf("valid grade was regraded instead of only reviewed: %+v calls=%d %v", got, calls, err)
	}
}

func TestEvidenceGradeOneQuoteCanSupportEquivalentConceptLabels(t *testing.T) {
	in, raw := semanticGradeFixture()
	in.Prompt, in.Answer = "경쟁적 저해에서 최대 반응 속도의 변화를 쓰세요.", "Vmax는 변하지 않는다."
	in.Keywords = []string{"정상 Vmax", "Vmax 불변"}
	for _, item := range raw["keywordAssessments"].([]any) {
		item.(map[string]any)["evidence"] = in.Answer
		item.(map[string]any)["reason"] = "같은 최대 속도 관계를 올바르게 설명합니다."
	}
	got, err := validatedEvidenceGrade(raw, in)
	if err != nil || len(got.Matched) != 2 || len(got.Missing) != 0 {
		t.Fatalf("equivalent meanings incorrectly required duplicate wording: %+v %v", got, err)
	}
}

func TestEvidenceGradeDistinguishesMentionFromProposition(t *testing.T) {
	in, raw := semanticGradeFixture()
	in.Prompt, in.Answer = "경쟁적 저해의 결합 방식과 겉보기 Km 변화를 설명하세요.", "활성 부위, Km 증가"
	in.Keywords = []string{"활성 부위 경쟁", "겉보기 Km 증가"}
	a := raw["keywordAssessments"].([]any)
	a[0].(map[string]any)["status"], a[0].(map[string]any)["evidence"] = "mentioned", "활성 부위"
	a[1].(map[string]any)["evidence"] = "Km 증가"
	raw["answerType"], raw["concepts"], raw["reasoning"], raw["completeness"] = "partial", 16.0, 0.0, 0.0
	raw["feedback"] = map[string]any{"strengths": []any{"Km의 증가 방향은 맞아요."}, "corrections": []any{"활성 부위에서 누가 무엇과 경쟁하는지 설명이 빠져 있어요."}, "nextStep": "기질과 저해제가 활성 부위를 놓고 경쟁한다는 관계를 덧붙여 주세요.", "completion": ""}
	got, err := validatedEvidenceGrade(raw, in)
	if err != nil || got.Score != 16 || !slices.Equal(got.Matched, []string{in.Keywords[1]}) || !slices.Equal(got.Missing, []string{in.Keywords[0]}) {
		t.Fatalf("bare term and correct proposition conflated: %+v %v", got, err)
	}
	raw["answerType"] = "keyword_list"
	if _, err := validatedEvidenceGrade(raw, in); err == nil {
		t.Fatal("meaningful proposition subjected to bare-list cap")
	}
	raw["answerType"] = "partial"
	a[1].(map[string]any)["status"] = "contradicted"
	got, err = validatedEvidenceGrade(raw, in)
	if err != nil || len(got.Matched) != 0 || len(got.Missing) != 2 {
		t.Fatalf("contradiction received meaning credit: %+v %v", got, err)
	}
}

func TestEvidenceGradeRejectsFabricatedOrIncompleteAccounting(t *testing.T) {
	changes := map[string]func(map[string]any){
		"quote from source":  func(r map[string]any) { r["keywordAssessments"].([]any)[0].(map[string]any)["evidence"] = "A는 SN2" },
		"duplicate":          func(r map[string]any) { r["keywordAssessments"].([]any)[1].(map[string]any)["index"] = 0.0 },
		"out of range":       func(r map[string]any) { r["keywordAssessments"].([]any)[1].(map[string]any)["index"] = 2.0 },
		"fractional":         func(r map[string]any) { r["keywordAssessments"].([]any)[1].(map[string]any)["index"] = 0.5 },
		"omitted":            func(r map[string]any) { r["keywordAssessments"] = r["keywordAssessments"].([]any)[:1] },
		"unknown status":     func(r map[string]any) { r["keywordAssessments"].([]any)[0].(map[string]any)["status"] = "correct" },
		"empty evidence":     func(r map[string]any) { r["keywordAssessments"].([]any)[0].(map[string]any)["evidence"] = "" },
		"missing with quote": func(r map[string]any) { r["keywordAssessments"].([]any)[0].(map[string]any)["status"] = "missing" },
		"missing at full marks": func(r map[string]any) {
			a := r["keywordAssessments"].([]any)[0].(map[string]any)
			a["status"], a["evidence"] = "missing", ""
		},
		"full marks with invented correction": func(r map[string]any) {
			r["feedback"].(map[string]any)["corrections"] = []any{"설명이 빠졌어요."}
		},
		"off topic with credit": func(r map[string]any) { r["answerType"] = "off_topic" },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			in, raw := semanticGradeFixture()
			change(raw)
			if _, err := validatedEvidenceGrade(raw, in); err == nil {
				t.Fatal("invalid accounting accepted")
			}
		})
	}
}

func TestEvidenceGradeIncompleteAnswerNeedsCorrectionAndNextAction(t *testing.T) {
	for _, field := range []string{"corrections", "nextStep"} {
		t.Run(field, func(t *testing.T) {
			in, raw := semanticGradeFixture()
			raw["concepts"] = 40.0
			f := raw["feedback"].(map[string]any)
			f["corrections"], f["nextStep"], f["completion"] = []any{"조건에 대한 근거가 빠져 있어요."}, "두 조건을 각각 한 문장으로 풀어 써 주세요.", ""
			if _, err := validatedEvidenceGrade(raw, in); err != nil {
				t.Fatal(err)
			}
			if field == "corrections" {
				f[field] = []any{}
			} else {
				f[field] = ""
			}
			if _, err := validatedEvidenceGrade(raw, in); err == nil {
				t.Fatal("praise-only incomplete feedback accepted")
			}
		})
	}
}

func TestEvidenceGradePartialMeaningGetsCreditWithoutFullCompletion(t *testing.T) {
	in, raw := semanticGradeFixture()
	in.Prompt = "A의 배열 이름과 그 배열이 필요한 이유를 설명하세요."
	in.Answer = "s-cis 배열"
	in.Keywords = []string{"배열과 이유", "반응 조건"}
	a := raw["keywordAssessments"].([]any)
	a[0].(map[string]any)["status"], a[0].(map[string]any)["evidence"] = "partial", "s-cis 배열"
	a[1].(map[string]any)["status"], a[1].(map[string]any)["evidence"] = "missing", ""
	raw["concepts"], raw["reasoning"], raw["completeness"], raw["answerType"] = 8.0, 0.0, 0.0, "partial"
	f := map[string]any{"strengths": []any{"필요한 s-cis 배열을 맞게 썼어요."}, "corrections": []any{"말단 거리와 전이상태에 관한 이유는 아직 빠져 있어요."}, "nextStep": "그 배열에서 말단 탄소가 가까워지는 이유를 덧붙여 주세요.", "completion": ""}
	raw["feedback"] = f
	got, err := validatedEvidenceGrade(raw, in)
	if err != nil || got.Score != 8 || len(got.Matched) != 0 || len(got.Missing) != 2 {
		t.Fatalf("partial meaning lost: %+v %v", got, err)
	}
	raw["concepts"] = 0.0
	if _, err := validatedEvidenceGrade(raw, in); err == nil {
		t.Fatal("correct subanswer reduced to zero")
	}
	raw["concepts"] = 8.0
	f["strengths"] = []any{}
	if _, err := validatedEvidenceGrade(raw, in); err == nil {
		t.Fatal("correct subanswer unacknowledged")
	}
	// Unrelated names are not automatically awarded points merely for appearing.
	a[0].(map[string]any)["status"] = "mentioned"
	raw["concepts"] = 0.0
	if _, err := validatedEvidenceGrade(raw, in); err != nil {
		t.Fatal(err)
	}
}

func TestGradeRepairIsBoundedAndPreservesDeadline(t *testing.T) {
	for _, tc := range []struct {
		name          string
		alwaysInvalid bool
		budget        time.Duration
		wantCalls     int
		wantOK        bool
	}{
		{"repair", false, RequestTimeout, 3, true}, {"fail closed", true, RequestTimeout, 2, false}, {"short budget", false, time.Second, 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in, _ := semanticGradeFixture()
			calls := 0
			p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				var req map[string]any
				_ = json.NewDecoder(r.Body).Decode(&req)
				if req["tool_choice"].(map[string]any)["function"].(map[string]any)["name"] == "memoryz_essay_grade_review" {
					writeGradeTestResponse(w, map[string]any{"valid": true, "issues": []any{}})
					return
				}
				_, raw := semanticGradeFixture()
				if calls == 1 || tc.alwaysInvalid {
					raw["keywordAssessments"].([]any)[0].(map[string]any)["evidence"] = "학생이 쓰지 않은 근거"
				}
				encoded, _ := json.Marshal(raw)
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": string(encoded)}}}})
			})
			p.cfg.AIQualityReview = true
			ctx, cancel := context.WithTimeout(context.Background(), tc.budget)
			defer cancel()
			_, err := GradeWithAI(ctx, p, in)
			if calls != tc.wantCalls || (err == nil) != tc.wantOK {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
		})
	}
}

func writeGradeTestResponse(w http.ResponseWriter, raw any) {
	if fields, ok := raw.(map[string]any); ok {
		if _, review := fields["valid"]; review {
			raw = map[string]any{"review": raw}
		}
	}
	b, _ := json.Marshal(raw)
	_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": string(b)}}}})
}

func TestGradeReviewRepairSharesTheBoundAndUsesSpecificFeedback(t *testing.T) {
	for _, tc := range []struct {
		name                    string
		alwaysReject            bool
		budget                  time.Duration
		wantGrades, wantReviews int
		wantOK                  bool
	}{{"repair then independently verify", false, RequestTimeout, 2, 2, true}, {"reject second candidate", true, RequestTimeout, 2, 2, false}, {"no budget for repair", true, 30 * time.Second, 1, 1, false}} {
		t.Run(tc.name, func(t *testing.T) {
			grades, reviews := 0, 0
			const issue = "실제로 쓴 올바른 결과를 미충족으로 분류했습니다."
			p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
				var req map[string]any
				_ = json.NewDecoder(r.Body).Decode(&req)
				name := req["tool_choice"].(map[string]any)["function"].(map[string]any)["name"]
				if name == "memoryz_essay_grade_review" {
					reviews++
					if reviews == 1 || tc.alwaysReject {
						writeGradeTestResponse(w, map[string]any{"valid": false, "issues": []any{map[string]any{"kind": "meaning", "keywordIndex": 0, "reason": issue}}})
					} else {
						writeGradeTestResponse(w, map[string]any{"valid": true, "issues": []any{}})
					}
					return
				}
				grades++
				b, _ := json.Marshal(req)
				if grades == 2 && !strings.Contains(string(b), issue) {
					t.Error("repair lost the independent review findings")
				}
				_, raw := semanticGradeFixture()
				writeGradeTestResponse(w, raw)
			})
			p.cfg.AIQualityReview = true
			ctx, cancel := context.WithTimeout(context.Background(), tc.budget)
			defer cancel()
			in, _ := semanticGradeFixture()
			_, err := GradeWithAI(ctx, p, in)
			if grades != tc.wantGrades || reviews != tc.wantReviews || (err == nil) != tc.wantOK {
				t.Fatalf("grades=%d reviews=%d err=%v", grades, reviews, err)
			}
		})
	}
}

func TestGradeReviewDoesNotTurnUpstreamFailureIntoRepair(t *testing.T) {
	for _, status := range []int{402, 429, 500, 503} {
		calls := 0
		p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
			calls++
			// The review fails; a 429 keeps failing through the provider's bounded re-sends.
			if calls == 2 || (status == 429 && calls > 2) {
				w.WriteHeader(status)
				return
			}
			_, raw := semanticGradeFixture()
			writeGradeTestResponse(w, raw)
		})
		p.cfg.AIQualityReview = true
		p.retryBase, p.retryCap = time.Millisecond, 2*time.Millisecond
		wantCalls := 2
		if status == 429 {
			wantCalls = 2 + UpstreamRetries
		}
		in, _ := semanticGradeFixture()
		if _, err := GradeWithAI(context.Background(), p, in); err == nil || calls != wantCalls {
			t.Fatalf("status=%d calls=%d err=%v", status, calls, err)
		}
	}
}

func TestGradeRepairDoesNotRetryUpstreamFailures(t *testing.T) {
	for _, status := range []int{402, 429, 500, 503} {
		in, _ := semanticGradeFixture()
		calls := 0
		p := testProvider(t, func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(status) })
		p.cfg.AIQualityReview = true
		p.retryBase, p.retryCap = time.Millisecond, 2*time.Millisecond
		wantCalls := 1 // only a never-billed 429 is re-sent, and only by the provider itself
		if status == 429 {
			wantCalls = 1 + UpstreamRetries
		}
		if _, err := GradeWithAI(context.Background(), p, in); err == nil || calls != wantCalls {
			t.Fatalf("status=%d calls=%d err=%v", status, calls, err)
		}
	}
}
