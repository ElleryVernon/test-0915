-- +goose Up
-- A generated card remembers the material it came from. Home offered "복습 카드 만들기" for the newest
-- material forever, because nothing recorded that cards had already been made from it — a second tap
-- paid for a second, duplicate generation (review finding, 2026-09-16). Hand-made and wrong-note cards
-- keep NULL; deleting the material keeps its cards (SET NULL).
ALTER TABLE "Card" ADD COLUMN "materialId" TEXT;
ALTER TABLE "Card" ADD CONSTRAINT "Card_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Card_materialId_idx" ON "Card"("materialId");

-- +goose Down
DROP INDEX IF EXISTS "Card_materialId_idx";
ALTER TABLE "Card" DROP CONSTRAINT IF EXISTS "Card_materialId_fkey";
ALTER TABLE "Card" DROP COLUMN IF EXISTS "materialId";
