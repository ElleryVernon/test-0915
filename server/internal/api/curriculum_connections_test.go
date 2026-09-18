package api

import (
	"context"
	"testing"
)

func TestCurriculumConnectionsOwnershipAndCoverage(t *testing.T) {
	h := newAIHarness(t, nil)
	ctx := context.Background()
	var sid string
	if err := h.pool.QueryRow(ctx, `SELECT "subjectId" FROM "Material" WHERE id=$1`, h.material).Scan(&sid); err != nil {
		t.Fatal(err)
	}
	_, err := h.pool.Exec(ctx, `UPDATE "User" SET grade='고2' WHERE id=$1`, h.student)
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.pool.Exec(ctx, `UPDATE "Subject" SET name='생명과학' WHERE id=$1`, sid)
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.pool.Exec(ctx, `INSERT INTO "Question"(id,"userId","subjectId","materialId",prompt,options,answer,explanation,citation,past,future) VALUES('curriculum-q',$1,$2,$3,'신경계와 내분비계의 항상성 조절은?',ARRAY['항상성 유지','없음'],0,'신경계와 내분비계는 항상성을 유지한다.','신경 세포의 구조와 기능을 이해한다.','','')`, h.student, sid, h.material)
	if err != nil {
		t.Fatal(err)
	}
	got := communityData(t, h.do("GET", "/api/quiz/connections?questionId=curriculum-q", nil), 200)
	if got["coverage"] != "matched" {
		t.Fatal(got)
	}
	if rec := h.do("GET", "/api/quiz/connections?questionId=not-owned", nil); rec.Code != 404 {
		t.Fatal(rec.Code)
	}
}
