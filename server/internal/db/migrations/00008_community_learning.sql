-- +goose Up
CREATE TABLE "CommunityPost" (
 "postId" text PRIMARY KEY REFERENCES "Post"("id") ON DELETE CASCADE,
 "blocks" jsonb NOT NULL DEFAULT '[]', "tags" jsonb NOT NULL DEFAULT '{}', "sourceRef" jsonb,
 "requestId" text, "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "deleted" boolean NOT NULL DEFAULT false, "editedAt" timestamp(3), "solvedAt" timestamp(3), "acceptedCommentId" text,
 UNIQUE("userId","requestId")
);
CREATE TABLE "CommunityComment" (
 "commentId" text PRIMARY KEY REFERENCES "Comment"("id") ON DELETE CASCADE,
 "block" jsonb, "requestId" text, "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 UNIQUE("userId","requestId")
);
CREATE TABLE "CommunityAction" (
 "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "postId" text NOT NULL REFERENCES "Post"("id") ON DELETE CASCADE,
 "blockId" text NOT NULL, "kind" text NOT NULL, "result" jsonb NOT NULL,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY("userId","postId","blockId","kind")
);
CREATE TABLE "CommunityReward" (
 "postId" text NOT NULL REFERENCES "Post"("id") ON DELETE CASCADE,
 "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY("postId","userId")
);
CREATE TABLE "CommunityPrivacy" (
 "userId" text PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE,
 "visibility" jsonb NOT NULL DEFAULT '{"grade":true,"subjects":true,"followerCount":false,"cardsDefault":false,"whoCanFollow":"SAME_GRADE"}'
);
CREATE TABLE "CommunityCard" (
 "cardId" text PRIMARY KEY REFERENCES "Card"("id") ON DELETE CASCADE,
 "public" boolean NOT NULL DEFAULT false
);
CREATE TABLE "CommunityFollowEvent" (
 "id" text PRIMARY KEY, "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "CommunityFollowEvent_user_created_idx" ON "CommunityFollowEvent"("userId","createdAt");

CREATE TABLE "CommunitySavedQuestion" (
 "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "questionId" text PRIMARY KEY REFERENCES "Question"("id") ON DELETE CASCADE,
 "postId" text NOT NULL REFERENCES "Post"("id") ON DELETE CASCADE
);
CREATE TABLE "CommunityCardClone" (
 "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "sourceCardId" text NOT NULL REFERENCES "Card"("id") ON DELETE CASCADE,
 "cardId" text NOT NULL REFERENCES "Card"("id") ON DELETE CASCADE,
 PRIMARY KEY("userId","sourceCardId")
);


-- +goose StatementBegin
CREATE FUNCTION community_card_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO "CommunityCard"("cardId","public") SELECT NEW."id", true FROM "CommunityPrivacy" WHERE "userId"=NEW."userId" AND "visibility"->>'cardsDefault'='true';
 RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER community_card_default AFTER INSERT ON "Card" FOR EACH ROW EXECUTE FUNCTION community_card_default();

-- +goose Down
DROP TRIGGER community_card_default ON "Card";
DROP FUNCTION community_card_default();
DROP TABLE "CommunityCardClone";
DROP TABLE "CommunitySavedQuestion";
DROP TABLE "CommunityFollowEvent";
DROP TABLE "CommunityCard";
DROP TABLE "CommunityPrivacy";
DROP TABLE "CommunityReward";
DROP TABLE "CommunityAction";
DROP TABLE "CommunityComment";
DROP TABLE "CommunityPost";
