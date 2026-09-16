-- Social: the follow graph, direct messages and the school directory (api.ts social/follow/
-- messages/schools).

-- name: ListFollowers :many
SELECT u."id", u."nickname"
FROM "Follow" AS f JOIN "User" AS u ON u."id" = f."followerId"
WHERE f."followingId" = $1;

-- name: ListFollowing :many
SELECT u."id", u."nickname"
FROM "Follow" AS f JOIN "User" AS u ON u."id" = f."followingId"
WHERE f."followerId" = $1;

-- name: ListPeers :many
-- Up to 100 accounts of the same role the viewer may talk to: not themselves, not suspended and
-- with no block in either direction.
SELECT u."id", u."nickname"
FROM "User" AS u
WHERE u."role" = @role
  AND u."id" <> @viewer_id::text
  AND u."suspended" = false
  AND NOT EXISTS (
    SELECT 1 FROM "Block" AS b
    WHERE (b."userId" = @viewer_id::text AND b."blockedId" = u."id")
       OR (b."userId" = u."id" AND b."blockedId" = @viewer_id::text)
  )
LIMIT 100;

-- name: ListBlocked :many
SELECT u."id", u."nickname"
FROM "Block" AS b JOIN "User" AS u ON u."id" = b."blockedId"
WHERE b."userId" = $1;

-- name: CountUserPosts :one
SELECT count(*) FROM "Post" WHERE "userId" = $1;

-- name: CountUserComments :one
SELECT count(*) FROM "Comment" WHERE "userId" = $1;

-- name: HasFollow :one
SELECT EXISTS (SELECT 1 FROM "Follow" WHERE "followerId" = $1 AND "followingId" = $2);

-- name: CreateFollow :exec
INSERT INTO "Follow" ("followerId", "followingId") VALUES ($1, $2);

-- name: DeleteFollow :exec
DELETE FROM "Follow" WHERE "followerId" = $1 AND "followingId" = $2;

-- name: ListMessages :many
-- The 200 oldest messages between two accounts, in either direction.
SELECT * FROM "Message"
WHERE ("senderId" = @user_id::text AND "recipientId" = @peer_id::text)
   OR ("senderId" = @peer_id::text AND "recipientId" = @user_id::text)
ORDER BY "createdAt" ASC
LIMIT 200;

-- name: CreateMessage :one
INSERT INTO "Message" ("id", "senderId", "recipientId", "body")
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: SearchSchools :many
-- pattern is a LIKE pattern the handler builds ('%' + escaped query + '%'); the match ignores case.
SELECT * FROM "School"
WHERE "name" ILIKE @pattern::text
ORDER BY "name" ASC
LIMIT 30;

-- name: ListConversations :many
SELECT u."id", u."nickname", recent."body", recent."createdAt"
FROM "User" u
JOIN LATERAL (
  SELECT m."body", m."createdAt" FROM "Message" m
  WHERE (m."senderId" = @viewer_id::text AND m."recipientId" = u."id")
     OR (m."recipientId" = @viewer_id::text AND m."senderId" = u."id")
  ORDER BY m."createdAt" DESC, m."id" DESC LIMIT 1
) recent ON true
WHERE u."id" <> @viewer_id::text AND u."role" = @role AND NOT u."suspended"
  AND NOT EXISTS (SELECT 1 FROM "Block" b
    WHERE (b."userId" = @viewer_id::text AND b."blockedId" = u."id")
       OR (b."userId" = u."id" AND b."blockedId" = @viewer_id::text))
ORDER BY recent."createdAt" DESC, u."id" LIMIT 100;
