package api

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/store"
	"net/http"
	"time"
)

func (s *Server) communityBlockAction(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	postID := r.PathValue("id")
	blockID := r.PathValue("blockId")
	action := r.PathValue("action")
	b, e := s.blockFor(ctx, user, postID, blockID)
	if e != nil {
		return e
	}
	var in struct {
		Selected *int   `json:"selected"`
		Date     string `json:"date"`
	}
	if e = httpx.Decode(r, &in); e != nil {
		return e
	}
	if user.Role != store.RoleSTUDENT && action != "vote" {
		return apierr.New(403, "학생만 학습 자료를 가져올 수 있어요.")
	}
	switch action {
	case "solve":
		if b.Type != "QUESTION" {
			return blockError()
		}
	case "vote":
		if b.Type != "POLL" {
			return blockError()
		}
	case "clone":
		if b.Type != "CARD" {
			return blockError()
		}
	case "save-question":
		if b.Type != "QUESTION" {
			return blockError()
		}
	case "schedule":
		if b.Type != "SCHEDULE" {
			return blockError()
		}
	default:
		return apierr.ErrRouteNotFound
	}
	if action == "solve" || action == "vote" {
		if in.Selected == nil || *in.Selected < 0 || *in.Selected >= len(stringList(b.Payload["options"])) {
			return blockError()
		}
	}
	key := action
	if action == "schedule" {
		v := &validator{}
		v.date(in.Date)
		if e = v.result(); e != nil {
			return e
		}
		key += ":" + in.Date
	}
	var result map[string]any
	e = s.locked(ctx, user.ID, func(tx pgx.Tx, q *store.Queries) error {
		var raw []byte
		err := tx.QueryRow(ctx, `SELECT "result" FROM "CommunityAction" WHERE "userId"=$1 AND "postId"=$2 AND "blockId"=$3 AND "kind"=$4`, user.ID, postID, blockID, key).Scan(&raw)
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
			until, err := time.Parse(time.RFC3339, textValue(b.Payload["closesAt"]))
			if err != nil || !s.now().Before(until) {
				return apierr.New(409, "투표가 마감됐어요.")
			}
			result["selected"] = *in.Selected
		case "clone":
			id, subject, err := s.cloneBlockCard(ctx, tx, user, b)
			if err != nil {
				return err
			}
			result["id"] = id
			result["subjectId"] = subject
		case "save-question":
			subject, err := s.communitySubject(ctx, tx, user, textValue(b.Payload["subjectName"]))
			if err != nil {
				return err
			}
			material := ids.New()
			id := ids.New()
			_, err = tx.Exec(ctx, `INSERT INTO "Material"("id","userId","subjectId","title","content","type") VALUES($1,$2,$3,'커뮤니티에서 가져온 문제',$4,'TXT')`, material, user.ID, subject, textValue(b.Payload["citation"]))
			if err != nil {
				return err
			}
			_, err = tx.Exec(ctx, `INSERT INTO "Question"("id","userId","subjectId","materialId","prompt","options","answer","explanation","citation","past","future") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'','')`, id, user.ID, subject, material, textValue(b.Payload["prompt"]), stringList(b.Payload["options"]), numberValue(b.Payload["answer"]), textValue(b.Payload["explanation"]), textValue(b.Payload["citation"]))
			if err != nil {
				return err
			}
			// Explicit save creates a review entry; it is never counted as a failed private attempt.
			_, err = tx.Exec(ctx, `INSERT INTO "CommunitySavedQuestion"("userId","questionId","postId") VALUES($1,$2,$3)`, user.ID, id, postID)
			if err != nil {
				return err
			}
			result["id"] = id
			result["subjectId"] = subject
		case "schedule":
			var rows []map[string]any
			_ = json.Unmarshal(jsonBytes(b.Payload["rows"]), &rows)
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
				err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "Schedule" WHERE "userId"=$1 AND "date"=$2 AND "start"<$4 AND "end">$3)`, user.ID, in.Date, start, end).Scan(&conflict)
				if err != nil {
					return err
				}
				if conflict {
					skipped++
					continue
				}
				_, err = tx.Exec(ctx, `INSERT INTO "Schedule"("id","userId","title","date","start","end","kind") VALUES($1,$2,$3,$4,$5,$6,'FLEXIBLE')`, ids.New(), user.ID, textValue(row["title"]), in.Date, start, end)
				if err != nil {
					return err
				}
				created++
			}
			result["created"] = created
			result["skipped"] = skipped
		}
		_, err = tx.Exec(ctx, `INSERT INTO "CommunityAction"("userId","postId","blockId","kind","result") VALUES($1,$2,$3,$4,$5)`, user.ID, postID, blockID, key, jsonBytes(result))
		return err
	})
	if e != nil {
		return e
	}
	if action == "solve" || action == "vote" {
		result["stats"] = s.blockStats(ctx, user.ID, postID, b)
	}
	httpx.OK(w, 200, result)
	return nil
}
func (s *Server) cloneBlockCard(ctx context.Context, tx pgx.Tx, user store.User, b communityBlock) (string, string, error) {
	subject, e := s.communitySubject(ctx, tx, user, textValue(b.Payload["subjectName"]))
	if e != nil {
		return "", "", e
	}
	id := ids.New()
	kind := textValue(b.Payload["type"])
	if kind != "CONCEPT" && kind != "BLIND" && kind != "RELATION" && kind != "COMPARISON" {
		kind = "CONCEPT"
	}
	masks := b.Payload["masks"]
	if masks == nil {
		masks = []any{}
	}
	_, e = tx.Exec(ctx, `INSERT INTO "Card"("id","userId","subjectId","front","back","type","bucket","image","masks","diagram","maskedNodeIds","sourceKind") VALUES($1,$2,$3,$4,$5,$6,'AGAIN',$7,$8,$9,$10,$11)`, id, user.ID, subject, textValue(b.Payload["front"]), textValue(b.Payload["back"]), kind, b.Payload["image"], jsonBytes(masks), jsonBytes(b.Payload["diagram"]), stringList(b.Payload["maskedNodeIds"]), "COMMUNITY")
	return id, subject, e
}
