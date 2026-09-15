// Package db opens the Postgres pool (directly or through the Cloud SQL connector), runs the
// embedded migrations and maps driver errors onto the API's error contract.
package db

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"regexp"
	"strings"
	"time"

	"cloud.google.com/go/cloudsqlconn"
	"github.com/exaring/otelpgx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgconn/ctxwatch"
	"github.com/jackc/pgx/v5/pgxpool"

	"memoryz/server/internal/apierr"
)

// Options selects how the pool connects.
type Options struct {
	URL      string // postgres:// URL; used when Instance is empty
	Instance string // Cloud SQL instance connection name project:region:instance
	User     string
	Name     string
	Password string
	IAMAuth  bool
	IPType   string // private | public
	PoolMax  int32
}

// Connect opens the pool and verifies it with one round trip. The returned close function
// releases the pool and the Cloud SQL dialer, if one was created.
func Connect(ctx context.Context, o Options, logger *slog.Logger) (*pgxpool.Pool, func(), error) {
	var cfg *pgxpool.Config
	var err error
	closers := []func(){}
	if o.Instance != "" {
		// The connector encrypts and authenticates the tunnel itself; sslmode=disable is for the inner protocol.
		cfg, err = pgxpool.ParseConfig("sslmode=disable")
		if err != nil {
			return nil, nil, fmt.Errorf("cloud sql config: %w", err)
		}
		cfg.ConnConfig.User = o.User
		cfg.ConnConfig.Password = o.Password
		cfg.ConnConfig.Database = o.Name
		// jitter: none — the connector refreshes its certificate once per instance under a mutex and jitters that itself [site server/internal/db/db.go:51]
		dialOpts := []cloudsqlconn.Option{cloudsqlconn.WithLazyRefresh()}
		if o.IAMAuth {
			dialOpts = append(dialOpts, cloudsqlconn.WithIAMAuthN())
		}
		dialer, derr := cloudsqlconn.NewDialer(ctx, dialOpts...)
		if derr != nil {
			return nil, nil, fmt.Errorf("cloud sql dialer: %w", derr)
		}
		closers = append(closers, func() { _ = dialer.Close() })
		ipOpt := cloudsqlconn.WithPrivateIP()
		if o.IPType == "public" {
			ipOpt = cloudsqlconn.WithPublicIP()
		}
		instance := o.Instance
		cfg.ConnConfig.DialFunc = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.Dial(ctx, instance, ipOpt)
		}
	} else {
		cfg, err = pgxpool.ParseConfig(o.URL)
		if err != nil {
			return nil, nil, fmt.Errorf("database url: %w", err)
		}
	}
	cfg.AfterConnect = registerUTCTimestamps
	// Every query becomes a child span of the request (a no-op until a tracer provider is installed),
	// named by its sqlc query name so traces read as the code does.
	cfg.ConnConfig.Tracer = otelpgx.NewTracer(otelpgx.WithSpanNameFunc(SpanName), otelpgx.WithDisableSQLStatementInAttributes())
	tune(cfg, o.PoolMax)
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		for _, c := range closers {
			c()
		}
		return nil, nil, fmt.Errorf("pool: %w", err)
	}
	closers = append([]func(){pool.Close}, closers...)
	closeAll := func() {
		for _, c := range closers {
			c()
		}
	}
	// Cloud Run may start the container a moment before the database accepts connections.
	// jitter: none — at most 3 instances and 1 job each open one connection at start; no class-shaped crowd [site server/internal/db/db.go:99]
	var pingErr error
	for attempt := 1; attempt <= 5; attempt++ {
		pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		pingErr = pool.Ping(pingCtx)
		cancel()
		if pingErr == nil {
			break
		}
		logger.Warn("database not reachable yet", "attempt", attempt, "error", pingErr.Error())
		if attempt == 5 {
			break // no wait after the last attempt
		}
		select {
		case <-ctx.Done():
			closeAll()
			return nil, nil, ctx.Err()
		// jitter: none — linear 2/4/6/8 s startup waits; only up to 3 instances and 1 job dial at start
		case <-time.After(time.Duration(attempt) * 2 * time.Second):
		}
	}
	if pingErr != nil {
		closeAll()
		return nil, nil, fmt.Errorf("database ping: %w", pingErr)
	}
	return pool, closeAll, nil
}

// tune sets the pool's size, lifetimes and cancellation handling. It dials nothing, so it is
// tested without a database (TestTune).
func tune(cfg *pgxpool.Config, poolMax int32) {
	// jitter: none — queuing at the pool is correct, and coalesced cache fills remove the duplicate work [site server/internal/db/db.go:78]
	cfg.MaxConns = poolMax
	// Two warm connections absorb the first queries of a bell without a dial through the connector.
	cfg.MinConns = 1
	cfg.MinIdleConns = min(2, poolMax)
	// Connections opened together at the bell would all reach 30 min together and re-dial in one
	// health-check pass in the middle of a lesson; pgx adds whole_seconds(U[0, 5 min)) to each
	// one's lifetime, which spreads them over five passes. pgx truncates the jitter to whole
	// seconds, so it must stay at 1 s or more.
	// jitter: library pgxpool MaxConnLifetime 30 min + MaxConnLifetimeJitter U[0,5 min) whole seconds [site server/internal/db/db.go:80]
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnLifetimeJitter = 5 * time.Minute
	// jitter: none — idle connections close one by one after quiet periods; a cold pool at the bell is warmth, not phase [site server/internal/db/db.go:81]
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.HealthCheckPeriod = time.Minute
	cfg.PingTimeout = 2 * time.Second
	// jitter: none — re-dials happen on demand and are capped at MaxConns [site server/internal/db/db.go:83]
	cfg.ConnConfig.ConnectTimeout = 15 * time.Second
	// A cancelled statement (the client left) gets 2 s to finish before the socket deadline fires,
	// instead of breaking the connection at once: a class closing the app together would otherwise
	// make the pool re-dial every connection it has.
	cfg.ConnConfig.BuildContextWatcherHandler = func(pgConn *pgconn.PgConn) ctxwatch.Handler {
		return &pgconn.DeadlineContextWatcherHandler{Conn: pgConn.Conn(), DeadlineDelay: cancelGrace}
	}
}

// cancelGrace is how long a cancelled statement or transaction keeps its connection to finish
// cleanly (not a jitter: it decides whether the connection survives, not when anyone retries).
const cancelGrace = 2 * time.Second

var sqlcName = regexp.MustCompile(`^--\s*name:\s*(\w+)`)

// SpanName names a query span: the sqlc query name when the statement carries one, otherwise its
// first keyword (never the whole statement: spans stay short and free of literals).
func SpanName(stmt string) string {
	if m := sqlcName.FindStringSubmatch(stmt); m != nil {
		return m[1]
	}
	if fields := strings.Fields(stmt); len(fields) > 0 && !strings.HasPrefix(fields[0], "--") {
		return strings.ToUpper(fields[0])
	}
	return "query"
}

// Map turns driver errors the client should hear about into API errors; everything else is
// returned unchanged for the handler layer to log as a 500.
func Map(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return apierr.ErrMissing
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return apierr.ErrDuplicate
		case "23503":
			return apierr.ErrMissing
		}
	}
	return err
}

// Tx runs fn inside a transaction and commits when it returns nil. The rollback runs on a context
// that outlives a cancelled request: a rollback that fails on the cancelled context would close
// the connection instead of returning it to the pool.
func Tx(ctx context.Context, pool *pgxpool.Pool, fn func(tx pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		rollback, cancel := context.WithTimeout(context.WithoutCancel(ctx), cancelGrace)
		defer cancel()
		_ = tx.Rollback(rollback)
	}()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// LockUser serialises the caller's writes for one account for the rest of the transaction.
func LockUser(ctx context.Context, tx pgx.Tx, userID string) error {
	_, err := tx.Exec(ctx, `SELECT id FROM "User" WHERE id = $1 FOR UPDATE`, userID)
	return err
}
