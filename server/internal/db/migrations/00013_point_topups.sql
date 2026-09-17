-- +goose Up
CREATE TABLE "PointTopup" (
 "id" text PRIMARY KEY,
 "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "requestId" text NOT NULL,
 "amount" integer NOT NULL CHECK ("amount" BETWEEN 1000 AND 100000),
 "mode" text NOT NULL CHECK ("mode" IN ('test','live')),
 "status" text NOT NULL DEFAULT 'READY' CHECK ("status" IN ('READY','VERIFYING','DONE','FAILED')),
 "paymentKey" text UNIQUE,
 "createdAt" timestamptz NOT NULL DEFAULT now(),
 "creditedAt" timestamptz,
 UNIQUE ("userId", "requestId")
);
CREATE INDEX "PointTopup_user_created" ON "PointTopup"("userId", "createdAt" DESC);
-- +goose Down
DROP TABLE "PointTopup";
