-- +goose Up
-- Small, normalized private thumbnails stay transactional with their owner metadata.
CREATE TABLE "ProfilePhoto" (
  "userId" TEXT PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE,
  "version" TEXT NOT NULL,
  "data" BYTEA NOT NULL CHECK (octet_length("data") <= 500000),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "ParentLearningNotice" (
  "notificationId" TEXT PRIMARY KEY REFERENCES "Notification"("id") ON DELETE CASCADE,
  -- Keep the authorization pointer until the parent's next read can remove the
  -- whole notification if the student account was deleted.
  "studentId" TEXT NOT NULL,
  "day" DATE NOT NULL
);

-- +goose Down
DROP TABLE "ParentLearningNotice";
DROP TABLE "ProfilePhoto";
