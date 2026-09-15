-- name: SweepInvites :exec
-- A student's earlier codes and everyone's expired ones go before a new code is issued.
DELETE FROM "Invite" WHERE "studentId" = @student_id OR "expiresAt" < @now;

-- name: InviteCodeExists :one
SELECT EXISTS (SELECT 1 FROM "Invite" WHERE "code" = $1);

-- name: CreateInvite :exec
INSERT INTO "Invite" ("code", "studentId", "expiresAt") VALUES ($1, $2, $3);

-- name: GetInviteStudent :one
SELECT sqlc.embed(i), sqlc.embed(u)
FROM "Invite" AS i JOIN "User" AS u ON u."id" = i."studentId"
WHERE i."code" = $1;

-- name: ConsumeInvite :execrows
DELETE FROM "Invite" WHERE "code" = @code AND "expiresAt" > @now;

-- name: SetLinkState :exec
UPDATE "User" SET "linkFailures" = $2, "linkLockedUntil" = $3 WHERE "id" = $1;

-- name: LinkSucceeded :exec
UPDATE "User" SET "linkFailures" = 0, "linkLockedUntil" = NULL, "selectedChildId" = $2 WHERE "id" = $1;

-- name: UpsertParentLink :exec
INSERT INTO "ParentLink" ("parentId", "studentId") VALUES ($1, $2) ON CONFLICT DO NOTHING;

-- name: GetParentLink :one
SELECT * FROM "ParentLink" WHERE "parentId" = $1 AND "studentId" = $2;

-- name: DeleteParentLink :exec
DELETE FROM "ParentLink" WHERE "parentId" = $1 AND "studentId" = $2;

-- name: ListChildren :many
SELECT u.* FROM "ParentLink" AS l JOIN "User" AS u ON u."id" = l."studentId"
WHERE l."parentId" = $1
ORDER BY l."createdAt" ASC;

-- name: CountMasteredCards :one
SELECT count(*) FROM "Card" AS c JOIN "Subject" AS s ON s."id" = c."subjectId"
WHERE c."userId" = $1 AND c."bucket" = 'MASTERED' AND c."deleted" = false AND s."deleted" = false;

-- name: CountWeeklyQuestions :one
SELECT count(*) FROM "Attempt" WHERE "userId" = @user_id AND "createdAt" >= @since AND "questionId" IS NOT NULL;

-- name: CountStudyDaysSince :one
-- Distinct Seoul calendar dates with an attempt or a card review since @since (stored timestamps are UTC).
SELECT count(DISTINCT d.day) FROM (
    SELECT to_char((a."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS day
    FROM "Attempt" AS a WHERE a."userId" = @user_id::text AND a."createdAt" >= @since::timestamp
    UNION ALL
    SELECT to_char((r."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS day
    FROM "CardReview" AS r WHERE r."userId" = @user_id::text AND r."createdAt" >= @since::timestamp
) AS d;

-- name: SubjectAttemptStats :many
-- Every live subject of the student with the student's attempts on that subject's questions.
SELECT s."id", s."name",
    count(a."id")::int AS count,
    (count(a."id") FILTER (WHERE a."correct"))::int AS correct
FROM "Subject" AS s
LEFT JOIN "Question" AS q ON q."subjectId" = s."id"
LEFT JOIN "Attempt" AS a ON a."questionId" = q."id" AND a."userId" = @user_id
WHERE s."userId" = @user_id AND s."deleted" = false
GROUP BY s."id", s."name", s."createdAt"
ORDER BY s."createdAt" ASC, s."id" ASC;

-- name: AddPoints :exec
UPDATE "User" SET "points" = "points" + $2 WHERE "id" = $1;

-- name: CreateNotification :exec
INSERT INTO "Notification" ("id", "userId", "title", "body", "href") VALUES ($1, $2, $3, $4, $5);

-- name: CreateCheer :one
INSERT INTO "Cheer" ("id", "senderId", "recipientId", "message", "points") VALUES ($1, $2, $3, $4, $5) RETURNING *;

-- name: ThankCheer :execrows
UPDATE "Cheer" SET "thanked" = true WHERE "id" = $1 AND "recipientId" = $2;
