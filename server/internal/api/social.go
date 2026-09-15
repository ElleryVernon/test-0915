package api

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5"

	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/jsonx"
	"memoryz/server/internal/store"
)

// Social: the follow graph, direct messages and the school directory (api.ts social/follow/
// messages/schools). Every counterpart goes through peer(): same role, not suspended, not the
// caller, and no block in either direction.

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/social", httpx.Methods{http.MethodGet: s.withUser(s.social, communityRoles...)})
		// follow has no role gate of its own: peer() only ever matches an account of the caller's role.
		mux.Handle("/api/follow", httpx.Methods{http.MethodPost: s.withUser(s.toggleFollow)})
		mux.Handle("/api/messages", httpx.Methods{
			http.MethodGet:  s.withUser(s.listMessages, communityRoles...),
			http.MethodPost: s.withUser(s.createMessage, communityRoles...),
		})
		mux.Handle("/api/schools", httpx.Methods{http.MethodGet: s.withUser(s.searchSchools)})
	})
}

// userRef is how the social summary names an account.
type userRef struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
}

// userRefs projects a list of sqlc rows onto userRef; each query has its own row type.
func userRefs[R any](rows []R, ref func(R) userRef) []userRef {
	out := make([]userRef, 0, len(rows))
	for _, row := range rows {
		out = append(out, ref(row))
	}
	return out
}

// messageRecord is a Message row.
type messageRecord struct {
	ID          string     `json:"id"`
	SenderID    string     `json:"senderId"`
	RecipientID string     `json:"recipientId"`
	Body        string     `json:"body"`
	CreatedAt   jsonx.Time `json:"createdAt"`
}

func messageRecordOf(m store.Message) messageRecord {
	return messageRecord{ID: m.ID, SenderID: m.SenderID, RecipientID: m.RecipientID, Body: m.Body, CreatedAt: jsonx.Time(m.CreatedAt)}
}

// schoolRecord is a School row.
type schoolRecord struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func schoolRecords(rows []store.School) []schoolRecord {
	out := make([]schoolRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, schoolRecord{ID: row.ID, Name: row.Name})
	}
	return out
}

// social answers GET /api/social: who follows the caller, whom they follow, up to 100 peers they
// may talk to, whom they blocked, and their counts.
func (s *Server) social(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	followers, err := s.q.ListFollowers(ctx, user.ID)
	if err != nil {
		return err
	}
	following, err := s.q.ListFollowing(ctx, user.ID)
	if err != nil {
		return err
	}
	peers, err := s.q.ListPeers(ctx, store.ListPeersParams{Role: user.Role, ViewerID: user.ID})
	if err != nil {
		return err
	}
	blocked, err := s.q.ListBlocked(ctx, user.ID)
	if err != nil {
		return err
	}
	posts, err := s.q.CountUserPosts(ctx, user.ID)
	if err != nil {
		return err
	}
	comments, err := s.q.CountUserComments(ctx, user.ID)
	if err != nil {
		return err
	}
	type counts struct {
		Posts     int64 `json:"posts"`
		Comments  int64 `json:"comments"`
		Followers int   `json:"followers"`
		Following int   `json:"following"`
	}
	httpx.OK(w, http.StatusOK, struct {
		Followers []userRef `json:"followers"`
		Following []userRef `json:"following"`
		Users     []userRef `json:"users"`
		Blocked   []userRef `json:"blocked"`
		Counts    counts    `json:"counts"`
	}{
		Followers: userRefs(followers, func(u store.ListFollowersRow) userRef { return userRef{ID: u.ID, Nickname: u.Nickname} }),
		Following: userRefs(following, func(u store.ListFollowingRow) userRef { return userRef{ID: u.ID, Nickname: u.Nickname} }),
		Users:     userRefs(peers, func(u store.ListPeersRow) userRef { return userRef{ID: u.ID, Nickname: u.Nickname} }),
		Blocked:   userRefs(blocked, func(u store.ListBlockedRow) userRef { return userRef{ID: u.ID, Nickname: u.Nickname} }),
		Counts:    counts{Posts: posts, Comments: comments, Followers: len(followers), Following: len(following)},
	})
	return nil
}

// toggleFollow answers POST /api/follow with the new state.
func (s *Server) toggleFollow(w http.ResponseWriter, r *http.Request, user store.User) error {
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
	var following bool
	err := s.locked(ctx, user.ID, func(_ pgx.Tx, q *store.Queries) error {
		previous, err := q.HasFollow(ctx, store.HasFollowParams{FollowerID: user.ID, FollowingID: userID})
		if err != nil {
			return err
		}
		following = !previous
		if previous {
			return q.DeleteFollow(ctx, store.DeleteFollowParams{FollowerID: user.ID, FollowingID: userID})
		}
		return q.CreateFollow(ctx, store.CreateFollowParams{FollowerID: user.ID, FollowingID: userID})
	})
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, map[string]bool{"following": following})
	return nil
}

// listMessages answers GET /api/messages?userId=…: the 200 oldest messages between the two.
func (s *Server) listMessages(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	peerID := r.URL.Query().Get("userId")
	if _, err := s.peer(ctx, user, peerID); err != nil {
		return err
	}
	rows, err := s.q.ListMessages(ctx, store.ListMessagesParams{UserID: user.ID, PeerID: peerID})
	if err != nil {
		return err
	}
	messages := make([]messageRecord, 0, len(rows))
	for _, row := range rows {
		messages = append(messages, messageRecordOf(row))
	}
	httpx.OK(w, http.StatusOK, messages)
	return nil
}

// createMessage answers POST /api/messages with the new row.
func (s *Server) createMessage(w http.ResponseWriter, r *http.Request, user store.User) error {
	var input struct {
		UserID string `json:"userId"`
		Body   string `json:"body"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	v := &validator{}
	userID := v.id(input.UserID)
	body := v.text(input.Body, 3000)
	if err := v.result(); err != nil {
		return err
	}
	ctx := r.Context()
	if _, err := s.peer(ctx, user, userID); err != nil {
		return err
	}
	message, err := s.q.CreateMessage(ctx, store.CreateMessageParams{ID: ids.New(), SenderID: user.ID, RecipientID: userID, Body: body})
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusCreated, messageRecordOf(message))
	return nil
}

// searchSchools answers GET /api/schools?q=…: up to 30 schools whose name contains q, ignoring
// case, by name. As before, q is cut to 100 characters and goes into the LIKE pattern as it is
// (Prisma's `contains` did not escape % or _ either).
func (s *Server) searchSchools(w http.ResponseWriter, r *http.Request, _ store.User) error {
	q := r.URL.Query().Get("q")
	if runes := []rune(q); len(runes) > 100 {
		q = string(runes[:100])
	}
	ctx := r.Context()
	key := "schools:" + s.version(ctx, "schools") + ":" + q
	raw, state, err := s.fill(ctx, "schools", key, schoolsTTL, func(ctx context.Context) ([]byte, error) {
		rows, err := s.q.SearchSchools(ctx, "%"+q+"%")
		if err != nil {
			return nil, err
		}
		return json.Marshal(schoolRecords(rows))
	})
	if err != nil {
		return err
	}
	w.Header().Set("X-Cache", state)
	httpx.Raw(w, http.StatusOK, raw)
	return nil
}
