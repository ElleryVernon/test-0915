package ai

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

var jevGradeInput = GradeInput{
	Prompt:      "경쟁적 저해의 두 관찰을 설명하세요.",
	Keywords:    []string{"활성 부위", "가역적 경쟁", "겉보기 Km 증가", "Vmax 불변"},
	ModelAnswer: "저해제가 활성 부위에서 기질과 가역적으로 경쟁하므로 겉보기 Km는 증가하고 Vmax는 변하지 않는다.",
	Citation:    "Competitive inhibitors bind the active site reversibly; apparent Km rises while Vmax is unchanged.",
	Answer:      "저해제가 활성 부위를 두고 기질과 가역적으로 경쟁해서 겉보기 Km가 커지고 Vmax는 그대로다.",
}

func jevGradeAnswers(statuses []string, kind string, injection float64, confidence float64) func(map[string]JevQuestion) map[string]JevAnswer {
	return func(q map[string]JevQuestion) map[string]JevAnswer {
		out := map[string]JevAnswer{}
		for i, s := range statuses {
			out[fmt.Sprintf("kw_%d", i)] = JevAnswer{Type: "choice", Choice: s, Confidence: confidence}
		}
		out["answer_type"] = JevAnswer{Type: "choice", Choice: kind, Confidence: confidence}
		out["injection"] = JevAnswer{Type: "noul", Noul: injection}
		return out
	}
}

func TestGradeJudgmentQuestionsCoverEveryKeywordAndTheAnswerType(t *testing.T) {
	state, questions := gradeJudgmentQuestions(jevGradeInput)
	if len(questions) != len(jevGradeInput.Keywords)+2 {
		t.Fatalf("expected %d questions, got %d", len(jevGradeInput.Keywords)+2, len(questions))
	}
	if questions["kw_2"].Type != "choice" || !strings.Contains(questions["kw_2"].Instructions, "keywords[2]") || !strings.Contains(questions["kw_2"].Instructions, "겉보기 Km 증가") {
		t.Fatalf("keyword question must name its index and text: %+v", questions["kw_2"])
	}
	if questions["injection"].Type != "noul" || questions["answer_type"].Criteria == nil {
		t.Fatalf("answer type and injection questions missing")
	}
	if state["student_answer"] != jevGradeInput.Answer || state["source_excerpt"] != jevGradeInput.Citation {
		t.Fatalf("state must carry the answer and the source")
	}
}

func TestJudgeGradeDerivesListsAndProvisionalScore(t *testing.T) {
	j, _ := fakeJev(t, "on", jevGradeAnswers([]string{"explained", "explained", "partial", "missing"}, "partial", 0.02, 0.9), nil)
	g, err := JudgeGrade(context.Background(), j, jevGradeInput)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(g.Matched, ",") != "활성 부위,가역적 경쟁" || strings.Join(g.Missing, ",") != "겉보기 Km 증가,Vmax 불변" {
		t.Fatalf("lists %v / %v", g.Matched, g.Missing)
	}
	// (1 + 1 + 0.5 + 0) / 4 = 62.5 → 63
	if g.Provisional != 63 || g.AnswerType != "partial" || g.Model != "jev-1.13.0" {
		t.Fatalf("judgment %+v", g)
	}
	injected, _ := fakeJev(t, "on", jevGradeAnswers([]string{"explained", "explained", "explained", "explained"}, "off_topic", 0.98, 1), nil)
	g, err = JudgeGrade(context.Background(), injected, jevGradeInput)
	if err != nil {
		t.Fatal(err)
	}
	if g.Provisional != 0 || len(g.Matched) != 0 || len(g.Missing) != 4 {
		t.Fatalf("an instruction has nothing to mark: %+v", g)
	}
	if provisionalScore([]string{"mentioned", "mentioned", "explained", "mentioned"}, "keyword_list", 0) != 20 {
		t.Fatal("keyword lists cap at 20")
	}
	if provisionalScore([]string{"explained", "contradicted", "contradicted", "contradicted"}, "central_contradiction", 0) != 25 {
		t.Fatal("central contradictions cap at 25")
	}
}

func evidenceGradeMap(statuses []string, kind string) map[string]any {
	items := make([]any, 0, len(statuses))
	for i, s := range statuses {
		items = append(items, map[string]any{"index": float64(i), "status": s, "evidence": "x", "reason": "r"})
	}
	return map[string]any{"answerType": kind, "keywordAssessments": items}
}

func TestGradeJudgmentAgreementRules(t *testing.T) {
	j := GradeJudgment{
		Keywords:   []KeywordJudgment{{Status: "explained", Confidence: 0.95}, {Status: "explained", Confidence: 0.9}, {Status: "partial", Confidence: 0.7}, {Status: "missing", Confidence: 0.99}},
		AnswerType: "partial", AnswerTypeConfidence: 0.9, Injection: 0.02,
	}
	if ok, why := j.Agreement(evidenceGradeMap([]string{"explained", "explained", "mentioned", "missing"}, "partial")); !ok {
		t.Fatalf("partial vs mentioned both mean not explained: %s", why)
	}
	if ok, why := j.Agreement(evidenceGradeMap([]string{"explained", "explained", "explained", "missing"}, "partial")); ok || !strings.Contains(why, "keyword 2") {
		t.Fatalf("explained-ness must match: %v %s", ok, why)
	}
	if ok, why := j.Agreement(evidenceGradeMap([]string{"explained", "explained", "mentioned", "missing"}, "reasoned")); ok || !strings.Contains(why, "answer type") {
		t.Fatalf("answer type must match: %v %s", ok, why)
	}
	low := j
	low.Keywords[2].Confidence = 0.4
	if ok, why := low.Agreement(evidenceGradeMap([]string{"explained", "explained", "mentioned", "missing"}, "partial")); ok || !strings.Contains(why, "confidence") {
		t.Fatalf("low confidence never agrees: %v %s", ok, why)
	}
	injected := GradeJudgment{Keywords: j.Keywords, AnswerType: "off_topic", AnswerTypeConfidence: 1, Injection: 0.98}
	if ok, why := injected.Agreement(evidenceGradeMap([]string{"explained", "explained", "explained", "explained"}, "reasoned")); ok || !strings.Contains(why, "injection") {
		t.Fatalf("a detected instruction graded as content is a disagreement: %v %s", ok, why)
	}
	if ok, _ := j.Agreement("not a map"); ok {
		t.Fatal("shape")
	}
}
