-- name: CreateSubject :one
INSERT INTO "Subject" ("id", "userId", "name", "examName", "examDate") VALUES ($1, $2, $3, $4, $5) RETURNING *;

-- name: UpdateSubject :one
UPDATE "Subject" SET
  "name" = COALESCE(sqlc.narg('name')::text, "name"),
  "examName" = CASE WHEN @set_exam_name::bool THEN sqlc.narg('exam_name')::text ELSE "examName" END,
  "examDate" = CASE WHEN @set_exam_date::bool THEN sqlc.narg('exam_date')::text ELSE "examDate" END
WHERE "id" = @id RETURNING *;

-- name: SoftDeleteSubject :one
UPDATE "Subject" SET "deleted" = true WHERE "id" = $1 RETURNING *;

-- name: GetOwnedSubjectByName :one
SELECT * FROM "Subject" WHERE "userId" = $1 AND "name" = $2 AND "deleted" = false
ORDER BY "createdAt" ASC LIMIT 1;
