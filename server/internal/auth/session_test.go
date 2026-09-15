package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"memoryz/server/internal/cache"
	"memoryz/server/internal/store"
)

func maxAgeOf(cookie string) int64 {
	_, rest, ok := strings.Cut(cookie, "Max-Age=")
	if !ok {
		return -1
	}
	digits, _, _ := strings.Cut(rest, ";")
	n, err := strconv.ParseInt(digits, 10, 64)
	if err != nil {
		return -1
	}
	return n
}

// TestSessionLifetime: the idle lifetime is 8 d − U[0, 12 h), both cookies carry the same drawn
// Max-Age, and the absolute cap of 30 d + a per-session offset spreads one class's forced re-sign-in
// over four weeks.
func TestSessionLifetime(t *testing.T) {
	a := New(testConfig(), nil, cache.NewMemory())
	now := time.Date(2026, 9, 16, 8, 50, 0, 0, time.UTC) // the bell
	a.rand = func() float64 { return 0 }
	if got := a.expiry(now).Sub(now); got != 8*24*time.Hour {
		t.Fatalf("r=0 gives the full 8 d: %v", got)
	}
	a.rand = func() float64 { return 1 - 1.0/(1<<53) }
	if got := a.expiry(now).Sub(now); got <= 7*24*time.Hour+12*time.Hour || got >= 7*24*time.Hour+12*time.Hour+time.Second {
		t.Fatalf("r→1 gives just over 7.5 d: %v", got)
	}
	if got := maxAgeOf(a.Cookie("t", 691200*time.Second)); got != 691200 {
		t.Fatalf("Max-Age is the remaining life in seconds: %d", got)
	}
	// 100 sessions made in the same second end over the whole 12 h window, not in one burst.
	a.rand = func() float64 { return 0 }
	seen := map[int64]bool{}
	for i := range 100 {
		a.rand = func() float64 { return float64(i) / 100 }
		seen[int64(a.expiry(now).Sub(now)/time.Hour)] = true
	}
	if len(seen) < 12 {
		t.Fatalf("expiries fall into %d distinct hours of the 12 h window", len(seen))
	}
	// The cap offset is stable per session and uniform-ish over 28 days.
	created := now
	weeks := map[int]int{}
	for i := range 400 {
		sum := sha256.Sum256([]byte{byte(i), byte(i >> 8)})
		hash := hex.EncodeToString(sum[:])
		limit := capAt(created, hash)
		if limit != capAt(created, hash) {
			t.Fatal("the cap is a function of the session")
		}
		offset := limit.Sub(created) - 30*24*time.Hour
		if offset < 0 || offset >= 28*24*time.Hour || limit.Nanosecond() != 0 {
			t.Fatalf("offset out of [0, 28 d): %v", offset)
		}
		weeks[int(offset/(7*24*time.Hour))]++
	}
	for w := range 4 {
		if weeks[w] < 60 {
			t.Fatalf("400 sessions spread their cap over 4 weeks: %v", weeks)
		}
	}
	if capAt(created, "short") != created.Add(30*24*time.Hour) || capAt(created.Add(123456789), "short") != created.Add(30*24*time.Hour) {
		t.Fatal("a malformed hash falls back to the 30 d cap")
	}
}

// TestSessionRenewal: an active session is renewed only once less than 4 d is left, moves forward
// by a fresh draw (never backwards under concurrent renewals), stops at the absolute cap, and
// re-issues both cookies with the new remaining life.
func TestSessionRenewal(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	student := f.user("STUDENT", false)
	cookie, _, err := f.auth.Create(ctx, student.ID)
	if err != nil {
		t.Fatal(err)
	}
	token := tokenOf(cookie)
	_, sess, err := f.auth.CurrentSession(ctx, withCookie(CookieName, token))
	if err != nil || sess.CreatedAt.IsZero() || sess.UserID != student.ID {
		t.Fatalf("current session carries its creation: %+v %v", sess, err)
	}
	if cookies, _, err := f.auth.Renew(ctx, token, sess); err != nil || cookies != nil {
		t.Fatalf("a fresh session is not renewed: %v %v", cookies, err)
	}
	// Five days later (3 d or less left) the next request renews it.
	base := f.auth.now()
	f.auth.now = func() time.Time { return base.Add(5 * 24 * time.Hour) }
	f.auth.rand = func() float64 { return 0.5 }
	_, sess, err = f.auth.CurrentSession(ctx, withCookie(CookieName, token))
	if err != nil {
		t.Fatal(err)
	}
	cookies, renewed, err := f.auth.Renew(ctx, token, sess)
	if err != nil || len(cookies) != 2 {
		t.Fatalf("renewal re-issues both cookies: %v %v", cookies, err)
	}
	want := f.auth.now().Add(8*24*time.Hour - 6*time.Hour)
	if d := renewed.ExpiresAt.Sub(want); d < -time.Millisecond || d > time.Millisecond {
		t.Fatalf("renewed to now + 8 d − draw: %v, want %v", renewed.ExpiresAt, want)
	}
	if !strings.HasPrefix(cookies[0], CookieName+"="+token+";") || maxAgeOf(cookies[0]) != maxAgeOf(cookies[1]) || maxAgeOf(cookies[0]) < 7*86400 {
		t.Fatalf("cookies follow the renewed session: %v", cookies)
	}
	var stored time.Time
	if err := f.pool.QueryRow(ctx, `SELECT "expiresAt" FROM "Session" WHERE "id" = $1`, TokenHash(token)).Scan(&stored); err != nil || stored.Sub(want).Abs() > time.Millisecond {
		t.Fatalf("stored expiry moved: %v %v", stored, err)
	}
	// The snapshot follows too: the next request sees the renewed session and does not renew again.
	_, again, err := f.auth.CurrentSession(ctx, withCookie(CookieName, token))
	if err != nil || again.ExpiresAt.Sub(want).Abs() > time.Millisecond {
		t.Fatalf("snapshot updated: %+v %v", again, err)
	}
	if cookies, _, _ := f.auth.Renew(ctx, token, again); cookies != nil {
		t.Fatal("a just-renewed session is not renewed again")
	}
	// Concurrent renewals: the stored expiry is the latest of them, never an earlier one.
	var wg sync.WaitGroup
	for i := range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = f.auth.q.RenewSession(ctx, store.RenewSessionParams{ID: TokenHash(token), ExpiresAt: base.Add(time.Duration(i) * time.Hour)})
		}()
	}
	wg.Wait()
	if err := f.pool.QueryRow(ctx, `SELECT "expiresAt" FROM "Session" WHERE "id" = $1`, TokenHash(token)).Scan(&stored); err != nil || stored.Sub(want).Abs() > time.Millisecond {
		t.Fatalf("an earlier renewal never moves the expiry back: %v %v", stored, err)
	}
	// A session near its absolute cap renews only up to the cap; one past it is not renewed.
	limit := capAt(renewed.CreatedAt, renewed.Hash)
	near := renewed
	near.CreatedAt = renewed.CreatedAt.Add(f.auth.now().Add(2 * 24 * time.Hour).Sub(limit))
	near.ExpiresAt = f.auth.now().Add(time.Hour)
	if _, err := f.pool.Exec(ctx, `UPDATE "Session" SET "expiresAt" = $2 WHERE "id" = $1`, TokenHash(token), near.ExpiresAt); err != nil {
		t.Fatal(err)
	}
	_, capped, err := f.auth.Renew(ctx, token, near)
	if err != nil || capped.ExpiresAt.Sub(capAt(near.CreatedAt, near.Hash)).Abs() > time.Millisecond {
		t.Fatalf("renewal stops at the cap: %v (cap %v) %v", capped.ExpiresAt, capAt(near.CreatedAt, near.Hash), err)
	}
	// The next request reads the capped session back (from Postgres, not the snapshot) and leaves it.
	_ = f.auth.cache.Del(ctx, sessionKey(TokenHash(token)))
	_, past, err := f.auth.CurrentSession(ctx, withCookie(CookieName, token))
	if err != nil || !past.ExpiresAt.Equal(capped.ExpiresAt) {
		t.Fatalf("stored cap reads back exactly: %v vs %v %v", past.ExpiresAt, capped.ExpiresAt, err)
	}
	past.CreatedAt = near.CreatedAt
	if cookies, _, _ := f.auth.Renew(ctx, token, past); cookies != nil {
		t.Fatal("a session at its cap is not renewed")
	}
	// A session logged out between the read and the renewal is left alone.
	if err := f.auth.Delete(ctx, token); err != nil {
		t.Fatal(err)
	}
	gone := renewed
	gone.ExpiresAt = f.auth.now().Add(time.Hour)
	if cookies, _, err := f.auth.Renew(ctx, token, gone); cookies != nil || err != nil {
		t.Fatalf("a deleted session is not revived: %v %v", cookies, err)
	}
	if _, err := f.auth.q.RenewSession(ctx, store.RenewSessionParams{ID: TokenHash(token), ExpiresAt: want}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("renewing a deleted session matches no row: %v", err)
	}
}

// TestHintFollowsSession: the readable signed-in flag never outlives the session: at creation both
// cookies carry one drawn Max-Age, a re-issued flag carries the session's remaining life, and a
// renewal moves both together.
func TestHintFollowsSession(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	student := f.user("STUDENT", false)
	session, hint, err := f.auth.Create(ctx, student.ID)
	if err != nil {
		t.Fatal(err)
	}
	if maxAgeOf(session) != maxAgeOf(hint) {
		t.Fatalf("one draw for both: %s / %s", session, hint)
	}
	base := f.auth.now()
	f.auth.now = func() time.Time { return base.Add(2 * 24 * time.Hour) }
	_, sess, err := f.auth.CurrentSession(ctx, withCookie(CookieName, tokenOf(session)))
	if err != nil {
		t.Fatal(err)
	}
	reissued := f.auth.HintCookie(sess.ExpiresAt.Sub(f.auth.now()))
	if got, want := maxAgeOf(reissued), maxAgeOf(session)-2*86400; got < want-1 || got > want {
		t.Fatalf("a re-issued flag carries the remaining life: %d, want %d", got, want)
	}
	f.auth.now = func() time.Time { return base.Add(5 * 24 * time.Hour) }
	cookies, renewed, err := f.auth.Renew(ctx, tokenOf(session), sess)
	if err != nil || len(cookies) != 2 || maxAgeOf(cookies[0]) != maxAgeOf(cookies[1]) {
		t.Fatalf("renewal moves both: %v %v", cookies, err)
	}
	if left := int64(renewed.ExpiresAt.Sub(f.auth.now()) / time.Second); maxAgeOf(cookies[1]) != left {
		t.Fatalf("the renewed flag is the session's new remaining life: %d vs %d", maxAgeOf(cookies[1]), left)
	}
}

// TestGateServesOnBackendError: a database the gate cannot reach serves the page (its API calls are
// checked again) instead of bouncing a signed-in learner home; an auth error still goes home.
func TestGateServesOnBackendError(t *testing.T) {
	f := newFixture(t)
	student := f.user("STUDENT", false)
	session, _, err := f.auth.Create(context.Background(), student.ID)
	if err != nil {
		t.Fatal(err)
	}
	broken, err := pgxpool.New(context.Background(), f.pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	broken.Close()
	a := New(testConfig(), broken, cache.NewMemory())
	served := 0
	gate := a.GateHTML(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { served++ }))
	req := httptest.NewRequest(http.MethodGet, "/study", nil)
	req.AddCookie(&http.Cookie{Name: CookieName, Value: tokenOf(session)})
	rec := httptest.NewRecorder()
	gate.ServeHTTP(rec, req)
	if served != 1 || rec.Code != http.StatusOK {
		t.Fatalf("an unreachable database serves the page: served=%d code=%d", served, rec.Code)
	}
	req = httptest.NewRequest(http.MethodGet, "/study", nil)
	req.AddCookie(&http.Cookie{Name: CookieName, Value: "short"})
	rec = httptest.NewRecorder()
	gate.ServeHTTP(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("a malformed session still goes home: %d", rec.Code)
	}
}

// hangingCache answers every read only when its context ends (a cache that stopped responding).
type hangingCache struct{ cache.Cache }

func (hangingCache) Get(ctx context.Context, _ string) ([]byte, bool, error) {
	<-ctx.Done()
	return nil, false, ctx.Err()
}

// TestGateTimeout: a session lookup that hangs gives up at the gate's 3 s bound and the page is
// served (its API calls are checked again), instead of holding the navigation until the request's.
func TestGateTimeout(t *testing.T) {
	f := newFixture(t)
	student := f.user("STUDENT", false)
	session, _, err := f.auth.Create(context.Background(), student.ID)
	if err != nil {
		t.Fatal(err)
	}
	a := New(testConfig(), f.pool, hangingCache{cache.NewMemory()})
	served := 0
	gate := a.GateHTML(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { served++ }))
	req := httptest.NewRequest(http.MethodGet, "/study", nil)
	req.AddCookie(&http.Cookie{Name: CookieName, Value: tokenOf(session)})
	started := time.Now()
	gate.ServeHTTP(httptest.NewRecorder(), req)
	if took := time.Since(started); took < gateTimeout || took > gateTimeout+time.Second || served != 1 {
		t.Fatalf("gave up at %v (bound %v), served=%d", took, gateTimeout, served)
	}
}
