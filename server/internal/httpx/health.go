package httpx

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/cache"
)

// Live answers Cloud Run's liveness probe: the process serves HTTP. It does no I/O, so a slow or
// restarting shared database never makes every instance fail liveness and restart together.
func Live() Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		OK(w, http.StatusOK, map[string]string{"status": "ok"})
		return nil
	}
}

// Health answers the startup probe and the deploy scripts: the database must respond.
// jitter: none — Cloud Run decides when probes run; liveness moved to Live (no I/O) [site server/internal/httpx/health.go:18]
func Health(pool *pgxpool.Pool, c cache.Cache) Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		var one int
		if err := pool.QueryRow(ctx, "SELECT 1").Scan(&one); err != nil {
			// jitter: none — only this handler returns ErrDatabase, and its callers are platform probes [site server/internal/httpx/health.go:21]
			return apierr.ErrDatabase
		}
		// The cache is a performance layer: its failure is reported, not fatal.
		cacheState := "ok"
		if _, _, err := c.Get(ctx, "health"); err != nil {
			cacheState = "unavailable"
		}
		OK(w, http.StatusOK, struct {
			Status   string `json:"status"`
			Database string `json:"database"`
			Cache    string `json:"cache"`
			Driver   string `json:"cacheDriver"`
		}{Status: "ok", Database: "connected", Cache: cacheState, Driver: c.Name()})
		return nil
	}
}

// Slow is a development-only endpoint the shutdown check uses to hold a request open.
func Slow() Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		ms, _ := strconv.Atoi(r.URL.Query().Get("ms"))
		if ms < 0 || ms > 5000 {
			ms = 1000
		}
		// jitter: none — development only: app.New registers it under Cfg.Development() [site server/internal/httpx/health.go:47]
		select {
		case <-time.After(time.Duration(ms) * time.Millisecond):
		case <-r.Context().Done():
			return r.Context().Err()
		}
		OK(w, http.StatusOK, map[string]int{"sleptMs": ms})
		return nil
	}
}
