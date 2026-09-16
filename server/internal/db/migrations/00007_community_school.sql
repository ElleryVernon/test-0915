-- +goose Up
ALTER TABLE "Post" ADD COLUMN "school" text NOT NULL DEFAULT '';
CREATE INDEX "Post_role_school_createdAt_idx" ON "Post" ("role", "school", "createdAt" DESC);
-- +goose Down
DROP INDEX "Post_role_school_createdAt_idx";
ALTER TABLE "Post" DROP COLUMN "school";
