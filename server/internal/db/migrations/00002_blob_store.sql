-- +goose Up
-- File bytes move behind the blob store interface. The Postgres driver keeps them in ops.blob,
-- keyed like the object store (uploads/<uploadId>, uploads/<uploadId>/images/<imageId>), so the
-- handlers never know which driver is configured. Bytes already in UploadBlob/UploadImage.data
-- (the previous server's layout) are carried over before those columns go.
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE ops.blob (
    key TEXT PRIMARY KEY,
    content_type TEXT NOT NULL,
    size BIGINT NOT NULL,
    data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ops.blob ALTER COLUMN data SET STORAGE EXTERNAL;

-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'UploadBlob') THEN
        INSERT INTO ops.blob (key, content_type, size, data)
        SELECT 'uploads/' || b."uploadId", u."mime", length(b."data"), b."data"
        FROM "UploadBlob" AS b JOIN "Upload" AS u ON u."id" = b."uploadId"
        ON CONFLICT (key) DO NOTHING;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'UploadImage' AND column_name = 'data') THEN
        INSERT INTO ops.blob (key, content_type, size, data)
        SELECT 'uploads/' || i."uploadId" || '/images/' || i."id", i."mime", length(i."data"), i."data"
        FROM "UploadImage" AS i
        ON CONFLICT (key) DO NOTHING;
    END IF;
END $$;
-- +goose StatementEnd

DROP TABLE IF EXISTS "UploadBlob";
ALTER TABLE "UploadImage" DROP COLUMN IF EXISTS "data";

-- +goose Down
ALTER TABLE "UploadImage" ADD COLUMN "data" BYTEA NOT NULL DEFAULT ''::bytea;
CREATE TABLE "UploadBlob" (
    "uploadId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    CONSTRAINT "UploadBlob_pkey" PRIMARY KEY ("uploadId"),
    CONSTRAINT "UploadBlob_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
DROP TABLE IF EXISTS ops.blob;
