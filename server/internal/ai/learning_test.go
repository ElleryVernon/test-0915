package ai

import (
	"testing"

	"memoryz/server/internal/learning"
)

func TestOptionalLearningMetadataAdmission(t *testing.T) {
	content := "광종은 과거제를 실시하였다. 성종은 지방에 12목을 설치하였다."
	options := []string{"과거제 실시", "12목 설치", "대동법 시행", "훈민정음 창제", "경국대전 편찬"}
	e := learning.Resolve("pending", "광종은 과거제를 실시하였다.", content, options, 0, nil)
	if e.Status != "READY" {
		t.Fatal("fixture not grounded")
	}
	item := map[string]any{"prompt": "광종이 실시한 정책으로 옳은 것은?", "options": options, "answer": 0, "explanation": "광종은 과거제를 실시하여 인재를 선발하였다.", "citation": "광종은 과거제를 실시하였다.", "past": "역사 · 고려", "future": "역사 · 조선", "learningExplanation": e}
	raw := map[string]any{"items": []any{item}}
	got, err := parseItems(raw, KindQuiz, 1, content)
	if err != nil || got.Questions[0].LearningExplanation == nil {
		t.Fatal("valid optional metadata lost", err)
	}
	// A bad optional diagram cannot poison otherwise valid study content or enter its cache.
	e.Diagram.Nodes[0].Label = "원문에 없는 인물"
	item["learningExplanation"] = e
	got, err = parseItems(raw, KindQuiz, 1, content)
	if err != nil || got.Questions[0].LearningExplanation != nil {
		t.Fatal("invalid optional metadata admitted or discarded question", err)
	}
	delete(item, "learningExplanation")
	got, err = parseItems(raw, KindQuiz, 1, content)
	if err != nil || len(got.Questions) != 1 {
		t.Fatal("legacy model response no longer accepted", err)
	}
}
