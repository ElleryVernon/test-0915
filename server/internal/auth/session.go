// Package auth owns sign-in for the Go server: opaque session tokens in a cookie, the current-user
// lookup every endpoint starts with, the social login flows and the role gate for HTML routes.
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/cache"
	"memoryz/server/internal/config"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/jitter"
	"memoryz/server/internal/logx"
	"memoryz/server/internal/store"
)

const (
	// CookieName carries the session token; the browser never sees anything else.
	CookieName = "memoryz_session"
	// A session lives idleLifetime minus up to lifetimeTrim from its creation or last renewal: always
	// longer than a weekly timetable (so a class never meets its expiry at the next lesson's bell),
	// and spread so sessions created together do not end together. An authenticated API request
	// renews it once less than renewBelow is left, up to an absolute cap of maxAge plus a per-session
	// offset below maxAgeSpread, which spreads the forced re-sign-in over four weekly lessons.
	// jitter: lifetime idle 8 d − U[0,12 h), sliding renewal under 4 d, absolute cap 30 d + per-session offset in [0,28 d) [site server/internal/auth/session.go:32]
	idleLifetime = 8 * 24 * time.Hour
	lifetimeTrim = 12 * time.Hour
	renewBelow   = 4 * 24 * time.Hour
	maxAge       = 30 * 24 * time.Hour
	maxAgeSpread = 28 * 24 * time.Hour
	// jitter: none — per-device and per-user snapshots; an expiry sends no request, the owner's next one reads Postgres
	snapshotTTL = 60 * time.Second
)

var tokenShape = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Auth is the shared sign-in service.
type Auth struct {
	cfg   *config.Config
	pool  *pgxpool.Pool
	q     *store.Queries
	cache cache.Cache
	// now and rand are replaceable in tests.
	now  func() time.Time
	rand jitter.Rand
}

// New wires the service.
func New(cfg *config.Config, pool *pgxpool.Pool, c cache.Cache) *Auth {
	return &Auth{cfg: cfg, pool: pool, q: store.New(pool), cache: c, now: func() time.Time { return time.Now().UTC() }, rand: jitter.Std}
}

// Session is the signed-in state behind a cookie.
type Session struct {
	Hash      string
	UserID    string
	ExpiresAt time.Time
	CreatedAt time.Time // zero for a snapshot cached before this field existed: no renewal then
}

// expiry is a new idle deadline from now: 8 d − U[0, 12 h), in (7.5 d, 8 d].
func (a *Auth) expiry(now time.Time) time.Time {
	return now.Add(idleLifetime - jitter.Between(a.rand, 0, lifetimeTrim))
}

// capAt is the absolute end of a session: 30 d after creation plus a stable offset in [0, 28 d)
// taken from the token hash, so one class's sessions reach it on different weeks. It is a whole
// second, which Postgres stores exactly: a session renewed up to its cap then compares equal to it
// and is not renewed again on every request.
func capAt(created time.Time, hash string) time.Time {
	var offset uint64
	if len(hash) >= 16 {
		if b, err := hex.DecodeString(hash[:16]); err == nil {
			offset = binary.BigEndian.Uint64(b) % uint64(maxAgeSpread/time.Second)
		}
	}
	return created.Add(maxAge + time.Duration(offset)*time.Second).Truncate(time.Second)
}

// TokenHash is the session's primary key: only the hash is stored, so a database read never
// yields a usable cookie.
func TokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// ReadToken returns the raw session token from the request, or "".
func ReadToken(r *http.Request) string {
	c, err := r.Cookie(CookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

// Cookie renders the Set-Cookie value that carries token for the session's remaining life.
func (a *Auth) Cookie(token string, left time.Duration) string {
	secure := ""
	if a.cfg.Secure() {
		secure = "; Secure"
	}
	return fmt.Sprintf("%s=%s; HttpOnly; SameSite=Lax; Path=/; Max-Age=%d%s", CookieName, token, int64(left/time.Second), secure)
}

// ClearCookie renders the Set-Cookie value that removes the session cookie.
func (a *Auth) ClearCookie() string {
	return CookieName + "=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
}

// SignedInCookie is a readable (not HttpOnly) flag that travels with the session cookie so the
// web app knows whether asking for bootstrap can succeed. It carries no secret: a logged-out
// device simply skips the request instead of collecting a 401 on every visit.
const SignedInCookie = "memoryz_signed_in"

// HintCookie renders the signed-in flag for the session's remaining life; it makes no draw of its
// own, so it can never outlive the session it describes.
// jitter: lifetime the session's own remaining life, never a draw of its own [site server/internal/auth/session.go:95]
func (a *Auth) HintCookie(left time.Duration) string {
	secure := ""
	if a.cfg.Secure() {
		secure = "; Secure"
	}
	return fmt.Sprintf("%s=1; SameSite=Lax; Path=/; Max-Age=%d%s", SignedInCookie, int64(left/time.Second), secure)
}

// ClearHintCookie renders the Set-Cookie value that removes the signed-in flag.
func (a *Auth) ClearHintCookie() string {
	return SignedInCookie + "=; SameSite=Lax; Path=/; Max-Age=0"
}

// Create issues a session for userID and returns its two Set-Cookie values (the HttpOnly session
// and the readable signed-in flag, with the same Max-Age). Expired sessions of the same account are
// swept while we are here.
func (a *Auth) Create(ctx context.Context, userID string) (session, hint string, err error) {
	token := ids.Token(32)
	now := a.now()
	expires := a.expiry(now)
	if err := a.q.CreateSession(ctx, store.CreateSessionParams{ID: TokenHash(token), UserID: userID, ExpiresAt: expires}); err != nil {
		return "", "", err
	}
	// jitter: none — deletes only the signing-in user's expired rows [site server/internal/auth/session.go:111]
	if err := a.q.DeleteExpiredSessions(ctx, userID); err != nil {
		return "", "", err
	}
	left := expires.Sub(now)
	return a.Cookie(token, left), a.HintCookie(left), nil
}

// Renew extends an active session: with less than renewBelow left and the absolute cap not yet
// reached, the session moves to min(expiry(now), cap) — never backwards, since concurrent requests
// may renew together — and both cookies are re-issued with the new Max-Age. No renewal is due most
// of the time; then it returns no cookies and the session unchanged.
func (a *Auth) Renew(ctx context.Context, token string, sess Session) ([]string, Session, error) {
	now := a.now()
	if sess.CreatedAt.IsZero() || sess.ExpiresAt.Sub(now) >= renewBelow {
		return nil, sess, nil
	}
	limit := capAt(sess.CreatedAt, sess.Hash)
	if !sess.ExpiresAt.Before(limit) {
		return nil, sess, nil
	}
	next := a.expiry(now)
	if next.After(limit) {
		next = limit
	}
	stored, err := a.q.RenewSession(ctx, store.RenewSessionParams{ID: sess.Hash, ExpiresAt: next})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, sess, nil // logged out in the meantime
	}
	if err != nil {
		return nil, sess, err
	}
	sess.ExpiresAt = stored
	a.putSession(ctx, sess.Hash, sessionSnapshot{UserID: sess.UserID, ExpiresAt: stored, CreatedAt: sess.CreatedAt})
	left := stored.Sub(now)
	return []string{a.Cookie(token, left), a.HintCookie(left)}, sess, nil
}

// Delete ends the session behind token (if any) and forgets its snapshot.
func (a *Auth) Delete(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	hash := TokenHash(token)
	if err := a.q.DeleteSession(ctx, hash); err != nil {
		return err
	}
	return a.cache.Del(ctx, sessionKey(hash))
}

// Invalidate forgets the cached user row after any write to "User" (profile, points, suspension,
// link state), so the next request reads the database.
func (a *Auth) Invalidate(ctx context.Context, userID string) {
	if err := a.cache.Del(ctx, userKey(userID)); err != nil {
		logx.From(ctx).Warn("user cache invalidation failed", slog.String("userId", userID), slog.String("error", err.Error()))
	}
}

func sessionKey(hash string) string { return "sess:" + hash }
func userKey(id string) string      { return "user:" + id }

type sessionSnapshot struct {
	UserID    string    `json:"userId"`
	ExpiresAt time.Time `json:"expiresAt"`
	CreatedAt time.Time `json:"createdAt,omitzero"`
}

// CurrentUser resolves the account behind the request's cookie, or the API's 401/403.
func (a *Auth) CurrentUser(ctx context.Context, r *http.Request) (store.User, error) {
	user, _, err := a.CurrentSession(ctx, r)
	return user, err
}

// CurrentSession is CurrentUser with the session it came from (for renewal).
func (a *Auth) CurrentSession(ctx context.Context, r *http.Request) (store.User, Session, error) {
	token := ReadToken(r)
	if token == "" || !tokenShape.MatchString(token) {
		return store.User{}, Session{}, apierr.ErrLoginRequired
	}
	hash := TokenHash(token)
	now := a.now()
	if snap, ok := a.getSession(ctx, hash); ok {
		if !snap.ExpiresAt.After(now) {
			return store.User{}, Session{}, apierr.ErrSessionExpired
		}
		sess := Session{Hash: hash, UserID: snap.UserID, ExpiresAt: snap.ExpiresAt, CreatedAt: snap.CreatedAt}
		if user, ok := a.getUser(ctx, snap.UserID); ok {
			return a.admit(user, sess)
		}
		user, err := a.q.GetUser(ctx, snap.UserID)
		if errors.Is(err, pgx.ErrNoRows) {
			_ = a.cache.Del(ctx, sessionKey(hash))
			return store.User{}, Session{}, apierr.ErrSessionExpired
		}
		if err != nil {
			return store.User{}, Session{}, err
		}
		a.putUser(ctx, user)
		return a.admit(user, sess)
	}
	row, err := a.q.GetSessionUser(ctx, hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return store.User{}, Session{}, apierr.ErrSessionExpired
	}
	if err != nil {
		return store.User{}, Session{}, err
	}
	if !row.SessionExpires.After(now) {
		return store.User{}, Session{}, apierr.ErrSessionExpired
	}
	sess := Session{Hash: hash, UserID: row.User.ID, ExpiresAt: row.SessionExpires, CreatedAt: row.SessionCreated}
	a.putSession(ctx, hash, sessionSnapshot{UserID: row.User.ID, ExpiresAt: row.SessionExpires, CreatedAt: row.SessionCreated})
	a.putUser(ctx, row.User)
	return a.admit(row.User, sess)
}

func (a *Auth) admit(user store.User, sess Session) (store.User, Session, error) {
	if user.Suspended {
		return store.User{}, Session{}, apierr.ErrSuspended
	}
	return user, sess, nil
}

func (a *Auth) getSession(ctx context.Context, hash string) (sessionSnapshot, bool) {
	raw, ok, err := a.cache.Get(ctx, sessionKey(hash))
	if err != nil || !ok {
		return sessionSnapshot{}, false
	}
	var snap sessionSnapshot
	if json.Unmarshal(raw, &snap) != nil || snap.UserID == "" {
		return sessionSnapshot{}, false
	}
	return snap, true
}

func (a *Auth) putSession(ctx context.Context, hash string, snap sessionSnapshot) {
	raw, err := json.Marshal(snap)
	if err != nil {
		return
	}
	// jitter: none — per-device snapshot for min(60 s, session left); a miss refills by one primary-key join on that device's next request [site server/internal/auth/session.go:210]
	ttl := snapshotTTL
	if until := time.Until(snap.ExpiresAt); until < ttl {
		ttl = until
	}
	if ttl > 0 {
		_ = a.cache.Set(ctx, sessionKey(hash), raw, ttl)
	}
}

func (a *Auth) getUser(ctx context.Context, id string) (store.User, bool) {
	raw, ok, err := a.cache.Get(ctx, userKey(id))
	if err != nil || !ok {
		return store.User{}, false
	}
	var user store.User
	if json.Unmarshal(raw, &user) != nil || user.ID == "" {
		return store.User{}, false
	}
	return user, true
}

func (a *Auth) putUser(ctx context.Context, user store.User) {
	// jitter: none — per-user snapshot for 60 s; a miss refills by one primary-key query on the owner's next request [site server/internal/auth/session.go:233]
	if raw, err := json.Marshal(user); err == nil {
		_ = a.cache.Set(ctx, userKey(user.ID), raw, snapshotTTL)
	}
}

// RequireRole answers 403 unless the account has one of the roles.
func RequireRole(user store.User, roles ...store.Role) error {
	for _, role := range roles {
		if user.Role == role {
			return nil
		}
	}
	return apierr.ErrRole
}
