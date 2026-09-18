package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// writeToolResponse answers an OpenRouter-style forced function call with payload.
func writeToolResponse(w http.ResponseWriter, name string, payload any) {
	b, _ := json.Marshal(payload)
	_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{
		"tool_calls": []any{map[string]any{"function": map[string]any{"name": name, "arguments": string(b)}}},
	}}}, "usage": map[string]any{"prompt_tokens": 1, "completion_tokens": 1}})
}

func toolName(r *http.Request) (string, map[string]any) {
	var req map[string]any
	_ = json.NewDecoder(r.Body).Decode(&req)
	choice, _ := req["tool_choice"].(map[string]any)
	fn, _ := choice["function"].(map[string]any)
	name, _ := fn["name"].(string)
	return name, req
}

func TestGradeWithAIJudgeAgreementReplacesTheReviewOnlyWhenOn(t *testing.T) {
	for _, tc := range []struct {
		name        string
		mode        string
		judge       func(map[string]JevQuestion) map[string]JevAnswer
		judgeFails  bool
		wantReviews int
		wantNote    string
	}{
		{"on and agreeing", "on", jevGradeAnswers([]string{"explained", "explained"}, "reasoned", 0.02, 0.95), false, 0, "review skipped"},
		{"shadow records only", "shadow", jevGradeAnswers([]string{"explained", "explained"}, "reasoned", 0.02, 0.95), false, 1, "agreement"},
		{"on but disagreeing", "on", jevGradeAnswers([]string{"explained", "missing"}, "partial", 0.02, 0.95), false, 1, "disagreement"},
		{"on but unsure", "on", jevGradeAnswers([]string{"explained", "explained"}, "reasoned", 0.02, 0.4), false, 1, "confidence"},
		{"on but the judge fails", "on", nil, true, 1, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			grades, reviews := 0, 0
			p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
				name, _ := toolName(r)
				if name == "memoryz_essay_grade_review" {
					reviews++
					writeGradeTestResponse(w, map[string]any{"valid": true, "issues": []any{}})
					return
				}
				grades++
				_, raw := semanticGradeFixture()
				writeGradeTestResponse(w, raw)
			})
			p.cfg.AIQualityReview = true
			if tc.judgeFails {
				j, _ := fakeJev(t, tc.mode, nil, func(w http.ResponseWriter, n int) bool { w.WriteHeader(http.StatusInternalServerError); return false })
				p.SetJev(j)
			} else {
				j, _ := fakeJev(t, tc.mode, tc.judge, nil)
				p.SetJev(j)
			}
			ctx, usage := CaptureUsage(context.Background())
			in, _ := semanticGradeFixture()
			got, err := GradeWithAI(ctx, p, in)
			if err != nil || got.Score != 100 || grades != 1 || reviews != tc.wantReviews {
				t.Fatalf("score=%d grades=%d reviews=%d err=%v", got.Score, grades, reviews, err)
			}
			notes := ""
			for _, r := range usage.Retries() {
				if r.Kind == "judge" {
					notes += r.Reason + "\n"
				}
			}
			if tc.wantNote != "" && !strings.Contains(notes, tc.wantNote) {
				t.Fatalf("expected a %q note, got %q", tc.wantNote, notes)
			}
			if tc.judgeFails && notes != "" {
				t.Fatalf("a failed judge leaves no verdict: %q", notes)
			}
			paid := 0
			for _, u := range usage.Requests() {
				if u.Provider == "typesafe" {
					paid++
				}
			}
			if paid != 1 {
				t.Fatalf("the judge call must be recorded once, got %d", paid)
			}
		})
	}
}

func TestGradeWithAIWithoutJudgeIsUnchanged(t *testing.T) {
	grades, reviews := 0, 0
	p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
		if name, _ := toolName(r); name == "memoryz_essay_grade_review" {
			reviews++
			writeGradeTestResponse(w, map[string]any{"valid": true, "issues": []any{}})
			return
		}
		grades++
		_, raw := semanticGradeFixture()
		writeGradeTestResponse(w, raw)
	})
	p.cfg.AIQualityReview = true
	in, _ := semanticGradeFixture()
	if _, err := GradeWithAI(context.Background(), p, in); err != nil || grades != 1 || reviews != 1 {
		t.Fatalf("grades=%d reviews=%d err=%v", grades, reviews, err)
	}
}

func quizCandidate() map[string]any {
	return map[string]any{"items": []any{map[string]any{
		"prompt": "탈분극에서 일어나는 일은?", "options": []any{"K+ 유출", "Na+ 유입", "Cl- 유입", "Ca2+ 유출", "없음"}, "answer": 1,
		"explanation": "나트륨 이온이 유입된다.", "citation": "나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.", "past": "", "future": "",
	}}}
}

func TestReviewItemsJudgePrefiltersTheModelSolve(t *testing.T) {
	agreeing := func(q map[string]JevQuestion) map[string]JevAnswer {
		return map[string]JevAnswer{"q_0": {Type: "choice", Choice: "option_1", Confidence: 0.97}, "s_0": {Type: "noul", Noul: 0.95}}
	}
	rejecting := func(q map[string]JevQuestion) map[string]JevAnswer {
		return map[string]JevAnswer{"q_0": {Type: "choice", Choice: "option_0", Confidence: 0.9}, "s_0": {Type: "noul", Noul: 0.9}}
	}
	for _, tc := range []struct {
		name                   string
		mode                   string
		judge                  func(map[string]JevQuestion) map[string]JevAnswer
		wantSolves, wantChecks int
		wantIssue              string
	}{
		{"on and confident skips the model solve", "on", agreeing, 0, 1, ""},
		{"on and rejecting returns to the generator at once", "on", rejecting, 0, 0, "빠른 판정"},
		{"shadow never changes the path", "shadow", rejecting, 1, 1, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			solves, checks := 0, 0
			p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
				switch name, _ := toolName(r); name {
				case "memoryz_quiz_blind_solve":
					solves++
					writeToolResponse(w, name, map[string]any{"items": []any{map[string]any{"index": 0, "defensibleIndices": []any{1}, "reason": "원문에 근거"}}})
				case "memoryz_learning_quality":
					checks++
					writeToolResponse(w, name, map[string]any{"items": []any{qualityItem(0, true)}})
				default:
					t.Errorf("unexpected model call %s", name)
				}
			})
			j, _ := fakeJev(t, tc.mode, tc.judge, nil)
			p.SetJev(j)
			issues, err := reviewItems(context.Background(), p, "나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.", KindQuiz, 1, quizCandidate())
			if err != nil {
				t.Fatal(err)
			}
			if solves != tc.wantSolves || checks != tc.wantChecks || (tc.wantIssue == "") != (issues == "") || !strings.Contains(issues, tc.wantIssue) {
				t.Fatalf("solves=%d checks=%d issues=%q", solves, checks, issues)
			}
		})
	}
	for i := 0; i < 1; i++ {
		_ = fmt.Sprint(i)
	}
}
