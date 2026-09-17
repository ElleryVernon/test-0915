package api

import (
	"context"
	"testing"
	"time"
)

func TestQuestionFollowupCardIsOwnedIdempotentAndDueToday(t *testing.T) {
	h := newAIHarness(t, nil)
	ctx := context.Background()
	var subject string
	if err := h.pool.QueryRow(ctx, `SELECT "subjectId" FROM "Material" WHERE "id"=$1`, h.material).Scan(&subject); err != nil {
		t.Fatal(err)
	}
	_, err := h.pool.Exec(ctx, `INSERT INTO "Question"("id","userId","subjectId","materialId","prompt","options","answer","explanation","citation","past","future") VALUES('followup-q',$1,$2,$3,'효소의 역할은?',ARRAY['반응 속도 증가','반응 속도 감소'],0,'활성화 에너지를 낮춘다.','효소는 활성화 에너지를 낮춘다.','','')`, h.student, subject, h.material)
	if err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"questionId": "followup-q"}
	first := communityData(t, h.do("POST", "/api/quiz/review-card", payload), 200)
	id := first["id"].(string)
	if first["bucket"] != "AGAIN" {
		t.Fatal("not in AGAIN queue", first)
	}
	if _, err = h.pool.Exec(ctx, `UPDATE "Card" SET "nextReviewAt"=now()+interval '7 days',"bucket"='MASTERED',"consecutiveEasy"=2 WHERE "id"=$1`, id); err != nil {
		t.Fatal(err)
	}
	repeated := communityData(t, h.do("POST", "/api/quiz/review-card", payload), 200)
	if repeated["id"] != id || repeated["bucket"] != "AGAIN" {
		t.Fatal("duplicate or not requeued", repeated)
	}
	due, err := time.Parse(time.RFC3339Nano, repeated["nextReviewAt"].(string))
	if err != nil || due.After(time.Now().Add(time.Second)) {
		t.Fatal("must be due now", due, time.Now(), due.Sub(time.Now()), err)
	}
	var count, attempts, reviews int
	if err = h.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM "Card" WHERE "userId"=$1),(SELECT count(*) FROM "Attempt" WHERE "userId"=$1),(SELECT count(*) FROM "CardReview" WHERE "userId"=$1)`, h.student).Scan(&count, &attempts, &reviews); err != nil {
		t.Fatal(err)
	}
	if count != 1 || attempts != 0 || reviews != 0 {
		t.Fatal("practice fabricated history", count, attempts, reviews)
	}
	if rec := h.do("POST", "/api/quiz/review-card", map[string]any{"questionId": "another-users-question"}); rec.Code != 404 {
		t.Fatal("missing ownership check", rec.Code)
	}
}
