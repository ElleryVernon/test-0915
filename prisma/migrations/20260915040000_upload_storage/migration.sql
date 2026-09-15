-- AlterTable
ALTER TABLE "Material" ADD COLUMN     "extraction" TEXT,
ADD COLUMN     "pageBreaks" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "uploadId" TEXT;

-- AlterTable
ALTER TABLE "Upload" ADD COLUMN     "extraction" TEXT,
ADD COLUMN     "pageBreaks" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "pages" INTEGER,
ADD COLUMN     "sha256" TEXT,
ADD COLUMN     "textHash" TEXT;

-- CreateTable
CREATE TABLE "UploadBlob" (
    "uploadId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "UploadBlob_pkey" PRIMARY KEY ("uploadId")
);

-- CreateTable
CREATE TABLE "UploadImage" (
    "id" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "order" INTEGER NOT NULL,
    "paragraph" INTEGER NOT NULL,
    "anchor" INTEGER NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "w" DOUBLE PRECISION NOT NULL,
    "h" DOUBLE PRECISION NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "mime" TEXT NOT NULL,
    "context" TEXT NOT NULL DEFAULT '',
    "data" BYTEA NOT NULL,

    CONSTRAINT "UploadImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UploadImage_uploadId_page_order_idx" ON "UploadImage"("uploadId", "page", "order");

-- Link each material to the upload its url points at (same owner; the oldest material wins if two share one).
UPDATE "Material" AS m
SET "uploadId" = u."id"
FROM "Upload" AS u
WHERE m."url" = '/api/uploads/' || u."id"
  AND u."userId" = m."userId"
  AND m."id" = (SELECT first."id" FROM "Material" AS first WHERE first."url" = m."url" ORDER BY first."createdAt", first."id" LIMIT 1);

-- CreateIndex
CREATE UNIQUE INDEX "Material_uploadId_key" ON "Material"("uploadId");

-- CreateIndex
CREATE INDEX "Upload_userId_createdAt_idx" ON "Upload"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadBlob" ADD CONSTRAINT "UploadBlob_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadImage" ADD CONSTRAINT "UploadImage_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Files are already compressed (PDF, WebP, PNG, JPEG); keep them uncompressed out of line.
ALTER TABLE "UploadBlob" ALTER COLUMN "data" SET STORAGE EXTERNAL;
ALTER TABLE "UploadImage" ALTER COLUMN "data" SET STORAGE EXTERNAL;
