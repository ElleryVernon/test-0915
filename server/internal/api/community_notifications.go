package api

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/store"
)

// Community notification kinds — in-app only; nothing here leaves the notifications list.
const (
	notifyFirstAnswer = "FIRST_ANSWER"
	notifyMoreAnswers = "MORE_ANSWERS"
	notifyAccepted    = "ACCEPTED"
	notifyAcceptAsk   = "ACCEPT_ASK"
	notifyDigest      = "FOLLOWING_DIGEST"
)

// notifyAnswers records the spec's two-step answer notice: the first reply earns FIRST_ANSWER,
// later replies fold into a single unread MORE_ANSWERS bundle whose count is refreshed in place.
// Call inside the comment transaction; count is the number of other people's comments before
// this one, so count>0 means the first answer was already announced.
func notifyAnswers(ctx context.Context, tx pgx.Tx, post store.Post, others int) error {
	href := communityPostHref(post)
	firstTitle, moreBody := "첫 답변이 도착했어요", fmt.Sprintf("답변이 %d개 더 왔어요", others)
	if post.Role == store.RolePARENT {
		firstTitle, moreBody = "내 글에 댓글이 달렸어요", fmt.Sprintf("새 댓글이 %d개 더 달렸어요", others)
	}
	if others == 0 {
		_, err := tx.Exec(ctx,
			`INSERT INTO "Notification"("id","userId","title","body","href","kind") VALUES($1,$2,$6,$3,$4,$5)`,
			ids.New(), post.UserID, post.Title, href, notifyFirstAnswer, firstTitle)
		return err
	}
	tag, err := tx.Exec(ctx,
		`UPDATE "Notification" SET "body"=$3,"createdAt"=now(),"read"=false WHERE "id"=(
		 SELECT "id" FROM "Notification" WHERE "userId"=$1 AND "kind"=$4 AND "href"=$2 AND NOT "read"
		 ORDER BY "createdAt" DESC LIMIT 1)`,
		post.UserID, href, moreBody, notifyMoreAnswers)
	if err != nil || tag.RowsAffected() > 0 {
		return err
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO "Notification"("id","userId","title","body","href","kind") VALUES($1,$2,$5,$3,$4,$6)`,
		ids.New(), post.UserID, moreBody, href, post.Title, notifyMoreAnswers)
	return err
}

// communityNudges materialises the spec's two scheduled notices lazily: they appear the first
// time the account's bootstrap is rebuilt after their moment — the 7-day "해결됐나요?" ask and the
// 21:00 KST following digest (which also carries same-day card clones of the caller's cards).
// Both inserts carry deterministic ids, so a repeat build is a no-op.
func (s *Server) communityNudges(ctx context.Context, u store.User) error {
	if u.Role != store.RoleSTUDENT {
		return nil
	}
	return s.locked(ctx, u.ID, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := tx.Exec(ctx, `
INSERT INTO "Notification"("id","userId","title","body","href","kind")
SELECT 'nudge-accept-' || p."id", p."userId", '해결됐나요?',
	(now()::date - p."createdAt"::date) || '일 전 질문 · 답변 ' || c.n || '개가 기다려요',
	CASE WHEN p."school"<>'' THEN '/community?space=school&post=' ELSE '/community?post=' END || p."id",
	$1
FROM "Post" p
JOIN "CommunityPost" cp ON cp."postId"=p."id" AND NOT cp."deleted"
JOIN LATERAL (SELECT count(*) AS n FROM "Comment" c WHERE c."postId"=p."id" AND c."userId"<>p."userId") c ON true
WHERE p."userId"=$2 AND p."role"='STUDENT' AND p."category"='질문' AND cp."acceptedCommentId" IS NULL
	AND p."createdAt" < now() - interval '7 days' AND c.n > 0
ON CONFLICT ("id") DO NOTHING`, notifyAcceptAsk, u.ID); err != nil {
			return err
		}
		now := s.now().In(seoul)
		if now.Hour() < 21 {
			return nil
		}
		today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, seoul)
		var posts, cards, answers, clones int
		err := tx.QueryRow(ctx, `
WITH followees AS (SELECT "followingId" AS id FROM "Follow" WHERE "followerId"=$1)
SELECT
	(SELECT count(*) FROM "Post" p JOIN "CommunityPost" cp ON cp."postId"=p."id" AND NOT cp."deleted"
		JOIN followees f ON f.id=p."userId"
		WHERE NOT p."anonymous" AND p."role"='STUDENT' AND p."createdAt">=$2),
	(SELECT count(*) FROM "Card" c JOIN "CommunityCard" cc ON cc."cardId"=c."id" AND cc."public"
		JOIN followees f ON f.id=c."userId" WHERE NOT c."deleted" AND c."createdAt">=$2),
	(SELECT count(*) FROM "Comment" c JOIN "CommunityPost" cp ON cp."acceptedCommentId"=c."id"
		JOIN "Post" p ON p."id"=cp."postId" AND NOT cp."deleted"
		JOIN followees f ON f.id=c."userId" WHERE cp."solvedAt">=$2),
	(SELECT count(*) FROM "CommunityCardClone" cc JOIN "Card" c ON c."id"=cc."sourceCardId"
		JOIN "Card" copy ON copy."id"=cc."cardId"
		WHERE c."userId"=$1 AND cc."userId"<>$1 AND copy."createdAt">=$2)
	+ (SELECT count(*) FROM "CommunityAction" a
		JOIN "CommunityPost" cp ON cp."postId"=a."postId" AND NOT cp."deleted"
		JOIN "Post" p ON p."id"=a."postId" AND p."userId"=$1
		WHERE a."kind"='clone' AND a."userId"<>$1 AND a."createdAt">=$2)`,
			// Database timestamps store UTC without a time zone. pgx preserves the
			// wall-clock fields, so convert the Korean day boundary before binding.
			u.ID, today.UTC()).Scan(&posts, &cards, &answers, &clones)
		if err != nil {
			return err
		}
		if posts+cards+answers+clones == 0 {
			return nil
		}
		parts := []string{}
		if posts > 0 {
			parts = append(parts, fmt.Sprintf("새 글 %d개", posts))
		}
		if cards > 0 {
			parts = append(parts, fmt.Sprintf("공개 카드 %d장", cards))
		}
		if answers > 0 {
			parts = append(parts, fmt.Sprintf("채택된 답변 %d개", answers))
		}
		if clones > 0 {
			parts = append(parts, fmt.Sprintf("내 카드 담김 %d건", clones))
		}
		body := "팔로잉의 오늘 소식 · "
		for i, part := range parts {
			if i > 0 {
				body += " · "
			}
			body += part
		}
		_, err = tx.Exec(ctx,
			`INSERT INTO "Notification"("id","userId","title","body","href","kind") VALUES($1,$2,'팔로잉 소식이 모였어요',$3,'/community',$4) ON CONFLICT ("id") DO NOTHING`,
			"nudge-digest-"+u.ID+"-"+dateKey(now), u.ID, body, notifyDigest)
		return err
	})
}
