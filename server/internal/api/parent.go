package api

import (
	"crypto/rand"
	"errors"
	"math"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/jsonx"
	"memoryz/server/internal/store"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/invite", httpx.Methods{http.MethodPost: s.withUser(s.createInvite, store.RoleSTUDENT)})
		mux.Handle("/api/link", httpx.Methods{http.MethodPost: s.withUser(s.linkChild, store.RolePARENT)})
		mux.Handle("/api/children", httpx.Methods{http.MethodGet: s.withUser(s.listChildren, store.RolePARENT)})
		mux.Handle("/api/children/select", httpx.Methods{http.MethodPost: s.withUser(s.selectChild, store.RolePARENT)})
		mux.Handle("/api/children/{id}", httpx.Methods{http.MethodDelete: s.withUser(s.unlinkChild, store.RolePARENT)})
		mux.Handle("/api/parent-stats", httpx.Methods{http.MethodGet: s.withUser(s.parentStats, store.RolePARENT)})
		mux.Handle("/api/cheers", httpx.Methods{http.MethodPost: s.withUser(s.sendCheer, store.RolePARENT)})
		mux.Handle("/api/cheers/{id}", httpx.Methods{http.MethodPatch: s.withUser(s.thankCheer, store.RoleSTUDENT)})
	})
}

// Linking: a code lives ten minutes; five wrong guesses lock a parent out for thirty.
// jitter: none — one student's code; its expiry sends nothing, a later invite's sweep deletes it
const (
	inviteLifetime = 10 * time.Minute
	linkAttempts   = 5
	linkLockout    = 30 * time.Minute
)

var codeShape = regexp.MustCompile(`^\d{6}$`)

var (
	errCodeShape     = apierr.New(400, "6자리 숫자를 입력해 주세요.")
	errLinkLocked    = apierr.New(429, "5회 확인에 실패했어요. 30분 후 다시 시도해 주세요.")
	errBadCode       = apierr.New(400, "유효하지 않거나 만료된 코드예요.")
	errUsedCode      = apierr.New(400, "이미 사용된 코드예요.")
	errChildNotFound = apierr.New(404, "연결된 자녀를 찾을 수 없어요.")
	errNoChild       = apierr.New(400, "먼저 자녀를 연결해 주세요.")
	errPointsShort   = apierr.New(400, "보유 포인트가 부족해요.")
	errCheerNotFound = apierr.New(404, "응원을 찾을 수 없어요.")
)

// clock is the request's moment as the database stores it: UTC, whole milliseconds (the
// previous server's Date resolution; timestamp(3) columns would round anything finer).
func (s *Server) clock() time.Time { return s.now().UTC().Truncate(time.Millisecond) }

// inviteCode draws a six-digit code from the same range as before, from crypto/rand.
func inviteCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(900000))
	if err != nil {
		return "", err
	}
	return strconv.FormatInt(n.Int64()+100000, 10), nil
}

type inviteResult struct {
	Code      string     `json:"code"`
	ExpiresAt jsonx.Time `json:"expiresAt"`
}

// createInvite replaces the student's earlier codes (and sweeps everyone's expired ones) with a
// fresh one that a parent can enter within ten minutes.
func (s *Server) createInvite(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	now := s.clock()
	var result inviteResult
	err := s.locked(ctx, user.ID, func(_ pgx.Tx, q *store.Queries) error {
		// jitter: none — the Invite table is tiny at PoC scale, so a class sweeping at once contends briefly [site server/internal/api/parent.go:80]
		if err := q.SweepInvites(ctx, store.SweepInvitesParams{StudentID: user.ID, Now: now}); err != nil {
			return err
		}
		code, err := inviteCode()
		if err != nil {
			return err
		}
		for {
			taken, err := q.InviteCodeExists(ctx, code)
			if err != nil {
				return err
			}
			if !taken {
				break
			}
			if code, err = inviteCode(); err != nil {
				return err
			}
		}
		expires := now.Add(inviteLifetime)
		if err := q.CreateInvite(ctx, store.CreateInviteParams{Code: code, StudentID: user.ID, ExpiresAt: expires}); err != nil {
			return err
		}
		result = inviteResult{Code: code, ExpiresAt: jsonx.Time(expires)}
		return nil
	})
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, result)
	return nil
}

// linkChild redeems an invite code for the parent. Failed guesses are counted and committed
// even though the request fails, so the transaction only rolls back on a real error; the answer
// for a refused code is decided inside and returned after the commit.
func (s *Server) linkChild(w http.ResponseWriter, r *http.Request, user store.User) error {
	var input struct {
		Code string `json:"code"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	if !codeShape.MatchString(input.Code) {
		return errCodeShape
	}
	ctx := r.Context()
	var (
		child   Profile
		refused error // the API error to answer once the failure count is committed
		touched bool  // the parent's row changed, so its cached snapshot is stale
	)
	err := s.locked(ctx, user.ID, func(_ pgx.Tx, q *store.Queries) error {
		parent, err := q.GetUser(ctx, user.ID)
		if err != nil {
			return err
		}
		now := s.clock()
		// The lock belongs to one parent, so its hint is the exact time left (spread 0).
		// jitter: retry-after exact time left on the parent's own lock (spread 0) on both refusals [site server/internal/api/parent.go:138]
		if parent.LinkLockedUntil != nil && parent.LinkLockedUntil.After(now) {
			refused = errLinkLocked.Retry(parent.LinkLockedUntil.Sub(now), 0)
			return nil
		}
		row, err := q.GetInviteStudent(ctx, input.Code)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err != nil || !row.Invite.ExpiresAt.After(now) || row.User.Suspended {
			// A lock that has since expired restarts the count.
			failures := parent.LinkFailures + 1
			if parent.LinkLockedUntil != nil {
				failures = 1
			}
			var lockedUntil *time.Time
			if failures >= linkAttempts {
				until := now.Add(linkLockout)
				lockedUntil = &until
			}
			if err := q.SetLinkState(ctx, store.SetLinkStateParams{ID: user.ID, LinkFailures: failures, LinkLockedUntil: lockedUntil}); err != nil {
				return err
			}
			touched = true
			refused = errBadCode
			if failures >= linkAttempts {
				// jitter: retry-after the full 30 min lockout, exact (spread 0): the lock is this parent's own
				refused = errLinkLocked.Retry(linkLockout, 0)
			}
			return nil
		}
		consumed, err := q.ConsumeInvite(ctx, store.ConsumeInviteParams{Code: input.Code, Now: now})
		if err != nil {
			return err
		}
		if consumed == 0 {
			refused = errUsedCode
			return nil
		}
		if err := q.UpsertParentLink(ctx, store.UpsertParentLinkParams{ParentID: user.ID, StudentID: row.Invite.StudentID}); err != nil {
			return err
		}
		studentID := row.Invite.StudentID
		if err := q.LinkSucceeded(ctx, store.LinkSucceededParams{ID: user.ID, SelectedChildID: &studentID}); err != nil {
			return err
		}
		touched = true
		child = profileOf(row.User)
		return nil
	})
	if touched {
		s.auth.Invalidate(ctx, user.ID)
	}
	if err != nil {
		return err
	}
	if refused != nil {
		return refused
	}
	httpx.OK(w, http.StatusOK, map[string]any{"child": child})
	return nil
}

// childItem is a linked student with the parent's current choice marked.
type childItem struct {
	Profile
	Selected bool `json:"selected"`
}

// listChildren answers the linked students oldest link first; without an explicit choice the
// first one counts as selected, as selectedChild resolves it.
func (s *Server) listChildren(w http.ResponseWriter, r *http.Request, user store.User) error {
	rows, err := s.q.ListChildren(r.Context(), user.ID)
	if err != nil {
		return err
	}
	chosen := ""
	if user.SelectedChildID != nil {
		chosen = *user.SelectedChildID
	}
	items := make([]childItem, 0, len(rows))
	for i, row := range rows {
		selected := i == 0
		if chosen != "" {
			selected = row.ID == chosen
		}
		items = append(items, childItem{Profile: profileOf(row), Selected: selected})
	}
	httpx.OK(w, http.StatusOK, items)
	return nil
}

func (s *Server) selectChild(w http.ResponseWriter, r *http.Request, user store.User) error {
	var input struct {
		ChildID string `json:"childId"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	v := &validator{}
	childID := v.id(input.ChildID)
	if err := v.result(); err != nil {
		return err
	}
	ctx := r.Context()
	if _, err := s.q.GetParentLink(ctx, store.GetParentLinkParams{ParentID: user.ID, StudentID: childID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errChildNotFound
		}
		return err
	}
	if err := s.q.SetSelectedChild(ctx, store.SetSelectedChildParams{ID: user.ID, SelectedChildID: &childID}); err != nil {
		return err
	}
	s.auth.Invalidate(ctx, user.ID)
	httpx.OK(w, http.StatusOK, map[string]bool{"selected": true})
	return nil
}

// unlinkChild removes the link and, when that child was the chosen one, the choice with it.
func (s *Server) unlinkChild(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	childID := r.PathValue("id")
	if err := s.q.DeleteParentLink(ctx, store.DeleteParentLinkParams{ParentID: user.ID, StudentID: childID}); err != nil {
		return err
	}
	if user.SelectedChildID != nil && *user.SelectedChildID == childID {
		if err := s.q.SetSelectedChild(ctx, store.SetSelectedChildParams{ID: user.ID, SelectedChildID: nil}); err != nil {
			return err
		}
		s.auth.Invalidate(ctx, user.ID)
	}
	httpx.OK(w, http.StatusOK, map[string]bool{"deleted": true})
	return nil
}

// weekStart is Monday 00:00 in Korea as a UTC instant, computed exactly as before: shift the
// clock by nine hours, take that calendar date, walk back to Monday, shift back.
func weekStart(now time.Time) time.Time {
	kst := now.UTC().Add(9 * time.Hour)
	y, m, d := kst.Date()
	weekday := int(kst.Weekday())
	return time.Date(y, m, d-(weekday+6)%7, 0, 0, 0, 0, time.UTC).Add(-9 * time.Hour)
}

type subjectStat struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Count    int32  `json:"count"`
	Accuracy int    `json:"accuracy"`
}

type parentStatsResult struct {
	SubjectStats    []subjectStat `json:"subjectStats"`
	MasteredCards   int64         `json:"masteredCards"`
	WeeklyQuestions int64         `json:"weeklyQuestions"`
	StudyDays       int64         `json:"studyDays"`
}

// parentStats summarises the selected child's week, honouring the child's privacy choices:
// study days need `time`, per-subject accuracy needs `accuracy`.
func (s *Server) parentStats(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	child, err := s.selectedChild(ctx, user)
	if err != nil {
		return err
	}
	result := parentStatsResult{SubjectStats: []subjectStat{}}
	if child == nil {
		httpx.OK(w, http.StatusOK, result)
		return nil
	}
	since := weekStart(s.now())
	if result.MasteredCards, err = s.q.CountMasteredCards(ctx, child.ID); err != nil {
		return err
	}
	if result.WeeklyQuestions, err = s.q.CountWeeklyQuestions(ctx, store.CountWeeklyQuestionsParams{UserID: child.ID, Since: since}); err != nil {
		return err
	}
	privacy := privacyOf(child.Privacy)
	if privacy.Time {
		if result.StudyDays, err = s.q.CountStudyDaysSince(ctx, store.CountStudyDaysSinceParams{UserID: child.ID, Since: since}); err != nil {
			return err
		}
	}
	if privacy.Accuracy {
		rows, err := s.q.SubjectAttemptStats(ctx, child.ID)
		if err != nil {
			return err
		}
		for _, row := range rows {
			accuracy := 0
			if row.Count > 0 {
				accuracy = int(math.Round(float64(row.Correct) / float64(row.Count) * 100))
			}
			result.SubjectStats = append(result.SubjectStats, subjectStat{ID: row.ID, Name: row.Name, Count: row.Count, Accuracy: accuracy})
		}
	}
	httpx.OK(w, http.StatusOK, result)
	return nil
}

// cheerRow is the Cheer table row as the client receives it.
type cheerRow struct {
	ID          string     `json:"id"`
	SenderID    string     `json:"senderId"`
	RecipientID string     `json:"recipientId"`
	Message     string     `json:"message"`
	Points      int32      `json:"points"`
	Thanked     bool       `json:"thanked"`
	CreatedAt   jsonx.Time `json:"createdAt"`
}

// sendCheer moves points from the parent to the selected child with a message and a
// notification, all in the parent's locked transaction.
func (s *Server) sendCheer(w http.ResponseWriter, r *http.Request, user store.User) error {
	var input struct {
		Message string   `json:"message"`
		Points  *float64 `json:"points"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	v := &validator{}
	message := v.text(input.Message, 500)
	points := 0
	if input.Points == nil {
		v.fail(msgInput)
	} else {
		points = v.intRange(*input.Points, 0, 10000)
	}
	if err := v.result(); err != nil {
		return err
	}
	ctx := r.Context()
	child, err := s.selectedChild(ctx, user)
	if err != nil {
		return err
	}
	if child == nil {
		return errNoChild
	}
	var cheer store.Cheer
	err = s.locked(ctx, user.ID, func(_ pgx.Tx, q *store.Queries) error {
		parent, err := q.GetUser(ctx, user.ID)
		if err != nil {
			return err
		}
		if int(parent.Points) < points {
			return errPointsShort
		}
		if err := q.AddPoints(ctx, store.AddPointsParams{ID: user.ID, Points: -int32(points)}); err != nil {
			return err
		}
		if err := q.AddPoints(ctx, store.AddPointsParams{ID: child.ID, Points: int32(points)}); err != nil {
			return err
		}
		if err := q.CreateNotification(ctx, store.CreateNotificationParams{ID: ids.New(), UserID: child.ID, Title: "응원이 도착했어요 🧡", Body: message, Href: "/cheer"}); err != nil {
			return err
		}
		cheer, err = q.CreateCheer(ctx, store.CreateCheerParams{ID: ids.New(), SenderID: user.ID, RecipientID: child.ID, Message: message, Points: int32(points)})
		return err
	})
	if err != nil {
		return err
	}
	s.auth.Invalidate(ctx, user.ID)
	s.auth.Invalidate(ctx, child.ID)
	s.bump(ctx, child.ID) // the child's bootstrap lists the cheer and the notification
	httpx.OK(w, http.StatusCreated, cheerRow{ID: cheer.ID, SenderID: cheer.SenderID, RecipientID: cheer.RecipientID, Message: cheer.Message, Points: cheer.Points, Thanked: cheer.Thanked, CreatedAt: jsonx.Time(cheer.CreatedAt)})
	return nil
}

// thankCheer lets the recipient mark a cheer thanked; anyone else's cheer is not found.
func (s *Server) thankCheer(w http.ResponseWriter, r *http.Request, user store.User) error {
	var input struct {
		Thanked *bool `json:"thanked"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	if input.Thanked == nil || !*input.Thanked {
		return errInput
	}
	updated, err := s.q.ThankCheer(r.Context(), store.ThankCheerParams{ID: r.PathValue("id"), RecipientID: user.ID})
	if err != nil {
		return err
	}
	if updated == 0 {
		return errCheerNotFound
	}
	httpx.OK(w, http.StatusOK, map[string]bool{"thanked": true})
	return nil
}
