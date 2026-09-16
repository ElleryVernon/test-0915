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
	"memoryz/server/internal/auth"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/jsonx"
	"memoryz/server/internal/store"
)

// Community: posts, likes, saves, comments, reports and blocks (api.ts posts/reports/blocks and
// bootstrap.ts postsFor). Students and parents each have their own board; a post is only ever
// visible to its own role, never when its author is suspended, and never across a block.

var (
	errPostNotFound   = apierr.New(404, "게시글을 찾을 수 없어요.")
	errPeerNotFound   = apierr.New(404, "사용자를 찾을 수 없어요.")
	errPeerBlocked    = apierr.New(403, "차단된 사용자와 소통할 수 없어요.")
	errOtherCommunity = apierr.New(403, "다른 역할의 커뮤니티에 접근할 수 없어요.")
	errReplyDepth     = apierr.New(400, "댓글은 한 단계까지만 답글을 달 수 있어요.")
)

// communityRoles are the accounts that have a board.
var communityRoles = []store.Role{store.RoleSTUDENT, store.RolePARENT}

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/posts", httpx.Methods{
			http.MethodGet:  s.withUser(s.listPosts, communityRoles...),
			http.MethodPost: s.withUser(s.createPost, communityRoles...),
		})
		mux.Handle("/api/posts/{id}/like", httpx.Methods{http.MethodPost: s.withUser(s.togglePostLike, communityRoles...)})
		mux.Handle("/api/posts/{id}/save", httpx.Methods{http.MethodPost: s.withUser(s.togglePostSave, communityRoles...)})
		mux.Handle("/api/posts/{id}/comments", httpx.Methods{
			http.MethodGet:  s.withUser(s.listComments, communityRoles...),
			http.MethodPost: s.withUser(s.createComment, communityRoles...),
		})
		// reports has no role gate of its own: accessiblePost answers 403 for a role that cannot see the post.
		mux.Handle("/api/reports", httpx.Methods{http.MethodPost: s.withUser(s.createReport)})
		mux.Handle("/api/blocks", httpx.Methods{http.MethodPost: s.withUser(s.createBlock, communityRoles...)})
		mux.Handle("/api/blocks/{userId}", httpx.Methods{http.MethodDelete: s.withUser(s.deleteBlock, communityRoles...)})
	})
}

// PostView is a post as the community list and the bootstrap payload show it (contracts.ts Post).
type PostView struct {
	Blocks            []communityBlock `json:"blocks"`
	Tags              map[string]any   `json:"tags"`
	SourceRef         map[string]any   `json:"sourceRef,omitempty"`
	IsMine            bool             `json:"isMine"`
	EditedAt          *time.Time       `json:"editedAt,omitempty"`
	SolvedAt          *time.Time       `json:"solvedAt,omitempty"`
	AcceptedCommentID *string          `json:"acceptedCommentId,omitempty"`
	Status            string           `json:"status"`
	School            string           `json:"school"`
	ID                string           `json:"id"`
	Author            string           `json:"author"`
	AuthorID          string           `json:"authorId"`
	Role              store.Role       `json:"role"`
	Category          string           `json:"category"`
	Title             string           `json:"title"`
	Body              string           `json:"body"`
	Anonymous         bool             `json:"anonymous"`
	Likes             int64            `json:"likes"`
	Liked             bool             `json:"liked"`
	Saved             bool             `json:"saved"`
	CommentCount      int64            `json:"commentCount"`
	CreatedAt         jsonx.Time       `json:"createdAt"`
}

// postRecord is a Post row as the previous server returned it from create calls.
type postRecord struct {
	ID        string     `json:"id"`
	UserID    string     `json:"userId"`
	Role      store.Role `json:"role"`
	Category  string     `json:"category"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	Anonymous bool       `json:"anonymous"`
	CreatedAt jsonx.Time `json:"createdAt"`
}

// commentRecord is a Comment row as the previous server returned it from create calls; a top-level
// comment carries parentId: null.
type commentRecord struct {
	ID        string     `json:"id"`
	PostID    string     `json:"postId"`
	UserID    string     `json:"userId"`
	Body      string     `json:"body"`
	ParentID  *string    `json:"parentId"`
	CreatedAt jsonx.Time `json:"createdAt"`
}

// commentView is a comment as the thread shows it (contracts.ts Comment): the author's nickname
// instead of their id, and no parentId key at all on a top-level comment.
type commentView struct {
	AuthorID  string          `json:"authorId,omitempty"`
	IsMine    bool            `json:"isMine"`
	Accepted  bool            `json:"accepted"`
	Block     *communityBlock `json:"block,omitempty"`
	ID        string          `json:"id"`
	PostID    string          `json:"postId"`
	Author    string          `json:"author"`
	Body      string          `json:"body"`
	ParentID  *string         `json:"parentId,omitempty"`
	CreatedAt jsonx.Time      `json:"createdAt"`
}

// reportRecord is a Report row.
type reportRecord struct {
	ID        string     `json:"id"`
	UserID    string     `json:"userId"`
	PostID    string     `json:"postId"`
	Reason    string     `json:"reason"`
	Status    string     `json:"status"`
	CreatedAt jsonx.Time `json:"createdAt"`
}

func reportRecordOf(r store.Report) reportRecord {
	return reportRecord{ID: r.ID, UserID: r.UserID, PostID: r.PostID, Reason: r.Reason, Status: r.Status, CreatedAt: jsonx.Time(r.CreatedAt)}
}

// accessiblePost is the post behind postID as the caller may see it: 404 when it does not exist,
// 403 when it belongs to the other role's board, and 404 again when its author is suspended or a
// block stands between the two accounts in either direction.
func (s *Server) accessiblePost(ctx context.Context, user store.User, postID string) (store.Post, error) {
	row, err := s.q.GetPostAccess(ctx, store.GetPostAccessParams{ViewerID: user.ID, PostID: postID})
	if errors.Is(err, pgx.ErrNoRows) {
		return store.Post{}, errPostNotFound
	}
	if err != nil {
		return store.Post{}, err
	}
	if err := auth.RequireRole(user, row.Post.Role); err != nil {
		return store.Post{}, err
	}
	var deleted bool
	if e := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "CommunityPost" WHERE "postId"=$1 AND "deleted")`, postID).Scan(&deleted); e != nil {
		return store.Post{}, e
	}
	if deleted || row.AuthorSuspended || row.Blocked || !postSchoolVisible(row.Post.School, user.School) {
		return store.Post{}, errPostNotFound
	}
	return row.Post, nil
}

// peer is the account the caller may interact with: 404 unless it exists, shares the caller's
// role, is not suspended and is not the caller; 403 when a block stands between them.
func (s *Server) peer(ctx context.Context, user store.User, userID string) (store.User, error) {
	row, err := s.q.GetPeer(ctx, store.GetPeerParams{ViewerID: user.ID, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return store.User{}, errPeerNotFound
	}
	if err != nil {
		return store.User{}, err
	}
	if row.User.Role != user.Role || row.User.Suspended || userID == user.ID {
		return store.User{}, errPeerNotFound
	}
	if row.Blocked {
		return store.User{}, errPeerBlocked
	}
	return row.User, nil
}

// postsFor is the caller's community feed: the 100 newest posts of their role, minus those by
// suspended authors and by anyone either side has blocked; commented narrows it to the posts the
// caller commented on. The bootstrap payload embeds the same list. state is the cache path (hit, miss
// or shared), reported as X-Cache by GET /api/posts.
func (s *Server) postsFor(ctx context.Context, user store.User, commented bool) ([]PostView, string, error) {
	return s.postsForFeed(ctx, user, store.ListPostsParams{Commented: commented})
}

func postSchoolVisible(postSchool, userSchool string) bool {
	return postSchool == "" || (strings.TrimSpace(userSchool) != "" && postSchool == strings.TrimSpace(userSchool))
}

func (s *Server) postsForFeed(ctx context.Context, user store.User, options store.ListPostsParams) ([]PostView, string, error) {
	options.ViewerID, options.Role = user.ID, user.Role
	encoded, _ := json.Marshal(options)
	// The list depends on the viewer (liked, saved, blocks) and on everyone's posts, so its key
	// carries both the viewer's version and the shared posts version.
	key := "posts-v3:" + string(encoded) + ":" + s.version(ctx, user.ID) + ":" + s.version(ctx, "posts")
	raw, state, err := s.fill(ctx, "posts", key, postsTTL, func(ctx context.Context) ([]byte, error) {
		rows, err := s.q.ListPosts(ctx, options)
		if err != nil {
			return nil, err
		}
		posts, err := postViews(rows)
		if err != nil {
			return nil, err
		}
		for i := range posts {
			if e := s.enrichCommunityPost(ctx, user, &posts[i]); e != nil {
				return nil, e
			}
		}
		return json.Marshal(posts)
	})
	if err != nil {
		return nil, "", err
	}
	var posts []PostView
	if err := json.Unmarshal(raw, &posts); err != nil {
		return nil, "", err
	}
	return posts, state, nil
}

func postViews(rows []store.ListPostsRow) ([]PostView, error) {
	posts := make([]PostView, 0, len(rows))
	for _, row := range rows {
		view := PostView{
			School: row.Post.School, ID: row.Post.ID, Author: row.AuthorNickname, AuthorID: row.Post.UserID, Role: row.Post.Role,
			Category: row.Post.Category, Title: row.Post.Title, Body: row.Post.Body, Anonymous: row.Post.Anonymous,
			Likes: row.Likes, Liked: row.Liked, Saved: row.Saved, CommentCount: row.CommentCount,
			CreatedAt: jsonx.Time(row.Post.CreatedAt),
		}
		if row.Post.Anonymous {
			view.Author, view.AuthorID = "익명", ""
		}
		posts = append(posts, view)
	}
	return posts, nil
}

// listPosts answers GET /api/posts?role=…&commented=1; a role other than the caller's is refused.
func (s *Server) listPosts(w http.ResponseWriter, r *http.Request, user store.User) error {
	query := r.URL.Query()
	if role := query.Get("role"); role != "" && role != string(user.Role) {
		return errOtherCommunity
	}
	options := store.ListPostsParams{Commented: query.Get("commented") == "1", Mine: query.Get("mine") == "1", SavedOnly: query.Get("saved") == "1"}
	options.FollowingOnly = query.Get("following") == "1"
	options.SubjectID = query.Get("subjectId")
	options.QuestionID = query.Get("questionId")
	options.Unanswered = query.Get("unanswered") == "1"
	options.Activity = options.Commented || options.Mine || options.SavedOnly || options.QuestionID != ""
	if query.Get("scope") == "school" || options.Activity {
		options.School = strings.TrimSpace(user.School)
	}
	if query.Get("scope") == "school" && options.School == "" {
		return apierr.New(400, "프로필에 학교를 등록해 주세요.")
	}
	posts, state, err := s.postsForFeed(r.Context(), user, options)
	if err != nil {
		return err
	}
	w.Header().Set("X-Cache", state)
	httpx.OK(w, http.StatusOK, posts)
	return nil
}

// createPost answers POST /api/posts with the new row; the post lands on the caller's own board.
func (s *Server) createPost(w http.ResponseWriter, r *http.Request, user store.User) error {
	return s.saveNewCommunityPost(w, r, user)
}

// togglePostLike answers POST /api/posts/{id}/like with the new state.
func (s *Server) togglePostLike(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	post, err := s.accessiblePost(ctx, user, r.PathValue("id"))
	if err != nil {
		return err
	}
	var liked bool
	err = s.locked(ctx, user.ID, func(_ pgx.Tx, q *store.Queries) error {
		prior, err := q.HasPostLike(ctx, store.HasPostLikeParams{UserID: user.ID, PostID: post.ID})
		if err != nil {
			return err
		}
		liked = !prior
		if prior {
			return q.DeletePostLike(ctx, store.DeletePostLikeParams{UserID: user.ID, PostID: post.ID})
		}
		return q.CreatePostLike(ctx, store.CreatePostLikeParams{UserID: user.ID, PostID: post.ID})
	})
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, map[string]bool{"liked": liked})
	return nil
}

// togglePostSave answers POST /api/posts/{id}/save with the new state.
func (s *Server) togglePostSave(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	post, err := s.accessiblePost(ctx, user, r.PathValue("id"))
	if err != nil {
		return err
	}
	var saved bool
	err = s.locked(ctx, user.ID, func(_ pgx.Tx, q *store.Queries) error {
		prior, err := q.HasPostSave(ctx, store.HasPostSaveParams{UserID: user.ID, PostID: post.ID})
		if err != nil {
			return err
		}
		saved = !prior
		if prior {
			return q.DeletePostSave(ctx, store.DeletePostSaveParams{UserID: user.ID, PostID: post.ID})
		}
		return q.CreatePostSave(ctx, store.CreatePostSaveParams{UserID: user.ID, PostID: post.ID})
	})
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, map[string]bool{"saved": saved})
	return nil
}

// listComments answers GET /api/posts/{id}/comments: the 500 oldest, hiding suspended and blocked authors.
func (s *Server) listComments(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	post, err := s.accessiblePost(ctx, user, r.PathValue("id"))
	if err != nil {
		return err
	}
	rows, err := s.q.ListComments(ctx, store.ListCommentsParams{PostID: post.ID, ViewerID: user.ID})
	if err != nil {
		return err
	}
	comments := make([]commentView, 0, len(rows))
	for _, row := range rows {
		c := row.Comment
		view := commentView{ID: c.ID, PostID: c.PostID, Author: row.AuthorNickname, AuthorID: c.UserID, IsMine: c.UserID == user.ID, Body: c.Body, ParentID: c.ParentID, CreatedAt: jsonx.Time(c.CreatedAt)}
		if post.Anonymous && c.UserID == post.UserID {
			view.Author = "익명 · 글쓴이"
			view.AuthorID = ""
		}
		var raw []byte
		_ = s.pool.QueryRow(ctx, `SELECT "block" FROM "CommunityComment" WHERE "commentId"=$1`, c.ID).Scan(&raw)
		if len(raw) > 0 && string(raw) != "null" {
			var b communityBlock
			if json.Unmarshal(raw, &b) == nil {
				if b.Type == "QUESTION" || b.Type == "POLL" {
					b.Stats = s.blockStats(ctx, user.ID, post.ID, b)
				}
				b.RefID = ""
				view.Block = &b
			}
		}
		_ = s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "CommunityPost" WHERE "postId"=$1 AND "acceptedCommentId"=$2)`, post.ID, c.ID).Scan(&view.Accepted)
		comments = append(comments, view)
	}
	httpx.OK(w, http.StatusOK, comments)
	return nil
}

// createComment answers POST /api/posts/{id}/comments; a reply may only answer a top-level comment
// of the same post.
func (s *Server) createComment(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	post, err := s.accessiblePost(ctx, user, r.PathValue("id"))
	if err != nil {
		return err
	}
	var in struct {
		Body      string            `json:"body"`
		ParentID  jsonx.Opt[string] `json:"parentId"`
		Block     *communityBlock   `json:"block"`
		RequestID string            `json:"requestId"`
	}
	if err = httpx.Decode(r, &in); err != nil {
		return err
	}
	if in.RequestID != "" && len(in.RequestID) <= 100 {
		var id, pid, body string
		var created time.Time
		err := s.pool.QueryRow(ctx, `SELECT c."id",c."postId",c."body",c."createdAt" FROM "CommunityComment" cc JOIN "Comment" c ON c."id"=cc."commentId" WHERE cc."userId"=$1 AND cc."requestId"=$2`, user.ID, in.RequestID).Scan(&id, &pid, &body, &created)
		if err == nil {
			if pid != post.ID {
				return apierr.New(409, "다른 댓글에 사용된 요청이에요.")
			}
			httpx.OK(w, 201, map[string]any{"id": id, "postId": pid, "body": body, "createdAt": created, "isMine": true})
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	v := &validator{}
	body := strings.TrimSpace(in.Body)
	if in.Block == nil {
		body = v.text(body, 2000)
	} else {
		v.check(len([]rune(body)) <= 2000, msgInput)
	}
	v.check(len(in.RequestID) <= 100, msgInput)
	var parent *string
	if in.ParentID.Set {
		id := v.id(in.ParentID.Value)
		parent = &id
	}
	if err = v.result(); err != nil {
		return err
	}
	if parent != nil {
		ok, e := s.q.IsTopLevelComment(ctx, store.IsTopLevelCommentParams{ID: *parent, PostID: post.ID})
		if e != nil {
			return e
		}
		if !ok {
			return errReplyDepth
		}
	}
	if in.Block != nil {
		blocks, e := s.canonicalBlocks(ctx, user, []communityBlock{*in.Block}, true)
		if e != nil {
			return e
		}
		in.Block = &blocks[0]
	}
	var comment store.Comment
	err = s.locked(ctx, post.UserID, func(tx pgx.Tx, q *store.Queries) error {
		if in.RequestID != "" {
			var id string
			e := tx.QueryRow(ctx, `SELECT "commentId" FROM "CommunityComment" WHERE "userId"=$1 AND "requestId"=$2`, user.ID, in.RequestID).Scan(&id)
			if e == nil {
				return tx.QueryRow(ctx, `SELECT "id","postId","userId","body","parentId","createdAt" FROM "Comment" WHERE "id"=$1`, id).Scan(&comment.ID, &comment.PostID, &comment.UserID, &comment.Body, &comment.ParentID, &comment.CreatedAt)
			}
			if !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
		}
		if in.Block != nil {
			var collision bool
			e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "CommunityPost" cp CROSS JOIN LATERAL jsonb_array_elements(cp."blocks") b WHERE cp."postId"=$1 AND b->>'id'=$2 UNION ALL SELECT 1 FROM "CommunityComment" cc JOIN "Comment" c ON c."id"=cc."commentId" WHERE c."postId"=$1 AND cc."block"->>'id'=$2)`, post.ID, in.Block.ID).Scan(&collision)
			if e != nil {
				return e
			}
			if collision {
				return apierr.New(409, "이미 사용된 첨부예요. 다시 선택해 주세요.")
			}
		}
		var count int
		if e := tx.QueryRow(ctx, `SELECT count(*) FROM "Comment" WHERE "postId"=$1 AND "userId"<>$2`, post.ID, post.UserID).Scan(&count); e != nil {
			return e
		}
		var e error
		comment, e = q.CreateComment(ctx, store.CreateCommentParams{ID: ids.New(), PostID: post.ID, UserID: user.ID, Body: body, ParentID: parent})
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `INSERT INTO "CommunityComment"("commentId","userId","block","requestId") VALUES($1,$2,$3,NULLIF($4,''))`, comment.ID, user.ID, jsonBytes(in.Block), in.RequestID)
		if e != nil {
			return e
		}
		if count == 0 && user.ID != post.UserID {
			_, e = tx.Exec(ctx, `INSERT INTO "Notification"("id","userId","title","body","href") VALUES($1,$2,'첫 답변이 도착했어요',$3,$4)`, ids.New(), post.UserID, post.Title, communityPostHref(post))
		}
		return e
	})
	if err != nil {
		return err
	}
	httpx.OK(w, 201, map[string]any{"id": comment.ID, "postId": comment.PostID, "body": comment.Body, "parentId": comment.ParentID, "createdAt": comment.CreatedAt, "isMine": true})
	return nil
}

// createReport answers POST /api/reports: one report per (caller, post), reopened with the new
// reason when it already exists.
func (s *Server) createReport(w http.ResponseWriter, r *http.Request, user store.User) error {
	var input struct {
		PostID string `json:"postId"`
		Reason string `json:"reason"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	v := &validator{}
	postID := v.id(input.PostID)
	reason := v.text(input.Reason, 1000)
	if err := v.result(); err != nil {
		return err
	}
	ctx := r.Context()
	post, err := s.accessiblePost(ctx, user, postID)
	if err != nil {
		return err
	}
	report, err := s.q.UpsertReport(ctx, store.UpsertReportParams{ID: ids.New(), UserID: user.ID, PostID: post.ID, Reason: reason})
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, reportRecordOf(report))
	return nil
}

// createBlock answers POST /api/blocks; blocking twice is fine.
func (s *Server) createBlock(w http.ResponseWriter, r *http.Request, user store.User) error {
	var input struct {
		UserID string `json:"userId"`
		PostID string `json:"postId"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	v := &validator{}
	if input.PostID != "" {
		p, e := s.accessiblePost(r.Context(), user, input.PostID)
		if e != nil {
			return e
		}
		input.UserID = p.UserID
	}
	userID := v.id(input.UserID)
	if err := v.result(); err != nil {
		return err
	}
	ctx := r.Context()
	if _, err := s.peer(ctx, user, userID); err != nil {
		return err
	}
	if err := s.q.CreateBlock(ctx, store.CreateBlockParams{UserID: user.ID, BlockedID: userID}); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM "Follow" WHERE ("followerId"=$1 AND "followingId"=$2) OR ("followerId"=$2 AND "followingId"=$1)`, user.ID, userID); err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, map[string]bool{"blocked": true})
	return nil
}

// deleteBlock answers DELETE /api/blocks/{userId}; lifting a block that does not exist is fine.
func (s *Server) deleteBlock(w http.ResponseWriter, r *http.Request, user store.User) error {
	if err := s.q.DeleteBlock(r.Context(), store.DeleteBlockParams{UserID: user.ID, BlockedID: r.PathValue("userId")}); err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, map[string]bool{"blocked": false})
	return nil
}
