-- name: GetOwnedSubject :one
SELECT * FROM "Subject" WHERE "id" = $1 AND "userId" = $2 AND "deleted" = false;

-- name: SelectedChild :one
SELECT u.* FROM "ParentLink" AS l JOIN "User" AS u ON u."id" = l."studentId"
WHERE l."parentId" = @parent_id AND (@selected_id::text = '' OR l."studentId" = @selected_id::text)
ORDER BY l."createdAt" ASC
LIMIT 1;
