-- +goose Up
-- A material's summary (content hash and excerpt) is stored when its text changes instead of
-- being recomputed for every bootstrap: hashing and normalising every material's whole text on
-- each request scaled with the student's data (measured in docs/SERVER_REVIEW.md #15).
ALTER TABLE "Material" ADD COLUMN "contentHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Material" ADD COLUMN "excerpt" TEXT NOT NULL DEFAULT '';
UPDATE "Material" SET
  "contentHash" = encode(sha256(convert_to("content", 'UTF8')), 'hex'),
  "excerpt" = left(btrim(regexp_replace("content", '\s+', ' ', 'g')), 160);

-- +goose Down
ALTER TABLE "Material" DROP COLUMN IF EXISTS "excerpt";
ALTER TABLE "Material" DROP COLUMN IF EXISTS "contentHash";
