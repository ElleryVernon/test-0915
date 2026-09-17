-- +goose Up
CREATE SEQUENCE "Message_ordinal_seq";
ALTER TABLE "Message"
 ADD COLUMN "ordinal" bigint,
 ADD COLUMN "requestId" text,
 ADD COLUMN "readAt" timestamp(3),
 ADD COLUMN "blocks" jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN "replyToId" text REFERENCES "Message"("id") ON DELETE SET NULL,
 ADD COLUMN "replySnapshot" jsonb,
 ADD COLUMN "deleted" boolean NOT NULL DEFAULT false;
WITH numbered AS (SELECT "id", row_number() OVER (ORDER BY "createdAt","id") AS n FROM "Message")
UPDATE "Message" m SET "ordinal"=n.n FROM numbered n WHERE m."id"=n."id";
SELECT setval('"Message_ordinal_seq"',COALESCE((SELECT max("ordinal")+1 FROM "Message"),1),false);
ALTER TABLE "Message" ALTER COLUMN "ordinal" SET NOT NULL, ALTER COLUMN "ordinal" SET DEFAULT nextval('"Message_ordinal_seq"');
ALTER SEQUENCE "Message_ordinal_seq" OWNED BY "Message"."ordinal";
CREATE UNIQUE INDEX "Message_sender_request_idx" ON "Message"("senderId","requestId") WHERE "requestId" IS NOT NULL;
CREATE INDEX "Message_conversation_ordinal_idx" ON "Message"(LEAST("senderId","recipientId"),GREATEST("senderId","recipientId"),"ordinal" DESC);
CREATE INDEX "Message_unread_idx" ON "Message"("recipientId","senderId","ordinal") WHERE "readAt" IS NULL AND NOT "deleted";
CREATE INDEX "Message_reply_idx" ON "Message"("replyToId") WHERE "replyToId" IS NOT NULL;
CREATE TABLE "MessageReaction" (
 "messageId" text NOT NULL REFERENCES "Message"("id") ON DELETE CASCADE,
 "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 PRIMARY KEY("messageId","userId")
);
CREATE INDEX "MessageReaction_user_idx" ON "MessageReaction"("userId");
CREATE TABLE "MessageAction" (
 "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "messageId" text NOT NULL REFERENCES "Message"("id") ON DELETE CASCADE,
 "blockId" text NOT NULL, "kind" text NOT NULL, "result" jsonb NOT NULL,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY("userId","messageId","blockId","kind")
);
CREATE INDEX "MessageAction_message_block_idx" ON "MessageAction"("messageId","blockId","kind");
CREATE TABLE "MessageSavedQuestion" (
 "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "questionId" text PRIMARY KEY REFERENCES "Question"("id") ON DELETE CASCADE,
 "messageId" text NOT NULL REFERENCES "Message"("id") ON DELETE CASCADE
);
CREATE INDEX "MessageSavedQuestion_user_idx" ON "MessageSavedQuestion"("userId");
CREATE INDEX "MessageSavedQuestion_message_idx" ON "MessageSavedQuestion"("messageId");

-- +goose Down
DROP TABLE "MessageSavedQuestion";
DROP TABLE "MessageAction";
DROP TABLE "MessageReaction";
DROP INDEX "Message_reply_idx", "Message_unread_idx", "Message_conversation_ordinal_idx", "Message_sender_request_idx";
ALTER TABLE "Message" DROP COLUMN "ordinal", DROP COLUMN "requestId", DROP COLUMN "readAt", DROP COLUMN "blocks", DROP COLUMN "replyToId", DROP COLUMN "replySnapshot", DROP COLUMN "deleted";
