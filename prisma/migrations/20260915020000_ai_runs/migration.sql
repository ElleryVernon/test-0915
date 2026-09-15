-- CreateTable
CREATE TABLE "AiRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "skillVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "result" JSONB,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "errorStatus" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiRun_userId_status_updatedAt_idx" ON "AiRun"("userId", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiRun_userId_requestId_key" ON "AiRun"("userId", "requestId");

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
