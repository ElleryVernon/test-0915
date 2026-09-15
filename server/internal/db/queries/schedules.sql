-- name: DeleteSchedule :execrows
DELETE FROM "Schedule" WHERE "id" = $1 AND "userId" = $2;

-- name: GetOwnedSchedule :one
SELECT * FROM "Schedule" WHERE "id" = $1 AND "userId" = $2;

-- name: ListSchedulesOnDate :many
SELECT * FROM "Schedule" WHERE "userId" = $1 AND "date" = $2 AND "id" <> $3 ORDER BY "start" ASC;

-- name: CreateSchedule :one
INSERT INTO "Schedule" ("id", "userId", "title", "date", "start", "end", "kind", "subjectId", "done")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *;

-- name: UpdateSchedule :one
UPDATE "Schedule" SET "title" = $2, "date" = $3, "start" = $4, "end" = $5, "kind" = $6, "subjectId" = $7, "done" = $8
WHERE "id" = $1 RETURNING *;
