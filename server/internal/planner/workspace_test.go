package planner

import "testing"

func TestScheduleBatchValidation(t *testing.T) {
	valid := BatchBlock{Title: "학원", Date: "2026-09-21", Start: "18:00", End: "19:00", Kind: "FIXED"}
	if err := ValidateBatch([]BatchBlock{valid}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []BatchBlock{
		{Title: "학원", Date: "2026-02-30", Start: "18:00", End: "19:00", Kind: "FIXED"},
		{Title: "학원", Date: "2026-09-21", Start: "18:00", End: "24:00", Kind: "FIXED"},
		{Title: "학원", Date: "2026-09-21", Start: "18:00", End: "17:00", Kind: "FIXED"},
		{Title: "", Date: "2026-09-21", Start: "18:00", End: "19:00", Kind: "FIXED"},
	} {
		if ValidateBatch([]BatchBlock{bad}) == nil {
			t.Fatalf("accepted invalid block: %+v", bad)
		}
	}
	if ValidateBatch([]BatchBlock{valid, valid}) == nil {
		t.Fatal("overlap accepted")
	}
	adjacent := valid
	adjacent.Start = "19:00"
	adjacent.End = "20:00"
	if err := ValidateBatch([]BatchBlock{valid, adjacent}); err != nil {
		t.Fatal("adjacent rejected", err)
	}
	far := valid
	far.Date = "2027-09-21"
	if ValidateBatch([]BatchBlock{valid, far}) == nil {
		t.Fatal("unbounded batch accepted")
	}
	if ValidateBatch(make([]BatchBlock, 201)) == nil {
		t.Fatal("oversized batch accepted")
	}
}
func TestExactDuplicateDoesNotConfuseAnotherSubjectOrScheduleKind(t *testing.T) {
	a := BatchBlock{Title: " 학원 ", Date: "2026-09-21", Start: "18:00", End: "19:00", Kind: "FIXED"}
	b := a
	b.Title = "학원"
	if !SameBatchBlock(a, b) {
		t.Fatal("whitespace-only replay missed")
	}
	subject := "other"
	b.SubjectID = &subject
	if SameBatchBlock(a, b) {
		t.Fatal("different subject treated as exact match")
	}
	b = a
	b.Kind = "FLEXIBLE"
	if SameBatchBlock(a, b) {
		t.Fatal("different kind treated as exact match")
	}
}
