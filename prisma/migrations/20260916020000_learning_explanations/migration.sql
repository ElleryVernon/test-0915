-- +goose Up
-- Optional source-grounded metadata; existing scores and study content remain intact.
ALTER TABLE "Question" ADD COLUMN "learningExplanation" JSONB;
ALTER TABLE "Attempt" ADD COLUMN "responseMs" INTEGER;
ALTER TABLE "Attempt" ADD COLUMN "beatsSeen" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Attempt" ADD COLUMN "explainDepth" TEXT;
ALTER TABLE "Attempt" ADD COLUMN "microResult" TEXT;
ALTER TABLE "Attempt" ADD COLUMN "divergenceNodeId" TEXT;
ALTER TABLE "Attempt" ADD COLUMN "requestId" TEXT;
CREATE UNIQUE INDEX "Attempt_userId_requestId_key" ON "Attempt"("userId", "requestId");
ALTER TABLE "Card" ADD COLUMN "sourceKind" TEXT NOT NULL DEFAULT 'TEXT';
DROP INDEX "Card_userId_sourceQuestionId_key";
CREATE UNIQUE INDEX "Card_userId_sourceQuestionId_sourceKind_key" ON "Card"("userId", "sourceQuestionId", "sourceKind");
ALTER TABLE "Card" ADD COLUMN "diagram" JSONB;
ALTER TABLE "Card" ADD COLUMN "maskedNodeIds" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "Card" ADD COLUMN "sourceDiagramId" TEXT;
CREATE TABLE "ExplanationReport" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "questionId" TEXT NOT NULL REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "nodeId" TEXT NOT NULL DEFAULT '',
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("userId", "questionId", "nodeId", "reason")
);
CREATE INDEX "ExplanationReport_questionId_idx" ON "ExplanationReport"("questionId");
