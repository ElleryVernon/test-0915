package ai

import (
	"strings"
	"testing"
)

func TestEssayKeywordsAreExactOrderedAnswerSpans(t *testing.T) {
	annotated := "[[경쟁적 저해]]는 기질과 경쟁합니다. [[기질 농도]]를 높이면 경쟁에서 유리해져 [[Vmax]]가 유지됩니다. 하지만 [[겉보기 Km]]은 증가합니다."
	wrap := func(s string) any {
		return map[string]any{"items": []any{map[string]any{"annotatedAnswer": s, "citation": "source"}}}
	}
	got, err := resolveEssayAnswer(wrap(annotated))
	if err != nil {
		t.Fatal(err)
	}
	item := got.(map[string]any)["items"].([]any)[0].(map[string]any)
	if item["annotatedAnswer"] != nil || item["citation"] != "source" {
		t.Fatal("public contract changed")
	}
	answer := item["modelAnswer"].(string)
	if answer != "경쟁적 저해는 기질과 경쟁합니다. 기질 농도를 높이면 경쟁에서 유리해져 Vmax가 유지됩니다. 하지만 겉보기 Km은 증가합니다." {
		t.Fatal(answer)
	}
	offset := 0
	for _, keyword := range item["keywords"].([]any) {
		i := strings.Index(answer[offset:], keyword.(string))
		if i < 0 {
			t.Fatal("keyword missing or reordered")
		}
		offset += i + len(keyword.(string))
	}
	for _, invalid := range []string{
		strings.Replace(annotated, "[[Vmax]]", "Vmax", 1),
		annotated + "[[다섯번째]]",
		strings.Replace(annotated, "[[Vmax]]", "[[Vmax", 1),
		strings.Replace(annotated, "[[Vmax]]", "[[ [[Vmax]] ]]", 1),
		strings.Replace(annotated, "[[Vmax]]", "[[ ] ]", 1),
		strings.Replace(annotated, "[[Vmax]]", "[["+strings.Repeat("긴", 25)+"]]", 1),
		"]]" + annotated,
	} {
		if _, err := resolveEssayAnswer(wrap(invalid)); err == nil {
			t.Fatal("malformed annotation accepted", invalid)
		}
	}
}

func TestEssayAnswerPreservesNaturalPredicateSpans(t *testing.T) {
	annotated := "조건 A에서는 두 대상이 [[함께 움직인다]]. 조건 B에서는 첫 대상만 [[더 빠르게 움직이며]], 따라서 [[두 속도는 다르다]]. 이 비교는 [[주어진 조건에서만 성립한다]]."
	got, err := resolveEssayAnswer(map[string]any{"items": []any{map[string]any{"annotatedAnswer": annotated, "prompt": "두 조건의 결과를 비교하세요.", "distractors": []any{"다른 주장"}, "citation": "source"}}})
	if err != nil {
		t.Fatal(err)
	}
	item := got.(map[string]any)["items"].([]any)[0].(map[string]any)
	want := strings.ReplaceAll(strings.ReplaceAll(annotated, "[[", ""), "]]", "")
	if item["modelAnswer"] != want || item["keywords"].([]any)[1] != "더 빠르게 움직이며" || item["prompt"] != "두 조건의 결과를 비교하세요." {
		t.Fatal("predicate spans were forced into noun phrases or changed prose", item)
	}
}
