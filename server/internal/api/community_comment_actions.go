package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/store"
)

var errCommentNotFound = apierr.New(404, "댓글을 찾을 수 없어요.")

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/posts/{id}/comments/{commentId}", httpx.Methods{
			http.MethodPatch:  s.withUser(s.editCommunityComment, communityRoles...),
			http.MethodDelete: s.withUser(s.deleteCommunityComment, communityRoles...),
		})
		mux.Handle("/api/posts/{id}/comments/{commentId}/like", httpx.Methods{
			http.MethodPost: s.withUser(s.likeCommunityComment, communityRoles...),
		})
	})
}

type actionableComment struct {
	owner    string
	body     string
	deleted  bool
	hasBlock bool
	parentID *string
}

// Callers hold the post owner's user lock, shared with reply creation and acceptance.
// Legacy Comment rows without CommunityComment metadata remain fully supported.
func lockedCommunityComment(ctx context.Context, tx pgx.Tx, user store.User, postID, commentID string) (actionableComment, error) {
	var c actionableComment
	err := tx.QueryRow(ctx, `SELECT c."userId",c."body",COALESCE(cc."deleted",false),COALESCE(cc."block" IS NOT NULL AND cc."block"<>'null'::jsonb,false),c."parentId"
 FROM "Comment" c JOIN "User" u ON u."id"=c."userId" LEFT JOIN "CommunityComment" cc ON cc."commentId"=c."id"
 WHERE c."id"=$1 AND c."postId"=$2 AND u."role"=$4 AND NOT u."suspended"
 AND NOT EXISTS(SELECT 1 FROM "Block" b WHERE (b."userId"=$3 AND b."blockedId"=c."userId") OR (b."userId"=c."userId" AND b."blockedId"=$3))
 FOR UPDATE OF c`, commentID, postID, user.ID, user.Role).Scan(&c.owner, &c.body, &c.deleted, &c.hasBlock, &c.parentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return c, errCommentNotFound
	}
	return c, err
}

func (s *Server) editCommunityComment(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	post, err := s.accessiblePost(ctx, user, r.PathValue("id"))
	if err != nil {
		return err
	}
	var in struct {
		Body *string `json:"body"`
	}
	if err = httpx.Decode(r, &in); err != nil {
		return err
	}
	if in.Body == nil {
		return apierr.New(400, "댓글 내용을 입력해 주세요.")
	}
	if len([]rune(strings.TrimSpace(*in.Body))) > 2000 {
		return apierr.New(400, "댓글은 2,000자 이내로 입력해 주세요.")
	}
	body := strings.TrimSpace(*in.Body)
	id := r.PathValue("commentId")
	var editedAt *time.Time
	err = s.locked(ctx, post.UserID, func(tx pgx.Tx, _ *store.Queries) error {
		c, e := lockedCommunityComment(ctx, tx, user, post.ID, id)
		if e != nil {
			return e
		}
		if c.deleted {
			return errCommentNotFound
		}
		if c.owner != user.ID {
			return apierr.New(403, "내 댓글만 수정할 수 있어요.")
		}
		if body == "" && !c.hasBlock {
			return apierr.New(400, "댓글 내용을 입력해 주세요.")
		}
		if c.body == body {
			// Repeating a successful save does not change its edit timestamp.
			return tx.QueryRow(ctx, `SELECT (SELECT "editedAt" FROM "CommunityComment" WHERE "commentId"=$1)`, id).Scan(&editedAt)
		}
		if _, e = tx.Exec(ctx, `UPDATE "Comment" SET "body"=$2 WHERE "id"=$1`, id, body); e != nil {
			return e
		}
		return tx.QueryRow(ctx, `INSERT INTO "CommunityComment"("commentId","userId","editedAt") VALUES($1,$2,now())
 ON CONFLICT("commentId") DO UPDATE SET "editedAt"=EXCLUDED."editedAt" RETURNING "editedAt"`, id, user.ID).Scan(&editedAt)
	})
	if err != nil {
		return err
	}
	httpx.OK(w, 200, map[string]any{"id": id, "body": body, "editedAt": editedAt})
	return nil
}

func (s *Server) deleteCommunityComment(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	post, err := s.accessiblePost(ctx, user, r.PathValue("id"))
	if err != nil {
		return err
	}
	id := r.PathValue("commentId")
	err = s.locked(ctx, post.UserID, func(tx pgx.Tx, _ *store.Queries) error {
		c, e := lockedCommunityComment(ctx, tx, user, post.ID, id)
		if e != nil {
			return e
		}
		if c.owner != user.ID {
			return apierr.New(403, "내 댓글만 삭제할 수 있어요.")
		}
		if c.deleted {
			return nil
		}
		// Erase source content as well as redacting the response. Reply IDs, accepted
		// attribution and previously earned rewards survive without exposing that content.
		if _, e = tx.Exec(ctx, `UPDATE "Comment" SET "body"='' WHERE "id"=$1`, id); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO "CommunityComment"("commentId","userId","deleted") VALUES($1,$2,true)
 ON CONFLICT("commentId") DO UPDATE SET "deleted"=true,"block"=NULL,"editedAt"=NULL`, id, user.ID); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `DELETE FROM "CommentLike" WHERE "commentId"=$1`, id)
		return e
	})
	if err != nil {
		return err
	}
	httpx.OK(w, 200, map[string]any{"id": id, "deleted": true})
	return nil
}

func (s *Server) likeCommunityComment(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	post, err := s.accessiblePost(ctx, user, r.PathValue("id"))
	if err != nil {
		return err
	}
	var in struct {
		Liked *bool `json:"liked"`
	}
	if err = httpx.Decode(r, &in); err != nil {
		return err
	}
	if in.Liked == nil {
		return apierr.New(400, "좋아요 상태를 지정해 주세요.")
	}
	id := r.PathValue("commentId")
	var likes int64
	err = s.locked(ctx, post.UserID, func(tx pgx.Tx, _ *store.Queries) error {
		c, e := lockedCommunityComment(ctx, tx, user, post.ID, id)
		if e != nil {
			return e
		}
		if c.deleted {
			return errCommentNotFound
		}
		if *in.Liked {
			_, e = tx.Exec(ctx, `INSERT INTO "CommentLike"("commentId","userId") VALUES($1,$2) ON CONFLICT DO NOTHING`, id, user.ID)
		} else {
			_, e = tx.Exec(ctx, `DELETE FROM "CommentLike" WHERE "commentId"=$1 AND "userId"=$2`, id, user.ID)
		}
		if e != nil {
			return e
		}
		return tx.QueryRow(ctx, `SELECT count(*) FROM "CommentLike" WHERE "commentId"=$1`, id).Scan(&likes)
	})
	if err != nil {
		return err
	}
	httpx.OK(w, 200, map[string]any{"likes": likes, "liked": *in.Liked})
	return nil
}
