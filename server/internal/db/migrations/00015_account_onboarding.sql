-- +goose Up
-- Existing accounts keep their current role/profile. Only new OAuth accounts
-- receive a pending row, in the same transaction that creates their identity.
CREATE TABLE "AccountOnboarding" (
  "userId" TEXT PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE,
  "draft" JSONB NOT NULL DEFAULT '{}',
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- +goose Down
DROP TABLE "AccountOnboarding";
