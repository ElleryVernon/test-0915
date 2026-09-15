package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

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
	ID           string     `json:"id"`
	Author       string     `json:"author"`
	AuthorID     string     `json:"authorId"`
	Role         store.Role `json:"role"`
	Category     string     `json:"category"`
	Title        string     `json:"title"`
	Body         string     `json:"body"`
	Anonymous    bool       `json:"anonymous"`
	Likes        int64      `json:"likes"`
	Liked        bool       `json:"liked"`
	Saved        bool       `json:"saved"`
	CommentCount int64      `json:"commentCount"`
	CreatedAt    jsonx.Time `json:"createdAt"`
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
	ID        string     `json:"id"`
	PostID    string     `json:"postId"`
	Author    string     `json:"author"`
	Body      string     `json:"body"`
	ParentID  *string    `json:"parentId,omitempty"`
	CreatedAt jsonx.Time `json:"createdAt"`
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
	if row.AuthorSuspended || row.Blocked {
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
	// The list depends on the viewer (liked, saved, blocks) and on everyone's posts, so its key
	// carries both the viewer's version and the shared posts version.
	key := "posts:" + user.ID + ":" + string(user.Role) + ":" + strconv.FormatBool(commented) + ":" + s.version(ctx, user.ID) + ":" + s.version(ctx, "posts")
	raw, state, err := s.fill(ctx, "posts", key, postsTTL, func(ctx context.Context) ([]byte, error) {
		rows, err := s.q.ListPosts(ctx, store.ListPostsParams{ViewerID: user.ID, Role: user.Role, Commented: commented})
		if err != nil {
			return nil, err
		}
		posts, err := postViews(rows)
		if err != nil {
			return nil, err
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
			ID: row.Post.ID, Author: row.AuthorNickname, AuthorID: row.Post.UserID, Role: row.Post.Role,
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
	posts, state, err := s.postsFor(r.Context(), user, query.Get("commented") == "1")
	if err != nil {
		return err
	}
	w.Header().Set("X-Cache", state)
	httpx.OK(w, http.StatusOK, posts)
	return nil
}

// createPost answers POST /api/posts with the new row; the post lands on the caller's own board.
func (s *Server) createPost(w http.ResponseWriter, r *http.Request, user store.User) error {
	var input struct {
		Title     string `json:"title"`
		Body      string `json:"body"`
		Category  string `json:"category"`
		Anonymous *bool  `json:"anonymous"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	v := &validator{}
	title := v.text(input.Title, 120)
	body := v.text(input.Body, 10_000)
	category := v.text(input.Category, 30)
	v.check(input.Anonymous != nil, msgInput)
	if err := v.result(); err != nil {
		return err
	}
	post, err := s.q.CreatePost(r.Context(), store.CreatePostParams{
		ID: ids.New(), UserID: user.ID, Role: user.Role, Category: category, Title: title, Body: body, Anonymous: *input.Anonymous,
	})
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusCreated, postRecord{ID: post.ID, UserID: post.UserID, Role: post.Role, Category: post.Category, Title: post.Title, Body: post.Body, Anonymous: post.Anonymous, CreatedAt: jsonx.Time(post.CreatedAt)})
	return nil
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
		comments = append(comments, commentView{ID: c.ID, PostID: c.PostID, Author: row.AuthorNickname, Body: c.Body, ParentID: c.ParentID, CreatedAt: jsonx.Time(c.CreatedAt)})
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
	var input struct {
		Body     string            `json:"body"`
		ParentID jsonx.Opt[string] `json:"parentId"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	v := &validator{}
	body := v.text(input.Body, 2000)
	var parentID *string
	if input.ParentID.Set {
		// null is not an optional id either; v.id refuses the empty value it leaves behind.
		id := v.id(input.ParentID.Value)
		parentID = &id
	}
	if err := v.result(); err != nil {
		return err
	}
	if parentID != nil {
		topLevel, err := s.q.IsTopLevelComment(ctx, store.IsTopLevelCommentParams{ID: *parentID, PostID: post.ID})
		if err != nil {
			return err
		}
		if !topLevel {
			return errReplyDepth
		}
	}
	comment, err := s.q.CreateComment(ctx, store.CreateCommentParams{ID: ids.New(), PostID: post.ID, UserID: user.ID, Body: body, ParentID: parentID})
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusCreated, commentRecord{ID: comment.ID, PostID: comment.PostID, UserID: comment.UserID, Body: comment.Body, ParentID: comment.ParentID, CreatedAt: jsonx.Time(comment.CreatedAt)})
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
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	v := &validator{}
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
