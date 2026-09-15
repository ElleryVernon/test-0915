-- name: CreateMaterial :one
INSERT INTO "Material" ("id", "userId", "subjectId", "title", "content", "type", "url", "uploadId", "pageBreaks", "extraction", "contentHash", "excerpt")
VALUES ($1, $2, $3, $4, @content, $5, $6, $7, $8, $9,
  encode(sha256(convert_to(@content, 'UTF8')), 'hex'), left(btrim(regexp_replace(@content, '\s+', ' ', 'g')), 160))
RETURNING *;

-- name: GetOwnedMaterial :one
SELECT m.* FROM "Material" AS m JOIN "Subject" AS s ON s."id" = m."subjectId"
WHERE m."id" = $1 AND m."userId" = $2 AND s."deleted" = false;

-- name: GetMaterialContent :one
SELECT "content", "subjectId" FROM "Material" AS m JOIN "Subject" AS s ON s."id" = m."subjectId"
WHERE m."id" = $1 AND m."userId" = $2 AND s."deleted" = false;

-- name: UpdateMaterial :one
UPDATE "Material" SET
  "title" = COALESCE(sqlc.narg('title')::text, "title"),
  "content" = COALESCE(sqlc.narg('content')::text, "content"),
  "contentHash" = CASE WHEN sqlc.narg('content')::text IS NULL THEN "contentHash" ELSE encode(sha256(convert_to(sqlc.narg('content')::text, 'UTF8')), 'hex') END,
  "excerpt" = CASE WHEN sqlc.narg('content')::text IS NULL THEN "excerpt" ELSE left(btrim(regexp_replace(sqlc.narg('content')::text, '\s+', ' ', 'g')), 160) END,
  "pageBreaks" = CASE WHEN @set_pages::bool THEN @page_breaks::int[] ELSE "pageBreaks" END,
  "extraction" = CASE WHEN @set_pages::bool THEN sqlc.narg('extraction')::text ELSE "extraction" END
WHERE "id" = @id RETURNING *;

-- name: DeleteMaterial :exec
DELETE FROM "Material" WHERE "id" = $1;

-- name: GetUploadMeta :one
SELECT "id", "userId", "mime", "name", "size", "sha256", "pages", "pageBreaks", "extraction", "textHash", "createdAt" FROM "Upload" WHERE "id" = $1;

-- name: GetOwnedUploadWithMaterial :one
SELECT u."id", u."mime", u."pages", u."pageBreaks", u."extraction", u."textHash", m."id" AS material_id
FROM "Upload" AS u LEFT JOIN "Material" AS m ON m."uploadId" = u."id"
WHERE u."id" = $1 AND u."userId" = $2;

-- name: ListUploadImages :many
SELECT "id", "page", "order", "paragraph", "anchor", "x", "y", "w", "h", "width", "height", "mime", "context"
FROM "UploadImage" WHERE "uploadId" = $1 ORDER BY "page" ASC, "order" ASC;

-- name: GetOwnedSampleMaterial :one
-- The sample chapter is marked by its extraction value, never matched by title (a learner may
-- have a material of their own with the same title).
SELECT m.* FROM "Material" AS m JOIN "Subject" AS s ON s."id" = m."subjectId"
WHERE m."userId" = $1 AND m."extraction" = 'sample' AND s."deleted" = false
ORDER BY m."createdAt" DESC LIMIT 1;
