-- +goose Up
-- Notification.kind separates in-app community kinds (FIRST_ANSWER, MORE_ANSWERS, ACCEPTED,
-- ACCEPT_ASK, FOLLOWING_DIGEST) from generic notices so the client can badge and bundle them.
ALTER TABLE "Notification" ADD COLUMN "kind" text NOT NULL DEFAULT '';
CREATE INDEX "Notification_userId_kind_idx" ON "Notification"("userId", "kind");

-- +goose Down
DROP INDEX "Notification_userId_kind_idx";
ALTER TABLE "Notification" DROP COLUMN "kind";
