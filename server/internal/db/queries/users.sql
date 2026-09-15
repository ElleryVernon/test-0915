-- name: GetUser :one
SELECT * FROM "User" WHERE "id" = $1;

-- name: GetUserForUpdate :one
SELECT * FROM "User" WHERE "id" = $1 FOR UPDATE;

-- name: CreateUser :one
INSERT INTO "User" ("id", "name", "nickname", "role") VALUES ($1, $2, $3, $4) RETURNING *;

-- name: UpdateUserSuspended :one
UPDATE "User" SET "suspended" = $2 WHERE "id" = $1 RETURNING "id", "suspended";

-- name: SetSelectedChild :exec
UPDATE "User" SET "selectedChildId" = $2 WHERE "id" = $1;

-- name: CountUsers :one
SELECT count(*) FROM "User";
