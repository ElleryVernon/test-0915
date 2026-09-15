-- Admin: the moderation overview, report triage and the school directory (api.ts admin).
-- Suspending an account uses UpdateUserSuspended from users.sql.

-- name: ListAdminUsers :many
SELECT "id", "name", "nickname", "role", "suspended"
FROM "User"
ORDER BY "createdAt" DESC
LIMIT 500;

-- name: ListAdminReports :many
SELECT sqlc.embed(r), p."title" AS post_title
FROM "Report" AS r JOIN "Post" AS p ON p."id" = r."postId"
ORDER BY r."createdAt" DESC
LIMIT 500;

-- name: ListAdminSchools :many
SELECT * FROM "School"
ORDER BY "name" ASC
LIMIT 1000;

-- name: UpdateReportStatus :one
UPDATE "Report" SET "status" = $2 WHERE "id" = $1 RETURNING *;

-- name: CreateSchool :one
INSERT INTO "School" ("id", "name") VALUES ($1, $2) RETURNING *;
