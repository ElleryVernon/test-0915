-- Community: posts, likes, saves, comments, reports and blocks (api.ts posts/reports/blocks,
-- bootstrap.ts postsFor).

-- name: GetPostAccess :one
-- The post with what accessiblePost() decides on: the author's suspension and whether a block
-- stands between the viewer and the author in either direction.
SELECT sqlc.embed(p), u."suspended" AS author_suspended,
  EXISTS (
    SELECT 1 FROM "Block" AS b
    WHERE (b."userId" = @viewer_id::text AND b."blockedId" = p."userId")
       OR (b."userId" = p."userId" AND b."blockedId" = @viewer_id::text)
  ) AS blocked
FROM "Post" AS p JOIN "User" AS u ON u."id" = p."userId"
WHERE p."id" = @post_id;

-- name: ListPosts :many
-- The community feed: the 100 newest posts of one role, minus those by suspended authors and by
-- anyone the viewer blocked or was blocked by; commented keeps only the posts the viewer commented on.
SELECT sqlc.embed(p), u."nickname" AS author_nickname,
  (SELECT count(*) FROM "PostLike" AS l WHERE l."postId" = p."id") AS likes,
  EXISTS (SELECT 1 FROM "PostLike" AS l WHERE l."postId" = p."id" AND l."userId" = @viewer_id::text) AS liked,
  EXISTS (SELECT 1 FROM "PostSave" AS s WHERE s."postId" = p."id" AND s."userId" = @viewer_id::text) AS saved,
  (SELECT count(*) FROM "Comment" AS c WHERE c."postId" = p."id") AS comment_count
FROM "Post" AS p JOIN "User" AS u ON u."id" = p."userId"
WHERE p."role" = @role
  AND u."suspended" = false
  AND NOT EXISTS (
    SELECT 1 FROM "Block" AS b
    WHERE (b."userId" = @viewer_id::text AND b."blockedId" = p."userId")
       OR (b."userId" = p."userId" AND b."blockedId" = @viewer_id::text)
  )
  AND (NOT @commented::boolean OR EXISTS (SELECT 1 FROM "Comment" AS c WHERE c."postId" = p."id" AND c."userId" = @viewer_id::text))
ORDER BY p."createdAt" DESC
LIMIT 100;

-- name: CreatePost :one
INSERT INTO "Post" ("id", "userId", "role", "category", "title", "body", "anonymous")
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: HasPostLike :one
SELECT EXISTS (SELECT 1 FROM "PostLike" WHERE "userId" = $1 AND "postId" = $2);

-- name: CreatePostLike :exec
INSERT INTO "PostLike" ("userId", "postId") VALUES ($1, $2);

-- name: DeletePostLike :exec
DELETE FROM "PostLike" WHERE "userId" = $1 AND "postId" = $2;

-- name: HasPostSave :one
SELECT EXISTS (SELECT 1 FROM "PostSave" WHERE "userId" = $1 AND "postId" = $2);

-- name: CreatePostSave :exec
INSERT INTO "PostSave" ("userId", "postId") VALUES ($1, $2);

-- name: DeletePostSave :exec
DELETE FROM "PostSave" WHERE "userId" = $1 AND "postId" = $2;

-- name: ListComments :many
-- The 500 oldest comments of a post, hiding those by suspended authors and by anyone the viewer
-- blocked or was blocked by.
SELECT sqlc.embed(c), u."nickname" AS author_nickname
FROM "Comment" AS c JOIN "User" AS u ON u."id" = c."userId"
WHERE c."postId" = @post_id
  AND u."suspended" = false
  AND NOT EXISTS (
    SELECT 1 FROM "Block" AS b
    WHERE (b."userId" = @viewer_id::text AND b."blockedId" = c."userId")
       OR (b."userId" = c."userId" AND b."blockedId" = @viewer_id::text)
  )
ORDER BY c."createdAt" ASC
LIMIT 500;

-- name: IsTopLevelComment :one
-- Replies go one level deep: a parent must be a top-level comment of the same post.
SELECT EXISTS (SELECT 1 FROM "Comment" WHERE "id" = $1 AND "postId" = $2 AND "parentId" IS NULL);

-- name: CreateComment :one
INSERT INTO "Comment" ("id", "postId", "userId", "body", "parentId")
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: UpsertReport :one
-- One report per (user, post): reporting again replaces the reason and reopens it.
INSERT INTO "Report" ("id", "userId", "postId", "reason")
VALUES ($1, $2, $3, $4)
ON CONFLICT ("userId", "postId") DO UPDATE SET "reason" = EXCLUDED."reason", "status" = 'OPEN'
RETURNING *;

-- name: GetPeer :one
-- A user with whether a block stands between them and the viewer in either direction.
SELECT sqlc.embed(u),
  EXISTS (
    SELECT 1 FROM "Block" AS b
    WHERE (b."userId" = @viewer_id::text AND b."blockedId" = u."id")
       OR (b."userId" = u."id" AND b."blockedId" = @viewer_id::text)
  ) AS blocked
FROM "User" AS u
WHERE u."id" = @user_id;

-- name: CreateBlock :exec
INSERT INTO "Block" ("userId", "blockedId") VALUES ($1, $2) ON CONFLICT DO NOTHING;

-- name: DeleteBlock :exec
DELETE FROM "Block" WHERE "userId" = $1 AND "blockedId" = $2;
