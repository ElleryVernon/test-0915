ALTER TABLE "Post" ADD COLUMN "school" TEXT NOT NULL DEFAULT '';
CREATE INDEX "Post_role_school_createdAt_idx" ON "Post" ("role", "school", "createdAt" DESC);
