-- name: ExpireStaleRuns :exec
UPDATE "AiRun" SET "status" = 'INTERRUPTED', "error" = @error, "errorStatus" = 409, "finishedAt" = @now, "updatedAt" = @now
WHERE "userId" = @user_id AND "status" = 'RUNNING' AND "updatedAt" < @stale_before;

-- name: GetAiRun :one
SELECT * FROM "AiRun" WHERE "userId" = $1 AND "requestId" = $2;

-- name: CreateAiRun :exec
INSERT INTO "AiRun" ("id", "userId", "requestId", "kind", "inputHash", "skillVersion", "model", "status", "steps", "startedAt", "updatedAt")
VALUES ($1, $2, $3, $4, $5, $6, $7, 'RUNNING', '[]', $8, $8);

-- name: UpdateAiRunSteps :execrows
UPDATE "AiRun" SET "steps" = $2, "updatedAt" = $3 WHERE "id" = $1 AND "status" = 'RUNNING';

-- name: LockAiRun :one
SELECT * FROM "AiRun" WHERE "id" = $1 FOR UPDATE;

-- name: CompleteAiRun :exec
UPDATE "AiRun" SET "status" = 'COMPLETED', "result" = $2, "steps" = $3, "finishedAt" = $4, "updatedAt" = $4 WHERE "id" = $1;

-- name: FailAiRun :execrows
UPDATE "AiRun" SET "status" = 'FAILED', "error" = $2, "errorStatus" = $3, "finishedAt" = $4, "updatedAt" = $4 WHERE "id" = $1 AND "status" = 'RUNNING';

-- name: InterruptAiRun :execrows
-- A run cut short by this instance's shutdown: the device learns on its next poll, with a retry hint.
UPDATE "AiRun" SET "status" = 'INTERRUPTED', "error" = $2, "errorStatus" = 503, "finishedAt" = $3, "updatedAt" = $3 WHERE "id" = $1 AND "status" = 'RUNNING';
