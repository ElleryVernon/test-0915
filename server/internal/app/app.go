// Package app assembles the HTTP application: middleware, the API routes and the static web build.
package app

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"memoryz/server/internal/api"
	"memoryz/server/internal/auth"
	"memoryz/server/internal/blob"
	"memoryz/server/internal/cache"
	"memoryz/server/internal/config"
	"memoryz/server/internal/httpx"
)

// Deps is everything the routes need.
type Deps struct {
	Cfg   *config.Config
	Pool  *pgxpool.Pool
	Log   *slog.Logger
	Blobs blob.Store
	Cache cache.Cache
}

// DefaultTimeout bounds ordinary API requests; uploads and AI runs extend it per handler.
// jitter: retry-after a missed deadline answers 504 ErrTimeout with 2 s + U[0,4 s); 15 s stays under the client's 20 s bootstrap abort [site server/internal/app/app.go:29]
const DefaultTimeout = 15 * time.Second

// New builds the root handler and the drain hook httpx.Serve runs into a shutdown.
func New(d Deps) (http.Handler, func()) {
	authService := auth.New(d.Cfg, d.Pool, d.Cache)
	server := api.New(d.Cfg, d.Pool, d.Cache, authService, d.Blobs, d.Log)

	apiMux := http.NewServeMux()
	apiMux.Handle("/api/health", httpx.Methods{http.MethodGet: httpx.Health(d.Pool, d.Cache)})
	apiMux.Handle("/api/live", httpx.Methods{http.MethodGet: httpx.Live()})
	server.Mount(apiMux)
	if d.Cfg.Development() {
		// Pool acquisitions since start: verification counts the database work behind a request.
		apiMux.Handle("/api/_dev/stats", httpx.Methods{http.MethodGet: func(w http.ResponseWriter, r *http.Request) error {
			st := d.Pool.Stat()
			httpx.OK(w, http.StatusOK, map[string]any{"acquireCount": st.AcquireCount(), "totalConns": st.TotalConns(), "cache": d.Cache.Name()})
			return nil
		}})
		// For checks that write to the database directly and then read through the API.
		apiMux.Handle("/api/_dev/cache-flush", httpx.Methods{http.MethodPost: func(w http.ResponseWriter, r *http.Request) error {
			if err := d.Cache.Flush(r.Context()); err != nil {
				return err
			}
			httpx.OK(w, http.StatusOK, map[string]string{"cache": "flushed"})
			return nil
		}})
		apiMux.Handle("/api/_dev/slow", httpx.Methods{http.MethodGet: httpx.Slow()})
		apiMux.Handle("/api/_dev/echo", httpx.Methods{http.MethodPost: echo})
		apiMux.Handle("/api/_dev/panic", httpx.Methods{http.MethodGet: func(http.ResponseWriter, *http.Request) error { panic("dev panic") }})
	}
	apiMux.Handle("/api/", httpx.NotFound)
	apiHandler := httpx.Chain(apiMux, httpx.CSRF(d.Cfg.AppURL), httpx.Timeout(DefaultTimeout))

	authMux := http.NewServeMux()
	server.MountAuth(authMux)
	authHandler := httpx.Chain(authMux, httpx.Timeout(30*time.Second))

	root := http.NewServeMux()
	root.Handle("/api/auth/", authHandler)
	root.Handle("/api/", apiHandler)
	if d.Cfg.StaticDir != "" {
		root.Handle("/", authService.GateHTML(httpx.NewSPA(d.Cfg.StaticDir)))
	} else {
		root.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = w.Write([]byte("memoryz api\n"))
		}))
	}
	return httpx.Chain(root, httpx.Trace(), httpx.Recover(), httpx.Observe(d.Log, d.Cfg.GoogleProject), httpx.SecurityHeaders(d.Cfg.Secure()), httpx.Gzip()), server.Drain
}

// echo is a development-only endpoint that exercises JSON decoding limits and compression.
func echo(w http.ResponseWriter, r *http.Request) error {
	var body map[string]any
	if err := httpx.Decode(r, &body); err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, body)
	return nil
}
