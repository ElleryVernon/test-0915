-- +goose Up
-- The previous schema declared foreign keys without indexes on the referencing columns. Every
-- per-row count and every lookup by the referenced side (cards per subject, reviews per card, likes
-- per post, attempts per question, followers, blocks, links) scanned the whole table, so bootstrap
-- slowed down with everyone's activity, not just the student's own (measured: 26 req/s after 26k
-- reviews vs 353 req/s on an empty review table; docs/SERVER_REVIEW.md #17).
CREATE INDEX "CardReview_cardId_idx" ON "CardReview"("cardId");
CREATE INDEX "Card_subjectId_idx" ON "Card"("subjectId");
CREATE INDEX "Material_subjectId_idx" ON "Material"("subjectId");
CREATE INDEX "Question_subjectId_idx" ON "Question"("subjectId");
CREATE INDEX "Question_materialId_idx" ON "Question"("materialId");
CREATE INDEX "Essay_subjectId_idx" ON "Essay"("subjectId");
CREATE INDEX "Essay_materialId_idx" ON "Essay"("materialId");
CREATE INDEX "Attempt_questionId_idx" ON "Attempt"("questionId");
CREATE INDEX "Attempt_essayId_idx" ON "Attempt"("essayId");
CREATE INDEX "Post_userId_idx" ON "Post"("userId");
CREATE INDEX "Comment_userId_idx" ON "Comment"("userId");
CREATE INDEX "PostLike_postId_idx" ON "PostLike"("postId");
CREATE INDEX "PostSave_postId_idx" ON "PostSave"("postId");
CREATE INDEX "Report_postId_idx" ON "Report"("postId");
CREATE INDEX "Block_blockedId_idx" ON "Block"("blockedId");
CREATE INDEX "Follow_followingId_idx" ON "Follow"("followingId");
CREATE INDEX "Message_recipientId_senderId_createdAt_idx" ON "Message"("recipientId", "senderId", "createdAt");
CREATE INDEX "ParentLink_studentId_idx" ON "ParentLink"("studentId");
CREATE INDEX "Cheer_senderId_createdAt_idx" ON "Cheer"("senderId", "createdAt");
CREATE INDEX "Schedule_subjectId_idx" ON "Schedule"("subjectId");

-- +goose Down
DROP INDEX IF EXISTS "Schedule_subjectId_idx", "Cheer_senderId_createdAt_idx", "ParentLink_studentId_idx",
  "Message_recipientId_senderId_createdAt_idx", "Follow_followingId_idx", "Block_blockedId_idx", "Report_postId_idx",
  "PostSave_postId_idx", "PostLike_postId_idx", "Comment_userId_idx", "Post_userId_idx", "Attempt_essayId_idx",
  "Attempt_questionId_idx", "Essay_materialId_idx", "Essay_subjectId_idx", "Question_materialId_idx",
  "Question_subjectId_idx", "Material_subjectId_idx", "Card_subjectId_idx", "CardReview_cardId_idx";
