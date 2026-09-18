package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Generation review judgments: the blind solve as one choice per question and the keyword or
// distractor check as one choice per claim, all in one request per batch. An item the judge
// rejects goes back to the generator at once; a batch it accepts with confidence lets the
// separate model solve be skipped when AI_JUDGE=on.

const (
	jevReviewConfidence = 0.8
	jevQuizTask         = "typesafe_quiz_judge"
	jevEssayTask        = "typesafe_essay_judge"
)

var jevClaimCriteria = map[string]string{
	"supported":    "원문이 그 주장이 옳다고 말하거나 직접 함의함",
	"contradicted": "원문이 반대 내용을 말하거나 그 주장이 틀렸다고 함의함",
	"says_nothing": "원문이 그 주장을 다루지 않음",
}

// judgeQuizItems solves every question from the source alone and compares with the private key.
func judgeQuizItems(ctx context.Context, j *Jev, source string, items []QuestionItem) (issues string, confident bool, err error) {
	if utf8.RuneCountInString(source) > jevStateLimit || len(items) == 0 {
		return "", false, errJevTooLong
	}
	type option struct {
		Index int    `json:"index"`
		Text  string `json:"text"`
	}
	type question struct {
		Index   int      `json:"index"`
		Prompt  string   `json:"prompt"`
		Options []option `json:"options"`
	}
	questions := make([]question, 0, len(items))
	asks := map[string]JevQuestion{}
	for i, item := range items {
		q := question{Index: i, Prompt: item.Prompt}
		criteria := map[string]string{}
		for k, text := range item.Options {
			q.Options = append(q.Options, option{Index: k, Text: text})
			criteria[fmt.Sprintf("option_%d", k)] = text
		}
		questions = append(questions, q)
		asks[fmt.Sprintf("q_%d", i)] = JevQuestion{
			Type:         "choice",
			Instructions: fmt.Sprintf("원문 `source`만으로 `questions[%d].prompt`의 정답인 보기를 고르세요. 보기는 `questions[%d].options`에 있습니다.", i, i),
			Criteria:     criteria,
		}
		asks[fmt.Sprintf("s_%d", i)] = JevQuestion{
			Type:         "noul",
			Instructions: fmt.Sprintf("원문 `source`만으로 `questions[%d].prompt`의 정답을 보기 중 정확히 하나로 확정할 수 있습니까?", i),
		}
	}
	result, err := j.Ask(ctx, jevQuizTask, map[string]any{"source": source, "questions": questions}, asks)
	if err != nil {
		return "", false, err
	}
	confident = true
	var problems []string
	for i, item := range items {
		answer := result.Answers[fmt.Sprintf("q_%d", i)]
		single := result.Answers[fmt.Sprintf("s_%d", i)].Noul
		chosen := -1
		fmt.Sscanf(answer.Choice, "option_%d", &chosen)
		if chosen != item.Answer {
			problems = append(problems, fmt.Sprintf("항목 %d 빠른 판정: 원문만으로는 보기 %d가 정답으로 보여 정답 키(%d)와 다릅니다 (확신 %.2f)", i+1, chosen+1, item.Answer+1, answer.Confidence))
			continue
		}
		if single < 0.5 {
			problems = append(problems, fmt.Sprintf("항목 %d 빠른 판정: 정답이 하나로 확정되지 않습니다 (확률 %.2f)", i+1, single))
			continue
		}
		if answer.Confidence < jevReviewConfidence || single < jevReviewConfidence {
			confident = false
		}
	}
	if len(problems) > 0 {
		return strings.Join(problems, "\n"), false, nil
	}
	return "", confident, nil
}

// judgeEssayItems checks that every keyword is supported by the source and no distractor is.
func judgeEssayItems(ctx context.Context, j *Jev, source string, items []EssayItem) (issues string, confident bool, err error) {
	if utf8.RuneCountInString(source) > jevStateLimit || len(items) == 0 {
		return "", false, errJevTooLong
	}
	type question struct {
		Index  int    `json:"index"`
		Prompt string `json:"prompt"`
	}
	questions := make([]question, 0, len(items))
	asks := map[string]JevQuestion{}
	claim := func(i int, text string) JevQuestion {
		return JevQuestion{
			Type:         "choice",
			Instructions: fmt.Sprintf("원문 `source`가 `questions[%d].prompt`의 맥락에서 다음 주장을 어떻게 다룹니까: \"%s\"", i, text),
			Criteria:     jevClaimCriteria,
		}
	}
	for i, item := range items {
		questions = append(questions, question{Index: i, Prompt: item.Prompt})
		for k, text := range item.Keywords {
			asks[fmt.Sprintf("k_%d_%d", i, k)] = claim(i, text)
		}
		for k, text := range item.Distractors {
			asks[fmt.Sprintf("d_%d_%d", i, k)] = claim(i, text)
		}
	}
	result, err := j.Ask(ctx, jevEssayTask, map[string]any{"source": source, "questions": questions}, asks)
	if err != nil {
		return "", false, err
	}
	confident = true
	var problems []string
	for i, item := range items {
		for k, text := range item.Keywords {
			a := result.Answers[fmt.Sprintf("k_%d_%d", i, k)]
			if a.Choice != "supported" {
				problems = append(problems, fmt.Sprintf("항목 %d 빠른 판정: 키워드 '%s'를 원문이 뒷받침하지 않습니다 (%s, 확신 %.2f)", i+1, text, a.Choice, a.Confidence))
			} else if a.Confidence < jevReviewConfidence {
				confident = false
			}
		}
		for k, text := range item.Distractors {
			a := result.Answers[fmt.Sprintf("d_%d_%d", i, k)]
			if a.Choice == "supported" {
				problems = append(problems, fmt.Sprintf("항목 %d 빠른 판정: 방해어 '%s'가 원문에서 옳아 정답과 구별되지 않습니다 (확신 %.2f)", i+1, text, a.Confidence))
			} else if a.Confidence < jevReviewConfidence {
				confident = false
			}
		}
	}
	if len(problems) > 0 {
		return strings.Join(problems, "\n"), false, nil
	}
	return "", confident, nil
}

// judgeGeneratedItems decodes the candidate items of the mode and asks the judge about them.
func judgeGeneratedItems(ctx context.Context, j *Jev, source string, mode Kind, count int, raw any) (string, bool, error) {
	b, err := json.Marshal(raw)
	if err != nil {
		return "", false, err
	}
	switch mode {
	case KindQuiz:
		var candidate struct {
			Items []QuestionItem `json:"items"`
		}
		if json.Unmarshal(b, &candidate) != nil || len(candidate.Items) != count {
			return "", false, errItemShape
		}
		return judgeQuizItems(ctx, j, source, candidate.Items)
	case KindEssay:
		var candidate struct {
			Items []EssayItem `json:"items"`
		}
		if json.Unmarshal(b, &candidate) != nil || len(candidate.Items) != count {
			return "", false, errItemShape
		}
		return judgeEssayItems(ctx, j, source, candidate.Items)
	}
	return "", false, errItemShape
}
