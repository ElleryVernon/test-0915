// Package api holds the HTTP endpoints behind /api. Each handler validates its input, talks to the
// store and answers with the contract the web client expects.
package api

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
	"golang.org/x/sync/singleflight"

	"memoryz/server/internal/ai"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/auth"
	"memoryz/server/internal/blob"
	"memoryz/server/internal/cache"
	"memoryz/server/internal/config"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/jitter"
	"memoryz/server/internal/logx"
	"memoryz/server/internal/store"
)

// Server is the set of endpoints and their dependencies.
type Server struct {
	cfg         *config.Config
	pool        *pgxpool.Pool
	q           *store.Queries
	cache       cache.Cache
	auth        *auth.Auth
	blobs       blob.Store
	ai          *ai.Provider
	log         *slog.Logger
	paymentHTTP *http.Client // tests substitute a transport; provider origin remains fixed
	now         func() time.Time
	pdfSlots    chan struct{} // bounds concurrent PDF extractions per instance
	// rand is the jitter source (docs/JITTER.md); pause waits on a timer or the context. Tests pin both.
	rand    jitter.Rand
	pause   func(context.Context, time.Duration) bool
	flights singleflight.Group // one cache fill per key at a time
	// runs maps the AI runs this instance is executing to their cancel functions, for Drain.
	runs     sync.Map
	draining atomic.Bool
}

// New wires the endpoints.
func New(cfg *config.Config, pool *pgxpool.Pool, c cache.Cache, a *auth.Auth, blobs blob.Store, log *slog.Logger) *Server {
	return &Server{
		cfg: cfg, pool: pool, q: store.New(pool), cache: c, auth: a, blobs: blobs, log: log,
		// Millisecond precision everywhere: the columns are TIMESTAMP(3) and the client's clock is
		// Date.now(), so comparisons never trip over sub-millisecond rounding.
		now:      func() time.Time { return time.Now().UTC().Truncate(time.Millisecond) },
		ai:       ai.NewProvider(cfg, cfg.OpenRouterBaseURL, log),
		pdfSlots: make(chan struct{}, cfg.PDFWorkers),
		rand:     jitter.Std,
		pause:    sleepCtx,
	}
}

// userHandler is an endpoint that needs the signed-in account.
type userHandler func(w http.ResponseWriter, r *http.Request, user store.User) error

// withUser resolves the session first; roles restrict further when given.
func (s *Server) withUser(h userHandler, roles ...store.Role) httpx.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		user, sess, err := s.auth.CurrentSession(r.Context(), r)
		if err != nil {
			return err
		}
		// Pending accounts may resume setup and sign out, but cannot create role-
		// specific data before choosing the role that will own it.
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.URL.Path != "/api/onboarding" {
			pending, err := s.auth.NeedsOnboarding(r.Context(), user.ID)
			if err != nil {
				return err
			}
			if pending {
				return apierr.WithCode(409, "가입 설정을 먼저 마쳐 주세요.", "ONBOARDING_REQUIRED")
			}
		}
		if len(roles) > 0 {
			if err := auth.RequireRole(user, roles...); err != nil {
				return err
			}
		}
		// An active session slides forward once it is past half its life; both cookies follow. A
		// device signed in before the readable flag existed gets it on its next request.
		cookies, sess, err := s.auth.Renew(r.Context(), auth.ReadToken(r), sess)
		if err != nil {
			logx.From(r.Context()).Warn("session renewal failed", "error", err.Error())
		}
		for _, c := range cookies {
			w.Header().Add("Set-Cookie", c)
		}
		if _, err := r.Cookie(auth.SignedInCookie); err != nil && len(cookies) == 0 {
			w.Header().Add("Set-Cookie", s.auth.HintCookie(sess.ExpiresAt.Sub(s.now())))
		}
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			return h(w, r, user)
		}
		// A write that answers success moves the account (and the shared lists it touched) to a
		// new cache version just before the answer leaves, so the client's next read is fresh.
		return h(&bumping{ResponseWriter: w, s: s, r: r, userID: user.ID}, r, user)
	}
}

type bumping struct {
	http.ResponseWriter
	s      *Server
	r      *http.Request
	userID string
	wrote  bool
}

func (b *bumping) WriteHeader(status int) {
	if !b.wrote {
		b.wrote = true
		if status < 400 {
			b.s.invalidate(b.r, b.userID)
		}
	}
	b.ResponseWriter.WriteHeader(status)
}

func (b *bumping) Write(p []byte) (int, error) {
	if !b.wrote {
		b.WriteHeader(http.StatusOK)
	}
	return b.ResponseWriter.Write(p)
}

func (b *bumping) Flush() {
	if f, ok := b.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// invalidate is the one place that knows which shared lists a route can change.
func (s *Server) invalidate(r *http.Request, userID string) {
	ids := []string{userID}
	path := r.URL.Path
	switch {
	case strings.HasPrefix(path, "/api/posts/") && strings.HasSuffix(path, "/save"):
		// Saving changes only the viewer's own flag, which the viewer's version already covers; a
		// class saving posts must not empty every feed cache.
	case strings.HasPrefix(path, "/api/posts"), strings.HasPrefix(path, "/api/blocks"), path == "/api/admin/users/"+r.PathValue("id"):
		// jitter: none — a version change cannot be spread over time; one bounded bump call, and /save skips it [site server/internal/api/api.go:114]
		ids = append(ids, "posts") // the shared feed lists
	case path == "/api/admin/schools":
		ids = append(ids, "schools")
	}
	s.bump(r.Context(), ids...)
}

// Mount registers the endpoints that live under the CSRF-protected API mux.
func (s *Server) Mount(mux *http.ServeMux) {
	mux.Handle("/api/config", httpx.Methods{http.MethodGet: s.configHandler})
	mux.Handle("/api/session", httpx.Methods{http.MethodPost: s.demoLogin})
	mux.Handle("/api/logout", httpx.Methods{http.MethodPost: s.logout})
	mux.Handle("/api/me", httpx.Methods{http.MethodGet: s.withUser(s.me)})
	for _, mount := range mounts {
		mount(s, mux)
	}
}

// MountAuth registers the social login routes; they receive cross-site redirects and form posts,
// so they sit outside the CSRF rule.
func (s *Server) MountAuth(mux *http.ServeMux) {
	mux.Handle("/api/auth/{provider}", httpx.Methods{http.MethodGet: s.oauthStart})
	mux.Handle("/api/auth/{provider}/callback", httpx.Methods{http.MethodGet: s.oauthCallback, http.MethodPost: s.oauthCallback})
	mux.Handle("/api/auth/", httpx.Handler(func(http.ResponseWriter, *http.Request) error { return auth.ErrBadStep }))
}

// clientIP is the caller's address for rate limiting. Behind Cloud Run's front end the trusted
// address is the LAST X-Forwarded-For entry (the front end appends it; anything before it was
// written by the client and can be forged). Without a trusted proxy only the socket peer counts.
func clientIP(r *http.Request, cfg *config.Config) string {
	ip, hop, entries := clientAddr(r, cfg.TrustProxy, cfg.TrustedProxies)
	// Only counts reach the trace (never an address): they show which X-Forwarded-For entry was
	// taken, which the cloud smoke test checks through the load balancer.
	trace.SpanFromContext(r.Context()).SetAttributes(attribute.Int("memoryz.client.hop", hop), attribute.Int("memoryz.client.entries", entries))
	return ip
}

// clientAddr is the rightmost X-Forwarded-For entry that is not a trusted proxy: Cloud Run appends
// the client it saw, and the load balancer in front of it appends the client and then its own
// forwarding-rule address (`<anything the client sent>,<client>,<lb>`), so everything left of the
// client is the client's own claim and is ignored. hop counts the trusted entries skipped (-1 when
// X-Forwarded-For is not used and the socket address is taken).
func clientAddr(r *http.Request, trustProxy bool, trusted []netip.Prefix) (ip string, hop, entries int) {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			for i := len(parts) - 1; i >= 0; i-- {
				entry := strings.TrimSpace(parts[i])
				if entry == "" {
					break
				}
				if addr, err := netip.ParseAddr(entry); err == nil && slices.ContainsFunc(trusted, func(p netip.Prefix) bool { return p.Contains(addr.Unmap()) }) {
					continue
				}
				return entry, len(parts) - 1 - i, len(parts)
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr, -1, 0
	}
	return host, -1, 0
}
