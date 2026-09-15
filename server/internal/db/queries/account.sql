-- name: UpdateProfile :one
-- A NULL argument keeps the column, so the handler sends only the fields the client provided,
-- exactly like the previous server's partial update.
UPDATE "User" SET
    "name" = COALESCE(sqlc.narg('name')::text, "name"),
    "nickname" = COALESCE(sqlc.narg('nickname')::text, "nickname"),
    "school" = COALESCE(sqlc.narg('school')::text, "school"),
    "grade" = COALESCE(sqlc.narg('grade')::text, "grade"),
    "privacy" = COALESCE(sqlc.narg('privacy')::jsonb, "privacy"),
    "completedSubjects" = COALESCE(sqlc.narg('completed_subjects')::text[], "completedSubjects"),
    "srsMode" = COALESCE(sqlc.narg('srs_mode')::text, "srsMode"),
    "desiredRetention" = COALESCE(sqlc.narg('desired_retention')::double precision, "desiredRetention")
WHERE "id" = @id
RETURNING *;

-- name: MarkNotificationsRead :exec
UPDATE "Notification" SET "read" = true WHERE "userId" = $1;
