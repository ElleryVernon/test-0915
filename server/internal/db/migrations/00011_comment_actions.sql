-- +goose Up
ALTER TABLE "CommunityComment"
 ADD COLUMN "deleted" boolean NOT NULL DEFAULT false,
 ADD COLUMN "editedAt" timestamp(3);
CREATE TABLE "CommentLike" (
 "commentId" text NOT NULL REFERENCES "Comment"("id") ON DELETE CASCADE,
 "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 PRIMARY KEY("commentId","userId")
);
CREATE INDEX "CommentLike_user_idx" ON "CommentLike"("userId");

-- +goose Down
DROP TABLE "CommentLike";
ALTER TABLE "CommunityComment" DROP COLUMN "deleted", DROP COLUMN "editedAt";
