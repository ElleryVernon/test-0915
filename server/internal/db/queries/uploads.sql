-- name: CreateUpload :exec
INSERT INTO "Upload" ("id", "userId", "mime", "name", "size", "sha256", "pages", "pageBreaks", "extraction", "textHash")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);

-- name: CreateUploadImage :exec
INSERT INTO "UploadImage" ("id", "uploadId", "page", "order", "paragraph", "anchor", "x", "y", "w", "h", "width", "height", "mime", "context")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14);

-- name: GetOwnedUpload :one
SELECT "id", "mime", "name", "size", "sha256" FROM "Upload" WHERE "id" = $1 AND "userId" = $2;

-- name: SetUploadSha :exec
UPDATE "Upload" SET "sha256" = $2 WHERE "id" = $1;

-- name: GetOwnedUploadImage :one
SELECT i."id", i."mime" FROM "UploadImage" AS i JOIN "Upload" AS u ON u."id" = i."uploadId"
WHERE i."id" = $1 AND i."uploadId" = $2 AND u."userId" = $3;

-- name: ListStaleUnlinkedUploads :many
SELECT u."id" FROM "Upload" AS u LEFT JOIN "Material" AS m ON m."uploadId" = u."id"
WHERE u."userId" = $1 AND u."createdAt" < $2 AND m."id" IS NULL;

-- name: ListCardImagesIn :many
SELECT "image" FROM "Card" WHERE "userId" = $1 AND "image" = ANY(@urls::text[]);

-- name: ListMaterialUrlsIn :many
SELECT "url" FROM "Material" WHERE "userId" = $1 AND "url" = ANY(@urls::text[]);

-- name: DeleteUploads :exec
DELETE FROM "Upload" WHERE "userId" = $1 AND "id" = ANY(@ids::text[]);

-- name: DeleteOwnedUpload :execrows
DELETE FROM "Upload" WHERE "id" = $1 AND "userId" = $2;
