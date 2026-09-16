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

-- name: SetQuestionExplanation :exec
UPDATE "Question" SET "learningExplanation" = $2 WHERE "id" = $1;

-- name: SetAttemptMetadata :exec
UPDATE "Attempt" SET "responseMs" = $2, "requestId" = $3 WHERE "id" = $1;

-- name: GetAttemptByRequest :one
SELECT * FROM "Attempt" WHERE "userId" = $1 AND "requestId" = $2;

-- name: GetOwnedAttempt :one
SELECT * FROM "Attempt" WHERE "id" = $1 AND "userId" = $2 AND "questionId" = $3;

-- name: UpdateReflection :one
UPDATE "Attempt" SET "beatsSeen" = GREATEST("beatsSeen", @beats_seen), "explainDepth" = @depth,
 "microResult" = CASE WHEN "microResult" IN ('PASS', 'FAIL') THEN "microResult" ELSE COALESCE(sqlc.narg('micro_result')::text, "microResult") END,
 "divergenceNodeId" = COALESCE(sqlc.narg('node_id')::text, "divergenceNodeId")
WHERE "id" = @id AND "userId" = @user_id AND "questionId" = @question_id RETURNING *;

-- name: CreateExplanationReport :exec
INSERT INTO "ExplanationReport" ("id", "userId", "questionId", "nodeId", "reason") VALUES ($1,$2,$3,$4,$5)
ON CONFLICT ("userId", "questionId", "nodeId", "reason") DO NOTHING;

-- name: UpsertExplanationCard :one
INSERT INTO "Card" ("id", "userId", "subjectId", "front", "back", "type", "sourceQuestionId", "materialId", "diagram", "maskedNodeIds", "sourceDiagramId", "sourceKind")
VALUES ($1,$2,$3,$4,$5,'BLIND',$6,$7,$8,$9,$10,'DIAGRAM')
ON CONFLICT ("userId", "sourceQuestionId", "sourceKind") DO UPDATE SET "deleted" = false
RETURNING *;
