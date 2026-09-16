package api

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/jsonx"
	"memoryz/server/internal/store"
	"net/http"
	"strings"
	"time"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/posts/{id}", httpx.Methods{http.MethodGet: s.withUser(s.getCommunityPost, communityRoles...), http.MethodPatch: s.withUser(s.editCommunityPost, communityRoles...), http.MethodDelete: s.withUser(s.deleteCommunityPost, communityRoles...)})
		mux.Handle("/api/posts/{id}/accept", httpx.Methods{http.MethodPost: s.withUser(s.acceptCommunityAnswer, store.RoleSTUDENT)})
		mux.Handle("/api/posts/{id}/blocks/{blockId}/{action}", httpx.Methods{http.MethodPost: s.withUser(s.communityBlockAction, communityRoles...)})
	})
}

type communityPostInput struct {
	Title     string           `json:"title"`
	Body      string           `json:"body"`
	Category  string           `json:"category"`
	Anonymous *bool            `json:"anonymous"`
	Scope     string           `json:"scope"`
	Blocks    []communityBlock `json:"blocks"`
	Tags      map[string]any   `json:"tags"`
	SourceRef map[string]any   `json:"sourceRef"`
	RequestID string           `json:"requestId"`
}

func (s *Server) canonicalPost(ctx context.Context, user store.User, in *communityPostInput) error {
	v := &validator{}
	in.Title = v.text(in.Title, 120)
	if len(in.Blocks) > 0 {
		in.Body = strings.TrimSpace(in.Body)
		v.check(len([]rune(in.Body)) <= 10000, msgInput)
	} else {
		in.Body = v.text(in.Body, 10000)
	}
	in.Category = v.text(in.Category, 30)
	v.check(in.Anonymous != nil, msgInput)
	v.check(len(in.RequestID) <= 100, msgInput)
	if e := v.result(); e != nil {
		return e
	}
	originals, _ := ctx.Value(communityEditSnapshots{}).(map[string]communityBlock)
	blocks := make([]communityBlock, 0, len(in.Blocks))
	var e error
	seen := map[string]bool{}
	if len(in.Blocks) > 5 {
		return blockError()
	}
	for _, incoming := range in.Blocks {
		if seen[incoming.ID] {
			return blockError()
		}
		seen[incoming.ID] = true
		if old, ok := originals[incoming.ID]; ok && old.Type == incoming.Type && old.RefID == incoming.RefID && equalBlockContent(old, incoming) {
			old.Hidden = incoming.Hidden
			blocks = append(blocks, old)
			continue
		}
		var fresh []communityBlock
		fresh, e = s.canonicalBlocks(ctx, user, []communityBlock{incoming}, false)
		if e != nil {
			return e
		}
		blocks = append(blocks, fresh...)
	}
	photos := 0
	for _, block := range blocks {
		if block.Type == "PHOTO" {
			photos++
		}
	}
	if photos > 4 {
		return blockError()
	}
	if e != nil {
		return e
	}
	in.Blocks = blocks
	if len(jsonBytes(blocks)) > 2_700_000 {
		return apierr.New(400, "첨부 용량이 커요. 사진이나 카드를 줄여 다시 시도해 주세요.")
	}
	tags := map[string]any{}
	if user.Role == store.RoleSTUDENT {
		if user.Grade != "" && textValue(in.Tags["grade"]) != "" {
			tags["grade"] = user.Grade
		}
		if id := textValue(in.Tags["subjectId"]); id != "" {
			sub, e := s.ownedSubject(ctx, user, id)
			if e != nil {
				return e
			}
			tags["subjectId"] = id
			tags["subjectName"] = sub.Name
		}
		if n := numberValue(in.Tags["examDday"]); n >= 0 && n <= 365 {
			tags["examDday"] = n
		}
	}
	in.Tags = tags
	if in.SourceRef != nil {
		valid := false
		for _, b := range blocks {
			for _, key := range []string{"questionId", "cardId", "essayId"} {
				if b.RefID != "" && textValue(in.SourceRef[key]) == b.RefID {
					valid = true
				}
			}
		}
		if !valid {
			return apierr.New(400, "학습 연결 자료를 다시 선택해 주세요.")
		}
		for key, typ := range map[string]string{"questionId": "QUESTION", "cardId": "CARD", "essayId": "ESSAY"} {
			if ref := textValue(in.SourceRef[key]); ref != "" {
				matched := false
				for _, b := range blocks {
					if b.Type == typ && b.RefID == ref {
						matched = true
					}
				}
				if !matched {
					return blockError()
				}
			}
		}
		clean := map[string]any{}
		for _, key := range []string{"kind", "questionId", "cardId", "essayId", "nodeId"} {
			if val := textValue(in.SourceRef[key]); val != "" && len(val) <= 100 {
				clean[key] = val
			}
		}
		in.SourceRef = clean
	}
	return nil
}
func (s *Server) saveNewCommunityPost(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in communityPostInput
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	if in.RequestID != "" && len(in.RequestID) <= 100 {
		var existing string
		err := s.pool.QueryRow(r.Context(), `SELECT "postId" FROM "CommunityPost" WHERE "userId"=$1 AND "requestId"=$2`, user.ID, in.RequestID).Scan(&existing)
		if err == nil {
			view, e := s.communityPostView(r.Context(), user, existing)
			if e != nil {
				return e
			}
			httpx.OK(w, 201, view)
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	if e := s.canonicalPost(r.Context(), user, &in); e != nil {
		return e
	}
	school := ""
	if in.Scope == "school" {
		school = strings.TrimSpace(user.School)
		if school == "" {
			return apierr.New(400, "프로필에 학교를 등록해 주세요.")
		}
	} else if in.Scope != "" && in.Scope != "all" {
		return blockError()
	}
	var id string
	ctx := r.Context()
	err := s.locked(ctx, user.ID, func(tx pgx.Tx, q *store.Queries) error {
		if in.RequestID != "" {
			e := tx.QueryRow(ctx, `SELECT "postId" FROM "CommunityPost" WHERE "userId"=$1 AND "requestId"=$2`, user.ID, in.RequestID).Scan(&id)
			if e == nil {
				return nil
			}
			if !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
		}
		p, e := q.CreatePost(ctx, store.CreatePostParams{ID: ids.New(), UserID: user.ID, Role: user.Role, Category: in.Category, Title: in.Title, Body: in.Body, Anonymous: *in.Anonymous, School: school})
		if e != nil {
			return e
		}
		id = p.ID
		_, e = tx.Exec(ctx, `INSERT INTO "CommunityPost"("postId","userId","blocks","tags","sourceRef","requestId") VALUES($1,$2,$3,$4,$5,NULLIF($6,''))`, id, user.ID, jsonBytes(in.Blocks), jsonBytes(in.Tags), jsonBytes(in.SourceRef), in.RequestID)
		return e
	})
	if err != nil {
		return err
	}
	view, err := s.communityPostView(ctx, user, id)
	if err != nil {
		return err
	}
	httpx.OK(w, 201, view)
	return nil
}
func (s *Server) communityPostView(ctx context.Context, user store.User, id string) (PostView, error) {
	p, e := s.accessiblePost(ctx, user, id)
	if e != nil {
		return PostView{}, e
	}
	var name string
	_ = s.pool.QueryRow(ctx, `SELECT "nickname" FROM "User" WHERE "id"=$1`, p.UserID).Scan(&name)
	view := PostView{ID: p.ID, School: p.School, Author: name, AuthorID: p.UserID, Role: p.Role, Category: p.Category, Title: p.Title, Body: p.Body, Anonymous: p.Anonymous, CreatedAt: jsonx.Time(p.CreatedAt), IsMine: p.UserID == user.ID}
	if p.Anonymous {
		view.Author = "익명"
		view.AuthorID = ""
	}
	e = s.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM "PostLike" WHERE "postId"=$1),EXISTS(SELECT 1 FROM "PostLike" WHERE "postId"=$1 AND "userId"=$2),EXISTS(SELECT 1 FROM "PostSave" WHERE "postId"=$1 AND "userId"=$2),(SELECT count(*) FROM "Comment" WHERE "postId"=$1)`, id, user.ID).Scan(&view.Likes, &view.Liked, &view.Saved, &view.CommentCount)
	if e != nil {
		return view, e
	}
	e = s.enrichCommunityPost(ctx, user, &view)
	return view, e
}
func (s *Server) enrichCommunityPost(ctx context.Context, user store.User, p *PostView) error {
	var raw, tags, source []byte
	var edited, solved *time.Time
	var accepted *string
	var owner string
	err := s.pool.QueryRow(ctx, `SELECT p."userId",COALESCE(c."blocks",'[]'),COALESCE(c."tags",'{}'),c."sourceRef",c."editedAt",c."solvedAt",c."acceptedCommentId" FROM "Post" p LEFT JOIN "CommunityPost" c ON c."postId"=p."id" WHERE p."id"=$1`, p.ID).Scan(&owner, &raw, &tags, &source, &edited, &solved, &accepted)
	if err != nil {
		return err
	}
	p.IsMine = owner == user.ID
	p.EditedAt = edited
	p.SolvedAt = solved
	p.AcceptedCommentID = accepted
	p.Status = "OPEN"
	if solved != nil {
		p.Status = "SOLVED"
	}
	_ = json.Unmarshal(raw, &p.Blocks)
	_ = json.Unmarshal(tags, &p.Tags)
	if p.Anonymous && !p.IsMine {
		delete(p.Tags, "subjectId")
	}
	if p.IsMine {
		_ = json.Unmarshal(source, &p.SourceRef)
	}
	for i := range p.Blocks {
		b := &p.Blocks[i]
		if b.Type == "QUESTION" || b.Type == "POLL" {
			b.Stats = s.blockStats(ctx, user.ID, p.ID, *b)
		}
		if b.RefID != "" {
			var live bool
			switch b.Type {
			case "QUESTION":
				_ = s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "Question" q JOIN "Subject" s ON s."id"=q."subjectId" WHERE q."id"=$1 AND NOT s."deleted")`, b.RefID).Scan(&live)
			case "CARD":
				_ = s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "Card" c JOIN "Subject" s ON s."id"=c."subjectId" WHERE c."id"=$1 AND NOT c."deleted" AND NOT s."deleted")`, b.RefID).Scan(&live)
			case "MATERIAL":
				_ = s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "Material" m JOIN "Subject" s ON s."id"=m."subjectId" WHERE m."id"=$1 AND NOT s."deleted")`, b.RefID).Scan(&live)
			case "ESSAY":
				_ = s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "Essay" e JOIN "Subject" s ON s."id"=e."subjectId" WHERE e."id"=$1 AND NOT s."deleted")`, b.RefID).Scan(&live)
			default:
				live = true
			}
			b.SourceDeleted = !live
			if !p.IsMine {
				b.RefID = ""
			}
		}
	}
	return nil
}
func (s *Server) getCommunityPost(w http.ResponseWriter, r *http.Request, u store.User) error {
	p, e := s.communityPostView(r.Context(), u, r.PathValue("id"))
	if e == nil {
		httpx.OK(w, 200, p)
	}
	return e
}
func (s *Server) editCommunityPost(w http.ResponseWriter, r *http.Request, u store.User) error {
	ctx := r.Context()
	p, e := s.accessiblePost(ctx, u, r.PathValue("id"))
	if e != nil {
		return e
	}
	if p.UserID != u.ID {
		return apierr.New(403, "내 글만 수정할 수 있어요.")
	}
	var in communityPostInput
	if e = httpx.Decode(r, &in); e != nil {
		return e
	}
	// Preserve canonical references for unchanged snapshots; clients only receive source ids on their own posts.
	var oldRaw []byte
	oldBlocks := map[string]communityBlock{}
	err := s.pool.QueryRow(ctx, `SELECT "blocks" FROM "CommunityPost" WHERE "postId"=$1`, p.ID).Scan(&oldRaw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var stored []communityBlock
	_ = json.Unmarshal(oldRaw, &stored)
	for _, b := range stored {
		oldBlocks[b.ID] = b
	}
	ctx = context.WithValue(ctx, communityEditSnapshots{}, oldBlocks)
	if e = s.canonicalPost(ctx, u, &in); e != nil {
		return e
	}
	e = s.locked(ctx, u.ID, func(tx pgx.Tx, q *store.Queries) error {
		var old []byte
		err := tx.QueryRow(ctx, `SELECT "blocks" FROM "CommunityPost" WHERE "postId"=$1 FOR UPDATE`, p.ID).Scan(&old)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var prior []communityBlock
		_ = json.Unmarshal(old, &prior)
		for i := range in.Blocks {
			var collision bool
			err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "CommunityComment" cc JOIN "Comment" c ON c."id"=cc."commentId" WHERE c."postId"=$1 AND cc."block"->>'id'=$2)`, p.ID, in.Blocks[i].ID).Scan(&collision)
			if err != nil {
				return err
			}
			if collision {
				return apierr.New(409, "댓글에 사용된 첨부 식별자예요. 다시 선택해 주세요.")
			}
			for _, b := range prior {
				if b.ID == in.Blocks[i].ID {
					var used bool
					if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "CommunityAction" WHERE "postId"=$1 AND "blockId"=$2)`, p.ID, b.ID).Scan(&used); err != nil {
						return err
					}
					if used && !equalBlockContent(b, in.Blocks[i]) {
						return apierr.New(409, "이미 참여한 첨부는 바꿀 수 없어요. 새 첨부로 추가해 주세요.")
					}
					if b.Type == "POLL" {
						in.Blocks[i].Payload["closesAt"] = b.Payload["closesAt"]
					}
				}
			}
		}
		_, err = tx.Exec(ctx, `UPDATE "Post" SET "title"=$2,"body"=$3,"category"=$4,"anonymous"=$5 WHERE "id"=$1`, p.ID, in.Title, in.Body, in.Category, *in.Anonymous)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO "CommunityPost"("postId","userId","blocks","tags","sourceRef","editedAt") VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT("postId") DO UPDATE SET "blocks"=$3,"tags"=$4,"sourceRef"=$5,"editedAt"=now()`, p.ID, u.ID, jsonBytes(in.Blocks), jsonBytes(in.Tags), jsonBytes(in.SourceRef))
		return err
	})
	if e != nil {
		return e
	}
	return s.getCommunityPost(w, r, u)
}
func equalBlockContent(a, b communityBlock) bool {
	ap := map[string]any{}
	bp := map[string]any{}
	for k, v := range a.Payload {
		if k != "closesAt" {
			ap[k] = v
		}
	}
	for k, v := range b.Payload {
		if k != "closesAt" {
			bp[k] = v
		}
	}
	return a.Type == b.Type && string(jsonBytes(ap)) == string(jsonBytes(bp))
}
func (s *Server) deleteCommunityPost(w http.ResponseWriter, r *http.Request, u store.User) error {
	p, e := s.accessiblePost(r.Context(), u, r.PathValue("id"))
	if e != nil {
		return e
	}
	if p.UserID != u.ID {
		return apierr.New(403, "내 글만 삭제할 수 있어요.")
	}
	_, e = s.pool.Exec(r.Context(), `INSERT INTO "CommunityPost"("postId","userId","deleted") VALUES($1,$2,true) ON CONFLICT("postId") DO UPDATE SET "deleted"=true`, p.ID, u.ID)
	if e == nil {
		httpx.OK(w, 200, map[string]bool{"deleted": true})
	}
	return e
}
func (s *Server) acceptCommunityAnswer(w http.ResponseWriter, r *http.Request, u store.User) error {
	ctx := r.Context()
	p, e := s.accessiblePost(ctx, u, r.PathValue("id"))
	if e != nil {
		return e
	}
	if p.UserID != u.ID {
		return apierr.New(403, "질문을 작성한 사람만 채택할 수 있어요.")
	}
	if p.Category != "질문" {
		return apierr.New(400, "질문 게시글에서 답변을 채택할 수 있어요.")
	}
	var in struct {
		CommentID string `json:"commentId"`
	}
	if e = httpx.Decode(r, &in); e != nil {
		return e
	}
	var solved time.Time
	e = s.locked(ctx, u.ID, func(tx pgx.Tx, q *store.Queries) error {
		var author string
		err := tx.QueryRow(ctx, `SELECT c."userId" FROM "Comment" c JOIN "User" u ON u."id"=c."userId" WHERE c."id"=$1 AND c."postId"=$2 AND NOT u."suspended" AND NOT EXISTS(SELECT 1 FROM "Block" b WHERE (b."userId"=$3 AND b."blockedId"=c."userId") OR (b."userId"=c."userId" AND b."blockedId"=$3))`, in.CommentID, p.ID, u.ID).Scan(&author)
		if errors.Is(err, pgx.ErrNoRows) {
			return apierr.New(404, "댓글을 찾을 수 없어요.")
		}
		if err != nil {
			return err
		}
		if author == u.ID {
			return apierr.New(400, "내 답변은 채택할 수 없어요.")
		}
		var previous *string
		err = tx.QueryRow(ctx, `INSERT INTO "CommunityPost"("postId","userId") VALUES($1,$2) ON CONFLICT("postId") DO UPDATE SET "postId"=EXCLUDED."postId" RETURNING "acceptedCommentId"`, p.ID, u.ID).Scan(&previous)
		if err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `UPDATE "CommunityPost" SET "acceptedCommentId"=$2,"solvedAt"=CASE WHEN "acceptedCommentId"=$2 THEN "solvedAt" ELSE now() END WHERE "postId"=$1 RETURNING "solvedAt"`, p.ID, in.CommentID).Scan(&solved)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `INSERT INTO "CommunityReward"("postId","userId") VALUES($1,$2) ON CONFLICT DO NOTHING`, p.ID, author)
		if err != nil {
			return err
		}
		if tag.RowsAffected() > 0 {
			if _, err = tx.Exec(ctx, `UPDATE "User" SET "points"="points"+50 WHERE "id"=$1`, author); err != nil {
				return err
			}
		}
		if previous == nil || *previous != in.CommentID {
			_, err = tx.Exec(ctx, `INSERT INTO "Notification"("id","userId","title","body","href") VALUES($1,$2,'답변이 채택됐어요',$3,$4)`, ids.New(), author, p.Title, communityPostHref(p))
		}
		return err
	})
	if e == nil {
		httpx.OK(w, 200, map[string]any{"acceptedCommentId": in.CommentID, "solvedAt": solved})
	}
	return e
}

func communityPostHref(p store.Post) string {
	base := "/community"
	if p.Role == store.RolePARENT {
		base = "/parent-boards"
	}
	if p.School != "" {
		return base + "?space=school&post=" + p.ID
	}
	return base + "?post=" + p.ID
}

type communityEditSnapshots struct{}
