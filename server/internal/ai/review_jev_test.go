package ai

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestJudgeQuizItemsFlagsKeyDisagreementAndReportsConfidence(t *testing.T) {
	items := []QuestionItem{
		{Prompt: "탈분극에서 일어나는 일은?", Options: []string{"K+ 유출", "Na+ 유입", "Cl- 유입", "Ca2+ 유출", "없음"}, Answer: 1},
		{Prompt: "도약 전도가 빠른 이유는?", Options: []string{"말이집", "시냅스", "세포체", "수상돌기", "없음"}, Answer: 0},
	}
	agree, _ := fakeJev(t, "on", func(q map[string]JevQuestion) map[string]JevAnswer {
		if len(q) != 4 {
			t.Fatalf("expected 4 questions (2 choice + 2 noul), got %d", len(q))
		}
		return map[string]JevAnswer{
			"q_0": {Type: "choice", Choice: "option_1", Confidence: 0.97}, "s_0": {Type: "noul", Noul: 0.95},
			"q_1": {Type: "choice", Choice: "option_0", Confidence: 0.99}, "s_1": {Type: "noul", Noul: 0.9},
		}
	}, nil)
	issues, confident, err := judgeQuizItems(context.Background(), agree, "원문", items)
	if err != nil || issues != "" || !confident {
		t.Fatalf("all keys agree with confidence: %q %v %v", issues, confident, err)
	}
	unsure, _ := fakeJev(t, "on", func(q map[string]JevQuestion) map[string]JevAnswer {
		return map[string]JevAnswer{
			"q_0": {Type: "choice", Choice: "option_1", Confidence: 0.55}, "s_0": {Type: "noul", Noul: 0.9},
			"q_1": {Type: "choice", Choice: "option_0", Confidence: 0.99}, "s_1": {Type: "noul", Noul: 0.9},
		}
	}, nil)
	if issues, confident, err := judgeQuizItems(context.Background(), unsure, "원문", items); err != nil || issues != "" || confident {
		t.Fatalf("a low-confidence agreement is not confident: %q %v %v", issues, confident, err)
	}
	wrong, _ := fakeJev(t, "on", func(q map[string]JevQuestion) map[string]JevAnswer {
		return map[string]JevAnswer{
			"q_0": {Type: "choice", Choice: "option_0", Confidence: 0.9}, "s_0": {Type: "noul", Noul: 0.9},
			"q_1": {Type: "choice", Choice: "option_0", Confidence: 0.99}, "s_1": {Type: "noul", Noul: 0.3},
		}
	}, nil)
	issues, confident, err = judgeQuizItems(context.Background(), wrong, "원문", items)
	if err != nil || confident || !strings.Contains(issues, "항목 1") || !strings.Contains(issues, "정답 키(2)") {
		t.Fatalf("key disagreement must be reported: %q %v %v", issues, confident, err)
	}
	if !strings.Contains(issues, "항목 2") || !strings.Contains(issues, "하나로 확정") {
		t.Fatalf("an unresolved key must be reported: %q", issues)
	}
	if _, _, err := judgeQuizItems(context.Background(), agree, strings.Repeat("가", jevStateLimit+1), items); err != errJevTooLong {
		t.Fatalf("long sources fall back: %v", err)
	}
}

func TestJudgeEssayItemsRejectsSupportedDistractorsAndUnsupportedKeywords(t *testing.T) {
	items := []EssayItem{{Prompt: "탈분극 과정을 설명하세요.", Keywords: []string{"자극", "나트륨 이온 통로", "유입", "탈분극"}, Distractors: []string{"광합성", "항체", "글루카곤", "글리코젠"}}}
	all := func(choice string, conf float64, except map[string]JevAnswer) func(map[string]JevQuestion) map[string]JevAnswer {
		return func(q map[string]JevQuestion) map[string]JevAnswer {
			out := map[string]JevAnswer{}
			for id := range q {
				if strings.HasPrefix(id, "k_") {
					out[id] = JevAnswer{Type: "choice", Choice: "supported", Confidence: conf}
				} else {
					out[id] = JevAnswer{Type: "choice", Choice: choice, Confidence: conf}
				}
			}
			for id, a := range except {
				out[id] = a
			}
			return out
		}
	}
	good, _ := fakeJev(t, "on", all("says_nothing", 0.95, nil), nil)
	issues, confident, err := judgeEssayItems(context.Background(), good, "원문", items)
	if err != nil || issues != "" || !confident {
		t.Fatalf("keywords supported and distractors not: %q %v %v", issues, confident, err)
	}
	leaky, _ := fakeJev(t, "on", all("contradicted", 0.95, map[string]JevAnswer{"d_0_2": {Type: "choice", Choice: "supported", Confidence: 0.9}, "k_0_1": {Type: "choice", Choice: "says_nothing", Confidence: 0.8}}), nil)
	issues, confident, err = judgeEssayItems(context.Background(), leaky, "원문", items)
	if err != nil || confident || !strings.Contains(issues, "방해어 '글루카곤'") || !strings.Contains(issues, "키워드 '나트륨 이온 통로'") {
		t.Fatalf("supported distractor and unsupported keyword must be reported: %q", issues)
	}
	for i := 0; i < 1; i++ {
		_ = fmt.Sprint(i)
	}
}
