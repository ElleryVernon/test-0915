package api

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"memoryz/server/internal/store"
)

const notifyChildLearning = "CHILD_LEARNING"

// Parent activity is derived from a submitted answer or a completed card review,
// never a page view or generated content. A parent sees only activity after linking
// and only when the student shares learning time/activity. One notice per child/day.
func (s *Server) parentActivity(ctx context.Context, user store.User) error {
	if user.Role != store.RolePARENT {
		return nil
	}
	now := s.now().In(seoul)
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, seoul).UTC()
	changed := false
	err := s.locked(ctx, user.ID, func(tx pgx.Tx, _ *store.Queries) error {
		// Revocation applies to old notices as well as future activity.
		removed, err := tx.Exec(ctx, `DELETE FROM "Notification" n USING "ParentLearningNotice" a
   WHERE n."id"=a."notificationId" AND n."userId"=$1 AND NOT EXISTS (
    SELECT 1 FROM "ParentLink" l JOIN "User" u ON u."id"=l."studentId"
    WHERE l."parentId"=$1 AND l."studentId"=a."studentId" AND u."role"='STUDENT' AND u."privacy"->>'time'='true')`, user.ID)
		if err != nil {
			return err
		}
		changed = removed.RowsAffected() > 0
		// Catch up a week of actual activity when a parent returns the next day.
		// Each notice keeps its completion date/time; it never relabels old work as today's.
		added, err := tx.Exec(ctx, `WITH linked AS (
   SELECT u."id", u."name", l."createdAt" FROM "ParentLink" l JOIN "User" u ON u."id"=l."studentId"
   WHERE l."parentId"=$1 AND u."role"='STUDENT' AND u."privacy"->>'time'='true'
   ), activities AS (
    SELECT l."id",l."name",a."createdAt",'문제 풀이' AS action FROM linked l JOIN "Attempt" a ON a."userId"=l."id"
     WHERE a."createdAt">=GREATEST($2,l."createdAt") AND a."createdAt"<$3 AND (a."questionId" IS NOT NULL OR a."essayId" IS NOT NULL)
    UNION ALL
    SELECT l."id",l."name",c."createdAt",'카드 복습' AS action FROM linked l JOIN "CardReview" c ON c."userId"=l."id"
     WHERE c."createdAt">=GREATEST($2,l."createdAt") AND c."createdAt"<$3
   ), eligible AS (
    SELECT "id","name",("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul')::date AS day,
     min("createdAt") AS completed, string_agg(DISTINCT action,'와 ' ORDER BY action) AS actions
    FROM activities GROUP BY "id","name",day
   ), inserted AS (
    INSERT INTO "Notification"("id","userId","title","body","href","kind","createdAt")
    SELECT 'child-learning-' || md5($1 || ':' || e."id" || ':' || e.day::text), $1,
      e."name" || '의 학습 소식', to_char(e.day,'FMMM월 FMDD일') || ' · ' || e.actions || ' 완료. 작은 성장을 응원해 주세요.',
      '/parent?child=' || e."id", $4, e.completed FROM eligible e ON CONFLICT("id") DO NOTHING RETURNING "id"
   ) INSERT INTO "ParentLearningNotice"("notificationId","studentId","day")
     SELECT i."id", e."id", e.day FROM inserted i JOIN eligible e ON i."id"='child-learning-' || md5($1 || ':' || e."id" || ':' || e.day::text)`, user.ID, start.AddDate(0, 0, -6), s.clock().Add(time.Millisecond), notifyChildLearning)
		changed = changed || added.RowsAffected() > 0
		return err
	})
	if err == nil && changed {
		s.bump(ctx, user.ID)
	}
	return err
}
