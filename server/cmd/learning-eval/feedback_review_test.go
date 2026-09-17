package main

import (
	"slices"
	"testing"
)

func TestFeedbackReviewPreservesEveryFailedCriterion(t *testing.T) {
	got := feedbackReviewIssues(false, true, false, false, []string{"specific scientific concern", " "})
	want := []string{"specific scientific concern", "feedback judge criterion failed: accurate", "feedback judge criterion failed: actionable", "feedback judge criterion failed: semanticAccounting"}
	if !slices.Equal(got, want) {
		t.Fatalf("judge findings were lost or changed: %v", got)
	}
	if got := feedbackReviewIssues(true, true, true, true, nil); len(got) != 0 {
		t.Fatalf("passing judge gained a failure: %v", got)
	}
	if got := feedbackReviewIssues(true, false, true, true, nil); !slices.Equal(got, []string{"feedback judge criterion failed: answerSpecific"}) {
		t.Fatalf("unexplained failure lost its criterion: %v", got)
	}
}
