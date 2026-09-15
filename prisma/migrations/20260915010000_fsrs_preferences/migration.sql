-- Preserve every existing card and review. Adaptive history starts at its first FSRS review.
ALTER TABLE "Card" ADD COLUMN "fsrs" JSONB;

ALTER TABLE "User"
ADD COLUMN "srsMode" TEXT NOT NULL DEFAULT 'FIXED',
ADD COLUMN "desiredRetention" DOUBLE PRECISION NOT NULL DEFAULT 0.9;

ALTER TABLE "User" ADD CONSTRAINT "User_srsMode_check" CHECK ("srsMode" IN ('FIXED', 'FSRS'));
ALTER TABLE "User" ADD CONSTRAINT "User_desiredRetention_check" CHECK ("desiredRetention" >= 0.8 AND "desiredRetention" <= 0.97);
