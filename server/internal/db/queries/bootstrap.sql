-- name: ListSubjectsWithCounts :many
SELECT s.*,
  (SELECT count(*) FROM "Material" AS m WHERE m."subjectId" = s."id")::int AS material_count,
  (SELECT count(*) FROM "Question" AS q WHERE q."subjectId" = s."id")::int AS question_count,
  (SELECT count(*) FROM "Card" AS c WHERE c."subjectId" = s."id" AND c."deleted" = false)::int AS card_count
FROM "Subject" AS s WHERE s."userId" = $1 AND s."deleted" = false ORDER BY s."createdAt" ASC;

-- name: ListMaterialsWithUpload :many
SELECT m.*, u."pages" AS upload_pages,
  (SELECT count(*) FROM "UploadImage" AS i WHERE i."uploadId" = u."id")::int AS image_count
FROM "Material" AS m JOIN "Subject" AS s ON s."id" = m."subjectId" LEFT JOIN "Upload" AS u ON u."id" = m."uploadId"
WHERE m."userId" = $1 AND s."deleted" = false ORDER BY m."createdAt" DESC;

-- name: ListQuestions :many
SELECT q.* FROM "Question" AS q JOIN "Subject" AS s ON s."id" = q."subjectId" WHERE q."userId" = $1 AND s."deleted" = false;

-- name: ListEssays :many
SELECT e.* FROM "Essay" AS e JOIN "Subject" AS s ON s."id" = e."subjectId" WHERE e."userId" = $1 AND s."deleted" = false;

-- name: ListCardsWithReviewCount :many
SELECT c.*, (SELECT count(*) FROM "CardReview" AS r WHERE r."cardId" = c."id")::int AS review_count
FROM "Card" AS c JOIN "Subject" AS s ON s."id" = c."subjectId"
WHERE c."userId" = $1 AND s."deleted" = false ORDER BY c."createdAt" ASC;

-- name: ListAttempts :many
SELECT * FROM "Attempt" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 1000;

-- name: ListSchedules :many
SELECT * FROM "Schedule" WHERE "userId" = $1 ORDER BY "date" ASC, "start" ASC;

-- name: ListCheersSent :many
SELECT c.*, u."nickname" AS sender_name FROM "Cheer" AS c JOIN "User" AS u ON u."id" = c."senderId"
WHERE c."senderId" = $1 ORDER BY c."createdAt" DESC LIMIT 100;

-- name: ListCheersReceived :many
SELECT c.*, u."nickname" AS sender_name FROM "Cheer" AS c JOIN "User" AS u ON u."id" = c."senderId"
WHERE c."recipientId" = $1 ORDER BY c."createdAt" DESC LIMIT 100;

-- name: ListNotifications :many
SELECT * FROM "Notification" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 100;

-- name: ListRecentCardReviews :many
SELECT "createdAt" FROM "CardReview" WHERE "userId" = $1 AND "createdAt" >= $2 ORDER BY "createdAt" DESC;

-- name: StudiedDays :many
SELECT DISTINCT to_char(a."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')::text AS day FROM "Attempt" AS a WHERE a."userId" = @user_id
UNION
SELECT DISTINCT to_char(r."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')::text AS day FROM "CardReview" AS r WHERE r."userId" = @user_id;
