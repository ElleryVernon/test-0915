package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/db"
	"memoryz/server/internal/store"
)

// mounts collects the route groups each file registers in init(), so files never edit each other.
var mounts []func(*Server, *http.ServeMux)

func register(mount func(*Server, *http.ServeMux)) { mounts = append(mounts, mount) }

var (
	errSubjectNotFound = apierr.New(404, "과목을 찾을 수 없어요.")
)

// ownedSubject is the caller's live subject or the API's 404.
func (s *Server) ownedSubject(ctx context.Context, user store.User, subjectID string) (store.Subject, error) {
	subject, err := s.q.GetOwnedSubject(ctx, store.GetOwnedSubjectParams{ID: subjectID, UserID: user.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return store.Subject{}, errSubjectNotFound
	}
	return subject, err
}

// selectedChild is the parent's chosen child (or the first linked one), or nil without a link.
func (s *Server) selectedChild(ctx context.Context, parent store.User) (*store.User, error) {
	var selected string
	if parent.SelectedChildID != nil {
		selected = *parent.SelectedChildID
	}
	child, err := s.q.SelectedChild(ctx, store.SelectedChildParams{ParentID: parent.ID, SelectedID: selected})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &child, nil
}

// locked runs fn in a transaction that holds the caller's user row, serialising that account's
// writes (points, links, reviews, toggles) exactly like the previous server's `locked()`.
func (s *Server) locked(ctx context.Context, userID string, fn func(tx pgx.Tx, q *store.Queries) error) error {
	return db.Tx(ctx, s.pool, func(tx pgx.Tx) error {
		if err := db.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		return fn(tx, s.q.WithTx(tx))
	})
}
