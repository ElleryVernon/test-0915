-- name: GetOwnedQuestion :one
SELECT q.* FROM "Question" AS q JOIN "Subject" AS s ON s."id" = q."subjectId"
WHERE q."id" = $1 AND q."userId" = $2 AND s."deleted" = false;

-- name: GetOwnedEssay :one
SELECT e.* FROM "Essay" AS e JOIN "Subject" AS s ON s."id" = e."subjectId"
WHERE e."id" = $1 AND e."userId" = $2 AND s."deleted" = false;

-- name: CreateAttempt :one
INSERT INTO "Attempt" ("id", "userId", "questionId", "essayId", "answer", "correct", "score")
VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;

-- name: ListLiveSubjects :many
SELECT * FROM "Subject" WHERE "userId" = $1 AND "deleted" = false ORDER BY "createdAt" ASC;

-- name: ListLiveCardsForPlanner :many
SELECT "subjectId", "bucket", "nextReviewAt", "fsrs", "deleted" FROM "Card" WHERE "userId" = $1 AND "deleted" = false;

-- name: CreateQuestion :one
INSERT INTO "Question" ("id", "userId", "subjectId", "materialId", "prompt", "options", "answer", "explanation", "citation", "past", "future")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *;

-- name: CreateEssay :one
INSERT INTO "Essay" ("id", "userId", "subjectId", "materialId", "prompt", "keywords", "distractors", "modelAnswer", "citation")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *;

-- name: CreateGeneratedCard :one
INSERT INTO "Card" ("id", "userId", "subjectId", "front", "back", "type", "materialId") VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;
