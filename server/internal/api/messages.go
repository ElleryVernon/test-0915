package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/db"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/jsonx"
	"memoryz/server/internal/store"
)

type messageReply struct {
	ID       string `json:"id"`
	Body     string `json:"body"`
	SenderID string `json:"senderId"`
	Deleted  bool   `json:"deleted,omitempty"`
}
type messageReaction struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
	Mine  bool   `json:"mine"`
}
type messageRecord struct {
	ID          string            `json:"id"`
	SenderID    string            `json:"senderId"`
	RecipientID string            `json:"recipientId"`
	Body        string            `json:"body"`
	CreatedAt   jsonx.Time        `json:"createdAt"`
	RequestID   *string           `json:"requestId,omitempty"`
	ReadAt      *time.Time        `json:"readAt"`
	ReplyTo     *messageReply     `json:"replyTo,omitempty"`
	Blocks      []communityBlock  `json:"blocks"`
	Deleted     bool              `json:"deleted"`
	Reactions   []messageReaction `json:"reactions"`
	Ordinal     int64             `json:"ordinal"`
}

// Keep generated sqlc models unchanged: the richer message projection lives at this boundary.
const messageColumns = `m."id",m."senderId",m."recipientId",m."body",m."createdAt",m."requestId",m."readAt",m."blocks",m."replySnapshot",m."deleted",m."ordinal",
 EXISTS(SELECT 1 FROM "Message" reply WHERE reply."id"=m."replyToId" AND reply."deleted"),
 (SELECT count(*) FROM "MessageReaction" mr WHERE mr."messageId"=m."id"),
 EXISTS(SELECT 1 FROM "MessageReaction" mr WHERE mr."messageId"=m."id" AND mr."userId"=$1)`
const messagePair = `LEAST(m."senderId",m."recipientId")=LEAST($1::text,$2::text) AND GREATEST(m."senderId",m."recipientId")=GREATEST($1::text,$2::text)`

// Inbox previews need attachment kinds, never the large private snapshot payloads.
const messageSummaryBlocks = `(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',b->>'id','type',b->>'type','hidden',COALESCE(b->'hidden','false'::jsonb),'payload','{}'::jsonb)),'[]'::jsonb) FROM jsonb_array_elements(m."blocks") b)`

func scanMessage(row pgx.Row, viewerID string) (messageRecord, error) {
	var m messageRecord
	var blocks, reply []byte
	var replyDeleted, mine bool
	var count int
	var created time.Time
	err := row.Scan(&m.ID, &m.SenderID, &m.RecipientID, &m.Body, &created, &m.RequestID, &m.ReadAt, &blocks, &reply, &m.Deleted, &m.Ordinal, &replyDeleted, &count, &mine)
	if err != nil {
		return m, err
	}
	m.CreatedAt = jsonx.Time(created)
	if err = json.Unmarshal(blocks, &m.Blocks); err != nil {
		return m, err
	}
	if len(reply) > 0 {
		if err = json.Unmarshal(reply, &m.ReplyTo); err != nil {
			return m, err
		}
	}
	m.Reactions = []messageReaction{}
	if count > 0 {
		m.Reactions = append(m.Reactions, messageReaction{Emoji: "❤️", Count: count, Mine: mine})
	}
	if m.ReplyTo != nil && replyDeleted {
		m.ReplyTo.Body = ""
		m.ReplyTo.Deleted = true
	}
	if m.SenderID != viewerID {
		m.RequestID = nil
		for i := range m.Blocks {
			m.Blocks[i].RefID = ""
		}
	}
	if m.Deleted {
		m.Body = ""
		m.Blocks = []communityBlock{}
		m.ReplyTo = nil
		m.Reactions = []messageReaction{}
	}
	return m, nil
}

func (s *Server) messageView(ctx context.Context, user store.User, id string) (messageRecord, error) {
	m, err := scanMessage(s.pool.QueryRow(ctx, `SELECT `+messageColumns+` FROM "Message" m WHERE m."id"=$2 AND $1 IN(m."senderId",m."recipientId")`, user.ID, id), user.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return m, apierr.ErrMissing
	}
	if err != nil {
		return m, err
	}
	peer := m.SenderID
	if peer == user.ID {
		peer = m.RecipientID
	}
	if _, err = s.peer(ctx, user, peer); err != nil {
		return m, err
	}
	err = s.decorateMessage(ctx, user.ID, &m)
	return m, err
}
func (s *Server) decorateMessage(ctx context.Context, userID string, m *messageRecord) error {
	for i := range m.Blocks {
		b := &m.Blocks[i]
		if b.Type == "QUESTION" || b.Type == "POLL" {
			stats, err := s.messageBlockStats(ctx, userID, m.ID, *b)
			if err != nil {
				return err
			}
			b.Stats = stats
		}
	}
	return nil
}

// GET is deliberately side-effect free; a visible boundary must be acknowledged separately.
func (s *Server) listMessages(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	if r.URL.Query().Get("inbox") == "1" {
		return s.messageInbox(w, r, user)
	}
	peerID := r.URL.Query().Get("userId")
	peer, err := s.peer(ctx, user, peerID)
	if err != nil {
		return err
	}
	if r.URL.Query().Get("peer") == "1" {
		httpx.OK(w, 200, userRef{ID: peer.ID, Nickname: peer.Nickname})
		return nil
	}
	var before int64
	if cursor := r.URL.Query().Get("before"); cursor != "" {
		err = s.pool.QueryRow(ctx, `SELECT m."ordinal" FROM "Message" m WHERE `+messagePair+` AND m."id"=$3`, user.ID, peerID, cursor).Scan(&before)
		if errors.Is(err, pgx.ErrNoRows) {
			return apierr.ErrMissing
		}
		if err != nil {
			return err
		}
	}
	rows, err := s.pool.Query(ctx, `SELECT `+messageColumns+` FROM "Message" m WHERE `+messagePair+` AND ($3::bigint=0 OR m."ordinal"<$3) ORDER BY m."ordinal" DESC LIMIT 50`, user.ID, peerID, before)
	if err != nil {
		return err
	}
	messages := make([]messageRecord, 0, 50)
	for rows.Next() {
		m, e := scanMessage(rows, user.ID)
		if e != nil {
			rows.Close()
			return e
		}
		messages = append(messages, m)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}
	if err = s.decorateMessages(ctx, user.ID, messages); err != nil {
		return err
	}
	httpx.OK(w, 200, messages)
	return nil
}
func (s *Server) messageInbox(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	rows, err := s.pool.Query(ctx, `WITH recent AS (
 SELECT DISTINCT ON(CASE WHEN "senderId"=$1 THEN "recipientId" ELSE "senderId" END) "id",CASE WHEN "senderId"=$1 THEN "recipientId" ELSE "senderId" END peer
 FROM "Message" WHERE $1 IN("senderId","recipientId") ORDER BY CASE WHEN "senderId"=$1 THEN "recipientId" ELSE "senderId" END,"createdAt" DESC,"ordinal" DESC)
 SELECT `+strings.Replace(messageColumns, `m."blocks"`, messageSummaryBlocks, 1)+`,u."nickname",(SELECT count(*) FROM "Message" unread WHERE unread."senderId"=u."id" AND unread."recipientId"=$1 AND unread."readAt" IS NULL AND NOT unread."deleted")
 FROM recent JOIN "Message" m ON m."id"=recent."id" JOIN "User" u ON u."id"=recent.peer
 WHERE u."role"=$2 AND NOT u."suspended" AND NOT EXISTS(SELECT 1 FROM "Block" WHERE ("userId"=$1 AND "blockedId"=u."id") OR ("userId"=u."id" AND "blockedId"=$1)) ORDER BY m."createdAt" DESC,m."ordinal" DESC LIMIT 100`, user.ID, user.Role)
	if err != nil {
		return err
	}
	defer rows.Close()
	type conversation struct {
		ID          string           `json:"id"`
		Nickname    string           `json:"nickname"`
		Body        string           `json:"body"`
		CreatedAt   jsonx.Time       `json:"createdAt"`
		UnreadCount int              `json:"unreadCount"`
		SenderID    string           `json:"senderId"`
		ReadAt      *time.Time       `json:"readAt"`
		Blocks      []communityBlock `json:"blocks"`
		Deleted     bool             `json:"deleted"`
	}
	out := make([]conversation, 0)
	for rows.Next() {
		var nickname string
		var unread int
		m, e := scanMessage(messageExtraRow{row: rows, extra: []any{&nickname, &unread}}, user.ID)
		if e != nil {
			return e
		}
		id := m.SenderID
		if id == user.ID {
			id = m.RecipientID
		}
		out = append(out, conversation{ID: id, Nickname: nickname, Body: m.Body, CreatedAt: m.CreatedAt, UnreadCount: unread, SenderID: m.SenderID, ReadAt: m.ReadAt, Blocks: m.Blocks, Deleted: m.Deleted})
	}
	if err = rows.Err(); err != nil {
		return err
	}
	httpx.OK(w, 200, out)
	return nil
}

type messageExtraRow struct {
	row   pgx.Row
	extra []any
}

func (r messageExtraRow) Scan(dest ...any) error { return r.row.Scan(append(dest, r.extra...)...) }

func (s *Server) createMessage(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		UserID    string           `json:"userId"`
		Body      string           `json:"body"`
		RequestID string           `json:"requestId"`
		Blocks    []communityBlock `json:"blocks"`
		ReplyToID string           `json:"replyToId"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	v.id(in.UserID)
	in.Body = strings.TrimSpace(in.Body)
	v.bounded(in.Body, 3000)
	v.check(in.Body != "" || len(in.Blocks) > 0, msgRequired)
	v.check(len(in.Blocks) <= 3, msgInput)
	if in.RequestID != "" {
		v.id(in.RequestID)
	}
	if in.ReplyToID != "" {
		v.id(in.ReplyToID)
	}
	if err := v.result(); err != nil {
		return err
	}
	ctx := r.Context()
	if _, err := s.peer(ctx, user, in.UserID); err != nil {
		return err
	}
	// Retry before resolving sources: a sent snapshot survives deletion of its original.
	if in.RequestID != "" {
		var existingID, recipient string
		err := s.pool.QueryRow(ctx, `SELECT "id","recipientId" FROM "Message" WHERE "senderId"=$1 AND "requestId"=$2`, user.ID, in.RequestID).Scan(&existingID, &recipient)
		if err == nil {
			if recipient != in.UserID {
				return apierr.New(409, "이미 다른 대화에 사용한 전송 요청이에요.")
			}
			m, e := s.messageView(ctx, user, existingID)
			if e != nil {
				return e
			}
			httpx.OK(w, 201, m)
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	// Shared canonicalization uses pool queries. Resolve before reserving a transaction
	// connection so simultaneous attachment sends cannot exhaust a small connection pool.
	blocks, err := s.canonicalBlocks(ctx, user, in.Blocks, false)
	if err != nil {
		return err
	}
	var id string
	err = s.lockedMessages(ctx, user.ID, func(tx pgx.Tx, _ *store.Queries) error {
		if err := messagePeerInTx(ctx, tx, user, in.UserID); err != nil {
			return err
		}
		if in.RequestID != "" {
			var recipient string
			err := tx.QueryRow(ctx, `SELECT "id","recipientId" FROM "Message" WHERE "senderId"=$1 AND "requestId"=$2`, user.ID, in.RequestID).Scan(&id, &recipient)
			if err == nil {
				if recipient != in.UserID {
					return apierr.New(409, "이미 다른 대화에 사용한 전송 요청이에요.")
				}
				return nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		// Serialize creation within this conversation so a cursor also reflects commit order.
		// The sender lock uses NO KEY UPDATE; simultaneous opposite-direction inserts may
		// still acquire their recipient's FK KEY SHARE lock without deadlocking.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array(LEAST($1::text,$2::text),GREATEST($1::text,$2::text))::text,10))`, user.ID, in.UserID); err != nil {
			return err
		}
		var reply any
		var replyID any
		if in.ReplyToID != "" {
			var snap messageReply
			var deleted bool
			err = tx.QueryRow(ctx, `SELECT m."id",m."body",m."senderId",m."deleted" FROM "Message" m WHERE `+messagePair+` AND m."id"=$3 FOR SHARE`, user.ID, in.UserID, in.ReplyToID).Scan(&snap.ID, &snap.Body, &snap.SenderID, &deleted)
			if errors.Is(err, pgx.ErrNoRows) || deleted {
				return apierr.New(404, "답장할 메시지를 찾을 수 없어요.")
			}
			if err != nil {
				return err
			}
			reply = jsonBytes(snap)
			replyID = snap.ID
		}
		var requestID any
		if in.RequestID != "" {
			requestID = in.RequestID
		}
		id = ids.New()
		_, err = tx.Exec(ctx, `INSERT INTO "Message"("id","senderId","recipientId","body","requestId","blocks","replyToId","replySnapshot","createdAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())`, id, user.ID, in.UserID, in.Body, requestID, jsonBytes(blocks), replyID, reply)
		return err
	})
	if err != nil {
		return err
	}
	m, err := s.messageView(ctx, user, id)
	if err != nil {
		return err
	}
	httpx.OK(w, 201, m)
	return nil
}

// Re-check both participants and the block graph in the mutation's transaction.
func messagePeerInTx(ctx context.Context, tx pgx.Tx, user store.User, peerID string) error {
	var role store.Role
	var suspended, blocked bool
	err := tx.QueryRow(ctx, `SELECT u."role",u."suspended",EXISTS(SELECT 1 FROM "Block" WHERE ("userId"=$1 AND "blockedId"=$2) OR ("userId"=$2 AND "blockedId"=$1)) FROM "User" u WHERE u."id"=$2`, user.ID, peerID).Scan(&role, &suspended, &blocked)
	if errors.Is(err, pgx.ErrNoRows) {
		return errPeerNotFound
	}
	if err != nil {
		return err
	}
	if role != user.Role || suspended || peerID == user.ID {
		return errPeerNotFound
	}
	if blocked {
		return errPeerBlocked
	}
	return nil
}
func (s *Server) lockedMessage(ctx context.Context, tx pgx.Tx, user store.User, id string) (messageRecord, error) {
	m, err := scanMessage(tx.QueryRow(ctx, `SELECT `+messageColumns+` FROM "Message" m WHERE m."id"=$2 AND $1 IN(m."senderId",m."recipientId") FOR UPDATE OF m`, user.ID, id), user.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return m, apierr.ErrMissing
	}
	if err != nil {
		return m, err
	}
	peer := m.SenderID
	if peer == user.ID {
		peer = m.RecipientID
	}
	return m, messagePeerInTx(ctx, tx, user, peer)
}
func (s *Server) readMessages(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		UserID    string `json:"userId"`
		ThroughID string `json:"throughId"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	v.id(in.UserID)
	v.id(in.ThroughID)
	if err := v.result(); err != nil {
		return err
	}
	ctx := r.Context()
	err := s.lockedMessages(ctx, user.ID, func(tx pgx.Tx, _ *store.Queries) error {
		if err := messagePeerInTx(ctx, tx, user, in.UserID); err != nil {
			return err
		}
		var boundary int64
		err := tx.QueryRow(ctx, `SELECT m."ordinal" FROM "Message" m WHERE `+messagePair+` AND m."id"=$3`, user.ID, in.UserID, in.ThroughID).Scan(&boundary)
		if errors.Is(err, pgx.ErrNoRows) {
			return apierr.ErrMissing
		}
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE "Message" SET "readAt"=CURRENT_TIMESTAMP WHERE "recipientId"=$1 AND "senderId"=$2 AND "ordinal"<=$3 AND "readAt" IS NULL AND NOT "deleted"`, user.ID, in.UserID, boundary)
		return err
	})
	if err != nil {
		return err
	}
	httpx.OK(w, 200, map[string]bool{"ok": true})
	return nil
}
func (s *Server) reactMessage(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		Reaction *string `json:"reaction"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	if in.Reaction != nil && *in.Reaction != "❤️" {
		return apierr.New(400, msgInput)
	}
	ctx := r.Context()
	id := r.PathValue("id")
	err := s.lockedMessages(ctx, user.ID, func(tx pgx.Tx, _ *store.Queries) error {
		m, err := s.lockedMessage(ctx, tx, user, id)
		if err != nil {
			return err
		}
		if m.Deleted {
			return apierr.ErrMissing
		}
		if in.Reaction == nil {
			_, err = tx.Exec(ctx, `DELETE FROM "MessageReaction" WHERE "messageId"=$1 AND "userId"=$2`, id, user.ID)
		} else {
			_, err = tx.Exec(ctx, `INSERT INTO "MessageReaction"("messageId","userId") VALUES($1,$2) ON CONFLICT DO NOTHING`, id, user.ID)
		}
		return err
	})
	if err != nil {
		return err
	}
	m, err := s.messageView(ctx, user, id)
	if err != nil {
		return err
	}
	httpx.OK(w, 200, m)
	return nil
}
func (s *Server) retractMessage(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	id := r.PathValue("id")
	err := s.lockedMessages(ctx, user.ID, func(tx pgx.Tx, _ *store.Queries) error {
		m, err := s.lockedMessage(ctx, tx, user, id)
		if err != nil {
			return err
		}
		if m.SenderID != user.ID {
			return apierr.New(403, "내 메시지만 삭제할 수 있어요.")
		}
		_, err = tx.Exec(ctx, `UPDATE "Message" SET "deleted"=true,"body"='',"blocks"='[]',"replySnapshot"=NULL,"replyToId"=NULL WHERE "id"=$1`, id)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `DELETE FROM "MessageReaction" WHERE "messageId"=$1`, id)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE "Message" SET "replySnapshot"=jsonb_build_object('id',$1::text,'body','','senderId',$2::text,'deleted',true) WHERE "replyToId"=$1`, id, user.ID)
		return err
	})
	if err != nil {
		return err
	}
	m, err := s.messageView(ctx, user, id)
	if err != nil {
		return err
	}
	httpx.OK(w, 200, m)
	return nil
}

// Serialize account writes compatibly with foreign-key checks from the other participant.
func (s *Server) lockedMessages(ctx context.Context, userID string, fn func(pgx.Tx, *store.Queries) error) error {
	return db.Tx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT "id" FROM "User" WHERE "id"=$1 FOR NO KEY UPDATE`, userID); err != nil {
			return err
		}
		return fn(tx, s.q.WithTx(tx))
	})
}
