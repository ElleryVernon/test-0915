-- name: ListSweepableUploads :many
-- Uploads older than the cutoff that nothing uses: no material row points at them and neither a
-- material url nor a card image still names their bytes.
SELECT u."id" FROM "Upload" AS u
LEFT JOIN "Material" AS m ON m."uploadId" = u."id"
WHERE u."createdAt" < $1 AND m."id" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Material" AS mm WHERE mm."url" = '/api/uploads/' || u."id")
  AND NOT EXISTS (SELECT 1 FROM "Card" AS c WHERE c."image" = '/api/uploads/' || u."id")
ORDER BY u."createdAt";

-- name: DeleteUploadImagesByUpload :execrows
DELETE FROM "UploadImage" WHERE "uploadId" = ANY(@ids::text[]);

-- name: DeleteUploadsByID :execrows
DELETE FROM "Upload" WHERE "id" = ANY(@ids::text[]);

-- name: ListUploadIDs :many
SELECT "id" FROM "Upload";
