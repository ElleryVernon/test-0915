-- name: GetOAuthAccountUser :one
SELECT a."id" AS account_id, sqlc.embed(u)
FROM "OAuthAccount" AS a JOIN "User" AS u ON u."id" = a."userId"
WHERE a."provider" = $1 AND a."providerId" = $2;

-- name: CreateOAuthAccount :exec
INSERT INTO "OAuthAccount" ("id", "provider", "providerId", "userId") VALUES ($1, $2, $3, $4);
