-- name: CreateCard :one
INSERT INTO "Card" ("id", "userId", "subjectId", "front", "back", "type", "image", "masks")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *;

-- name: GetOwnedCard :one
SELECT c.* FROM "Card" AS c JOIN "Subject" AS s ON s."id" = c."subjectId"
WHERE c."id" = $1 AND c."userId" = $2 AND s."deleted" = false;

-- name: GetOwnedLiveCard :one
SELECT c.* FROM "Card" AS c JOIN "Subject" AS s ON s."id" = c."subjectId"
WHERE c."id" = $1 AND c."userId" = $2 AND c."deleted" = false AND s."deleted" = false;

-- name: UpdateCardFields :one
UPDATE "Card" SET
  "deleted" = COALESCE(sqlc.narg('deleted')::bool, "deleted"),
  "front" = COALESCE(sqlc.narg('front')::text, "front"),
  "back" = COALESCE(sqlc.narg('back')::text, "back")
WHERE "id" = @id RETURNING *;

-- name: GetCardReview :one
SELECT * FROM "CardReview" WHERE "id" = $1;

-- name: LastCardReviewAt :one
SELECT "createdAt" FROM "CardReview" WHERE "cardId" = $1 AND "userId" = $2 ORDER BY "createdAt" DESC LIMIT 1;

-- name: UpdateCardSchedule :one
UPDATE "Card" SET "bucket" = $2, "consecutiveEasy" = $3, "nextReviewAt" = $4, "fsrs" = $5 WHERE "id" = $1 RETURNING *;

-- name: CreateCardReview :exec
INSERT INTO "CardReview" ("id", "userId", "cardId", "rating", "result", "createdAt") VALUES ($1, $2, $3, $4, $5, $6);

-- name: GetUserPrefs :one
SELECT "srsMode", "desiredRetention" FROM "User" WHERE "id" = $1;

-- name: ListWrongQuestions :many
SELECT q.* FROM "Question" AS q JOIN "Subject" AS s ON s."id" = q."subjectId"
WHERE q."id" = ANY(@ids::text[]) AND q."userId" = @user_id AND s."deleted" = false
  AND EXISTS (SELECT 1 FROM "Attempt" AS a WHERE a."questionId" = q."id" AND a."userId" = @user_id AND a."correct" = false);

-- name: UpsertWrongNoteCard :one
INSERT INTO "Card" ("id", "userId", "subjectId", "front", "back", "sourceQuestionId")
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT ("userId", "sourceQuestionId", "sourceKind") DO UPDATE SET "deleted" = false
RETURNING *;

-- name: GetOwnedImageUpload :one
SELECT "id" FROM "Upload" WHERE "id" = $1 AND "userId" = $2 AND "mime" LIKE 'image/%';
