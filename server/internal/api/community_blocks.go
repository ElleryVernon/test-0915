package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"memoryz/server/internal/blob"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/store"
)

type communityBlock struct {
	ID            string         `json:"id"`
	Type          string         `json:"type"`
	RefID         string         `json:"refId,omitempty"`
	Hidden        bool           `json:"hidden"`
	Payload       map[string]any `json:"payload"`
	Stats         map[string]any `json:"stats,omitempty"`
	SourceDeleted bool           `json:"sourceDeleted,omitempty"`
}

func jsonBytes(v any) []byte { b, _ := json.Marshal(v); return b }
func textValue(v any) string { s, _ := v.(string); return s }
func blockError() error      { return apierr.New(400, "첨부 내용을 다시 확인해 주세요.") }
func stringList(v any) []string {
	b := jsonBytes(v)
	var out []string
	_ = json.Unmarshal(b, &out)
	return out
}
func numberValue(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	}
	return -1
}

// Canonical snapshots never trust a client supplied answer, private subject, or document body.
func (s *Server) canonicalBlocks(ctx context.Context, user store.User, blocks []communityBlock, comment bool) ([]communityBlock, error) {
	limit := 5
	if comment {
		limit = 1
	}
	if len(blocks) > limit {
		return nil, blockError()
	}
	out := make([]communityBlock, 0, len(blocks))
	seen := map[string]bool{}
	photos := 0
	for _, b := range blocks {
		if b.ID == "" || len(b.ID) > 100 || seen[b.ID] {
			return nil, blockError()
		}
		seen[b.ID] = true
		b.Stats = nil
		b.SourceDeleted = false
		if user.Role == store.RolePARENT && b.Type != "PHOTO" && b.Type != "POLL" {
			return nil, apierr.New(403, "학생 학습 자료는 학생 커뮤니티에서만 공유할 수 있어요.")
		}
		if comment && b.Type != "QUESTION" && b.Type != "CARD" && b.Type != "PHOTO" && b.Type != "MATH" {
			return nil, blockError()
		}
		p := map[string]any{}
		switch b.Type {
		case "QUESTION":
			q, e := s.q.GetOwnedQuestion(ctx, store.GetOwnedQuestionParams{ID: b.RefID, UserID: user.ID})
			if e != nil {
				return nil, apierr.New(404, "내 문제에서 다시 선택해 주세요.")
			}
			p = map[string]any{"prompt": q.Prompt, "options": q.Options, "answer": q.Answer, "explanation": q.Explanation, "citation": q.Citation, "subjectName": s.subjectName(ctx, q.SubjectID)}
			if n := numberValue(b.Payload["selected"]); n >= 0 && n < len(q.Options) {
				p["selected"] = n
			}
		case "CARD":
			c, e := s.q.GetOwnedLiveCard(ctx, store.GetOwnedLiveCardParams{ID: b.RefID, UserID: user.ID})
			if e != nil {
				return nil, apierr.New(404, "내 카드에서 다시 선택해 주세요.")
			}
			p = s.cardPayload(ctx, c)
			if c.Image != nil && p["image"] == nil {
				return nil, apierr.New(400, "카드 이미지를 확인할 수 없어요. 이미지를 다시 등록한 뒤 공유해 주세요.")
			}
		case "ESSAY":
			e, err := s.q.GetOwnedEssay(ctx, store.GetOwnedEssayParams{ID: b.RefID, UserID: user.ID})
			if err != nil {
				return nil, apierr.New(404, "내 서술형 문제에서 다시 선택해 주세요.")
			}
			p = map[string]any{"prompt": e.Prompt, "answer": e.ModelAnswer, "subjectName": s.subjectName(ctx, e.SubjectID)}
			// A learner can explicitly share their answer, but never a client invented grading score.
			if a := strings.TrimSpace(textValue(b.Payload["answer"])); a != "" && len([]rune(a)) <= 10000 {
				p["answer"] = a
				var score *int32
				if err := s.pool.QueryRow(ctx, `SELECT "score" FROM "Attempt" WHERE "userId"=$1 AND "essayId"=$2 AND "answer"=$3 ORDER BY "createdAt" DESC LIMIT 1`, user.ID, e.ID, a).Scan(&score); err == nil && score != nil {
					p["score"] = *score
				}
			}
		case "MATERIAL":
			var title, body, subject string
			e := s.pool.QueryRow(ctx, `SELECT m."title",m."content",s."name" FROM "Material" m JOIN "Subject" s ON s."id"=m."subjectId" WHERE m."id"=$1 AND m."userId"=$2 AND NOT s."deleted"`, b.RefID, user.ID).Scan(&title, &body, &subject)
			if e != nil {
				return nil, apierr.New(404, "내 자료에서 다시 선택해 주세요.")
			}
			excerpt := strings.TrimSpace(textValue(b.Payload["text"]))
			if excerpt == "" || len([]rune(excerpt)) > 2000 || !strings.Contains(body, excerpt) {
				return nil, apierr.New(400, "원문에 있는 짧은 부분을 선택해 주세요.")
			}
			count := 0
			runes := []rune(excerpt)
			for i, ch := range runes {
				if ch == '.' || ch == '!' || ch == '?' || ch == '。' {
					if i+1 == len(runes) || runes[i+1] == ' ' || runes[i+1] == '\n' || runes[i+1] == '\r' {
						count++
					}
				}
			}
			if count > 3 {
				return nil, apierr.New(400, "자료는 세 문장까지만 공유할 수 있어요.")
			}
			p = map[string]any{"title": title, "text": excerpt, "subjectName": subject}
			if page := numberValue(b.Payload["page"]); page > 0 {
				p["page"] = page
			}
		case "PHOTO":
			photos++
			img := textValue(b.Payload["image"])
			if photos > 4 || len(img) > 650000 {
				return nil, apierr.New(400, "사진 크기를 줄여 다시 첨부해 주세요.")
			}
			parts := strings.SplitN(img, ",", 2)
			if len(parts) != 2 {
				return nil, blockError()
			}
			if parts[0] != "data:image/jpeg;base64" && parts[0] != "data:image/png;base64" && parts[0] != "data:image/webp;base64" {
				return nil, blockError()
			}
			raw, e := base64.StdEncoding.DecodeString(parts[1])
			if e != nil || len(raw) == 0 {
				return nil, blockError()
			}
			mime := http.DetectContentType(raw)
			if !strings.HasPrefix(parts[0], "data:"+mime+";") {
				return nil, blockError()
			}
			caption := textValue(b.Payload["caption"])
			if len([]rune(caption)) > 500 {
				return nil, blockError()
			}
			p = map[string]any{"image": img, "caption": caption}
			b.RefID = ""
		case "POLL":
			opts := stringList(b.Payload["options"])
			question := strings.TrimSpace(textValue(b.Payload["question"]))
			if question == "" || len([]rune(question)) > 300 || len(opts) < 2 || len(opts) > 6 {
				return nil, blockError()
			}
			for _, opt := range opts {
				if strings.TrimSpace(opt) == "" || len([]rune(opt)) > 100 {
					return nil, blockError()
				}
			}
			p = map[string]any{"question": question, "options": opts, "closesAt": s.now().Add(24 * time.Hour).Format(time.RFC3339)}
			b.RefID = ""
		case "SCHEDULE":
			var requested []map[string]any
			_ = json.Unmarshal(jsonBytes(b.Payload["rows"]), &requested)
			if len(requested) == 0 || len(requested) > 24 {
				return nil, blockError()
			}
			rows := make([]map[string]any, 0, len(requested))
			for _, req := range requested {
				var title, date, start, end, kind string
				id := textValue(req["id"])
				e := s.pool.QueryRow(ctx, `SELECT "title","date","start","end","kind" FROM "Schedule" WHERE "userId"=$1 AND ("id"=$2 OR ($2='' AND "date"=$3 AND "start"=$4 AND "end"=$5)) LIMIT 1`, user.ID, id, textValue(req["date"]), textValue(req["start"]), textValue(req["end"])).Scan(&title, &date, &start, &end, &kind)
				if e != nil {
					return nil, apierr.New(404, "내 시간표에서 다시 선택해 주세요.")
				}
				if kind == "FIXED" {
					title = "학교"
				}
				rows = append(rows, map[string]any{"title": title, "date": date, "start": start, "end": end, "kind": kind})
			}
			p["rows"] = rows
			b.RefID = ""
		case "MATH":
			value := strings.TrimSpace(textValue(b.Payload["text"]))
			if value == "" || len([]rune(value)) > 2000 {
				return nil, blockError()
			}
			p["text"] = value
			b.RefID = ""
		default:
			return nil, blockError()
		}
		b.Payload = p
		out = append(out, b)
	}
	return out, nil
}
func (s *Server) subjectName(ctx context.Context, id string) string {
	var name string
	_ = s.pool.QueryRow(ctx, `SELECT "name" FROM "Subject" WHERE "id"=$1`, id).Scan(&name)
	return name
}
func (s *Server) cardPayload(ctx context.Context, c store.Card) map[string]any {
	var masks, diagram any
	_ = json.Unmarshal(c.Masks, &masks)
	_ = json.Unmarshal(c.Diagram, &diagram)
	return map[string]any{"front": c.Front, "back": c.Back, "type": c.Type, "image": s.communityCardImage(ctx, c), "masks": masks, "diagram": diagram, "maskedNodeIds": c.MaskedNodeIds, "subjectName": s.subjectName(ctx, c.SubjectID)}
}
func (s *Server) blockFor(ctx context.Context, user store.User, postID, blockID string) (communityBlock, error) {
	if _, err := s.accessiblePost(ctx, user, postID); err != nil {
		return communityBlock{}, err
	}
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT b FROM "CommunityPost" p CROSS JOIN LATERAL jsonb_array_elements(p."blocks") b WHERE p."postId"=$1 AND b->>'id'=$2 UNION ALL SELECT cc."block" FROM "CommunityComment" cc JOIN "Comment" c ON c."id"=cc."commentId" JOIN "User" u ON u."id"=c."userId" WHERE c."postId"=$1 AND NOT cc."deleted" AND cc."block"->>'id'=$2 AND NOT u."suspended" AND NOT EXISTS(SELECT 1 FROM "Block" WHERE ("userId"=$3 AND "blockedId"=c."userId") OR ("userId"=c."userId" AND "blockedId"=$3)) LIMIT 1`, postID, blockID, user.ID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return communityBlock{}, apierr.New(404, "첨부를 찾을 수 없어요.")
	}
	var b communityBlock
	if err == nil {
		err = json.Unmarshal(raw, &b)
	}
	return b, err
}
func (s *Server) blockStats(ctx context.Context, userID, postID string, b communityBlock) map[string]any {
	out := map[string]any{"attempts": 0, "correct": 0}
	var attempts, correct int
	_ = s.pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE "result"->>'correct'='true') FROM "CommunityAction" WHERE "postId"=$1 AND "blockId"=$2 AND "kind"='solve'`, postID, b.ID).Scan(&attempts, &correct)
	out["attempts"] = attempts
	out["correct"] = correct
	if b.Type == "POLL" {
		votes := make([]int, len(stringList(b.Payload["options"])))
		rows, e := s.pool.Query(ctx, `SELECT ("result"->>'selected')::int,count(*) FROM "CommunityAction" WHERE "postId"=$1 AND "blockId"=$2 AND "kind"='vote' GROUP BY 1`, postID, b.ID)
		if e == nil {
			defer rows.Close()
			for rows.Next() {
				var n, c int
				if rows.Scan(&n, &c) == nil && n >= 0 && n < len(votes) {
					votes[n] = c
				}
			}
		}
		out["votes"] = votes
		var n int
		e = s.pool.QueryRow(ctx, `SELECT ("result"->>'selected')::int FROM "CommunityAction" WHERE "postId"=$1 AND "blockId"=$2 AND "userId"=$3 AND "kind"='vote'`, postID, b.ID, userID).Scan(&n)
		if e == nil {
			out["voted"] = n
		}
	}
	return out
}
func (s *Server) communitySubject(ctx context.Context, tx pgx.Tx, user store.User, name string) (string, error) {
	if name == "" {
		name = "커뮤니티 학습"
	}
	var id string
	err := tx.QueryRow(ctx, `SELECT "id" FROM "Subject" WHERE "userId"=$1 AND "name"=$2 AND NOT "deleted" ORDER BY "createdAt" LIMIT 1`, user.ID, name).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		id = ids.New()
		_, err = tx.Exec(ctx, `INSERT INTO "Subject"("id","userId","name") VALUES($1,$2,$3)`, id, user.ID, name)
	}
	return id, err
}

// Published snapshots own their bytes: never disclose a private upload URL or depend on its lifetime.
func (s *Server) communityCardImage(ctx context.Context, c store.Card) any {
	if c.Image == nil {
		return nil
	}
	value := *c.Image
	if dataImage.MatchString(value) {
		return value
	}
	parts := strings.Split(value, "/")
	var key string
	if len(parts) == 4 && parts[1] == "api" && parts[2] == "uploads" {
		if _, e := s.q.GetOwnedUpload(ctx, store.GetOwnedUploadParams{ID: parts[3], UserID: c.UserID}); e != nil {
			return nil
		}
		key = blob.UploadKey(parts[3])
	} else if len(parts) == 6 && parts[1] == "api" && parts[2] == "uploads" && parts[4] == "images" {
		if _, e := s.q.GetOwnedUploadImage(ctx, store.GetOwnedUploadImageParams{ID: parts[5], UploadID: parts[3], UserID: c.UserID}); e != nil {
			return nil
		}
		key = blob.ImageKey(parts[3], parts[5])
	} else {
		return nil
	}
	obj, e := s.blobs.Get(ctx, key)
	if e != nil {
		return nil
	}
	defer obj.Close()
	raw, e := io.ReadAll(io.LimitReader(obj, 2_000_001))
	if e != nil || len(raw) > 2_000_000 {
		return nil
	}
	mime := http.DetectContentType(raw)
	if mime != "image/jpeg" && mime != "image/png" && mime != "image/webp" {
		return nil
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw)
}
