package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/store"
)

// Learning actions use the immutable private snapshot and a separate idempotency ledger.
// They never manufacture a public Post or a private failed Attempt.
func (s *Server) messageBlockAction(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	messageID, blockID, action := r.PathValue("id"), r.PathValue("blockId"), r.PathValue("action")
	var in struct {
		Selected *int   `json:"selected"`
		Date     string `json:"date"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	if user.Role != store.RoleSTUDENT && action != "vote" {
		return apierr.New(403, "학생만 학습 자료를 가져올 수 있어요.")
	}
	key := action
	if action == "schedule" {
		v := &validator{}
		v.date(in.Date)
		if err := v.result(); err != nil {
			return err
		}
		key += ":" + in.Date
	}
	var result map[string]any
	var b communityBlock
	err := s.lockedMessages(ctx, user.ID, func(tx pgx.Tx, _ *store.Queries) error {
		m, err := s.lockedMessage(ctx, tx, user, messageID)
		if err != nil {
			return err
		}
		if m.Deleted {
			return apierr.ErrMissing
		}
		found := false
		for _, candidate := range m.Blocks {
			if candidate.ID == blockID {
				b = candidate
				found = true
				break
			}
		}
		if !found {
			return apierr.ErrMissing
		}
		expected := map[string]string{"solve": "QUESTION", "save-question": "QUESTION", "clone": "CARD", "schedule": "SCHEDULE", "vote": "POLL"}
		kind, ok := expected[action]
		if !ok {
			return apierr.ErrRouteNotFound
		}
		if kind != b.Type {
			return blockError()
		}
		if action == "solve" || action == "vote" {
			if in.Selected == nil || *in.Selected < 0 || *in.Selected >= len(stringList(b.Payload["options"])) {
				return blockError()
			}
		}
		var raw []byte
		err = tx.QueryRow(ctx, `SELECT "result" FROM "MessageAction" WHERE "userId"=$1 AND "messageId"=$2 AND "blockId"=$3 AND "kind"=$4`, user.ID, messageID, blockID, key).Scan(&raw)
		if err == nil {
			return json.Unmarshal(raw, &result)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		result = map[string]any{}
		switch action {
		case "solve":
			result = map[string]any{"selected": *in.Selected, "correct": *in.Selected == numberValue(b.Payload["answer"]), "answer": b.Payload["answer"], "explanation": b.Payload["explanation"]}
		case "vote":
			until, e := time.Parse(time.RFC3339, textValue(b.Payload["closesAt"]))
			if e != nil || !s.now().Before(until) {
				return apierr.New(409, "투표가 마감됐어요.")
			}
			result["selected"] = *in.Selected
		case "clone":
			id, subject, e := s.cloneBlockCard(ctx, tx, user, b)
			if e != nil {
				return e
			}
			// An account's default public-card setting must not expose a private conversation's copy.
			if _, e = tx.Exec(ctx, `DELETE FROM "CommunityCard" WHERE "cardId"=$1`, id); e != nil {
				return e
			}
			result["id"], result["subjectId"] = id, subject
		case "save-question":
			subject, e := s.communitySubject(ctx, tx, user, textValue(b.Payload["subjectName"]))
			if e != nil {
				return e
			}
			material, id := ids.New(), ids.New()
			_, e = tx.Exec(ctx, `INSERT INTO "Material"("id","userId","subjectId","title","content","type") VALUES($1,$2,$3,'메시지에서 가져온 문제',$4,'TXT')`, material, user.ID, subject, textValue(b.Payload["citation"]))
			if e != nil {
				return e
			}
			_, e = tx.Exec(ctx, `INSERT INTO "Question"("id","userId","subjectId","materialId","prompt","options","answer","explanation","citation","past","future") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'','')`, id, user.ID, subject, material, textValue(b.Payload["prompt"]), stringList(b.Payload["options"]), numberValue(b.Payload["answer"]), textValue(b.Payload["explanation"]), textValue(b.Payload["citation"]))
			if e != nil {
				return e
			}
			_, e = tx.Exec(ctx, `INSERT INTO "MessageSavedQuestion"("userId","questionId","messageId") VALUES($1,$2,$3)`, user.ID, id, messageID)
			if e != nil {
				return e
			}
			result["id"], result["subjectId"] = id, subject
		case "schedule":
			var rows []map[string]any
			if e := json.Unmarshal(jsonBytes(b.Payload["rows"]), &rows); e != nil {
				return e
			}
			created, skipped := 0, 0
			for _, row := range rows {
				if textValue(row["kind"]) != "FLEXIBLE" {
					skipped++
					continue
				}
				start, end := textValue(row["start"]), textValue(row["end"])
				v := &validator{}
				v.clock(start)
				v.clock(end)
				if v.result() != nil || start >= end {
					return blockError()
				}
				var conflict bool
				if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "Schedule" WHERE "userId"=$1 AND "date"=$2 AND "start"<$4 AND "end">$3)`, user.ID, in.Date, start, end).Scan(&conflict); e != nil {
					return e
				}
				if conflict {
					skipped++
					continue
				}
				_, e := tx.Exec(ctx, `INSERT INTO "Schedule"("id","userId","title","date","start","end","kind") VALUES($1,$2,$3,$4,$5,$6,'FLEXIBLE')`, ids.New(), user.ID, textValue(row["title"]), in.Date, start, end)
				if e != nil {
					return e
				}
				created++
			}
			result["created"], result["skipped"] = created, skipped
		}
		_, err = tx.Exec(ctx, `INSERT INTO "MessageAction"("userId","messageId","blockId","kind","result") VALUES($1,$2,$3,$4,$5)`, user.ID, messageID, blockID, key, jsonBytes(result))
		return err
	})
	if err != nil {
		return err
	}
	if action == "solve" || action == "vote" {
		stats, e := s.messageBlockStats(ctx, user.ID, messageID, b)
		if e != nil {
			return e
		}
		result["stats"] = stats
	}
	httpx.OK(w, 200, result)
	return nil
}
func (s *Server) messageBlockStats(ctx context.Context, userID, messageID string, b communityBlock) (map[string]any, error) {
	var attempts, correct int
	err := s.pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE "result"->>'correct'='true') FROM "MessageAction" WHERE "messageId"=$1 AND "blockId"=$2 AND "kind"='solve'`, messageID, b.ID).Scan(&attempts, &correct)
	if err != nil {
		return nil, err
	}
	out := map[string]any{"attempts": attempts, "correct": correct}
	if b.Type == "POLL" {
		votes := make([]int, len(stringList(b.Payload["options"])))
		rows, e := s.pool.Query(ctx, `SELECT ("result"->>'selected')::int,count(*),bool_or("userId"=$3) FROM "MessageAction" WHERE "messageId"=$1 AND "blockId"=$2 AND "kind"='vote' GROUP BY 1`, messageID, b.ID, userID)
		if e != nil {
			return nil, e
		}
		defer rows.Close()
		for rows.Next() {
			var n, c int
			var mine bool
			if e = rows.Scan(&n, &c, &mine); e != nil {
				return nil, e
			}
			if n >= 0 && n < len(votes) {
				votes[n] = c
				if mine {
					out["voted"] = n
				}
			}
		}
		if e = rows.Err(); e != nil {
			return nil, e
		}
		out["votes"] = votes
	}
	return out, nil
}

// Polling a full page performs one aggregate query, not one query per attachment.
func (s *Server) decorateMessages(ctx context.Context, userID string, messages []messageRecord) error {
	type blockKey struct{ messageID, blockID string }
	blocks := map[blockKey]*communityBlock{}
	messageIDs := make([]string, 0, len(messages))
	for i := range messages {
		m := &messages[i]
		hasStats := false
		for j := range m.Blocks {
			b := &m.Blocks[j]
			if b.Type != "QUESTION" && b.Type != "POLL" {
				continue
			}
			b.Stats = map[string]any{"attempts": 0, "correct": 0}
			if b.Type == "POLL" {
				b.Stats["votes"] = make([]int, len(stringList(b.Payload["options"])))
			}
			blocks[blockKey{m.ID, b.ID}] = b
			hasStats = true
		}
		if hasStats {
			messageIDs = append(messageIDs, m.ID)
		}
	}
	if len(messageIDs) == 0 {
		return nil
	}
	rows, err := s.pool.Query(ctx, `SELECT "messageId","blockId","kind",("result"->>'selected')::int,count(*),count(*) FILTER(WHERE "result"->>'correct'='true'),bool_or("userId"=$2) FROM "MessageAction" WHERE "messageId"=ANY($1::text[]) AND "kind" IN('solve','vote') GROUP BY 1,2,3,4`, messageIDs, userID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var messageID, blockID, kind string
		var selected, count, correct int
		var mine bool
		if err = rows.Scan(&messageID, &blockID, &kind, &selected, &count, &correct, &mine); err != nil {
			return err
		}
		b := blocks[blockKey{messageID, blockID}]
		if b == nil {
			continue
		}
		if kind == "solve" {
			b.Stats["attempts"] = b.Stats["attempts"].(int) + count
			b.Stats["correct"] = b.Stats["correct"].(int) + correct
		} else if b.Type == "POLL" {
			votes := b.Stats["votes"].([]int)
			if selected >= 0 && selected < len(votes) {
				votes[selected] = count
				if mine {
					b.Stats["voted"] = selected
				}
			}
		}
	}
	return rows.Err()
}
