-- name: GetSessionUser :one
SELECT s."id" AS session_id, s."expiresAt" AS session_expires, s."createdAt" AS session_created, sqlc.embed(u)
FROM "Session" AS s JOIN "User" AS u ON u."id" = s."userId"
WHERE s."id" = $1;

-- name: CreateSession :exec
INSERT INTO "Session" ("id", "userId", "expiresAt") VALUES ($1, $2, $3);

-- name: DeleteSession :exec
DELETE FROM "Session" WHERE "id" = $1;

-- name: DeleteExpiredSessions :exec
DELETE FROM "Session" WHERE "userId" = $1 AND "expiresAt" < now();

-- name: DeleteUserSessions :exec
DELETE FROM "Session" WHERE "userId" = $1;

-- name: RenewSession :one
-- Moves the session's expiry forward, never backwards (concurrent requests may renew together).
UPDATE "Session" SET "expiresAt" = GREATEST("expiresAt", @expires_at) WHERE "id" = @id RETURNING "expiresAt";
