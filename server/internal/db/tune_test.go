package db

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"memoryz/server/internal/testenv"
)

func tunedConfig(t *testing.T, poolMax int32) *pgxpool.Config {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(testenv.DatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	tune(cfg, poolMax)
	return cfg
}

func openTuned(t *testing.T, cfg *pgxpool.Config) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// TestTune: the production pool settings, and on a live connection the cancellation handler that
// lets a statement finish for 2 s instead of breaking the connection.
func TestTune(t *testing.T) {
	cfg := tunedConfig(t, 6)
	if cfg.MaxConns != 6 || cfg.MinConns != 1 || cfg.MinIdleConns != 2 || cfg.MaxConnLifetime != 30*time.Minute || cfg.MaxConnLifetimeJitter != 5*time.Minute ||
		cfg.PingTimeout != 2*time.Second || cfg.HealthCheckPeriod != time.Minute || cfg.MaxConnIdleTime != 5*time.Minute {
		t.Fatalf("pool settings: %+v", cfg)
	}
	pool := openTuned(t, cfg)
	conn, err := pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	handler, ok := cfg.ConnConfig.BuildContextWatcherHandler(conn.Conn().PgConn()).(*pgconn.DeadlineContextWatcherHandler)
	if !ok || handler.DeadlineDelay != 2*time.Second || handler.Conn == nil {
		t.Fatalf("watcher handler: %#v", handler)
	}
}

// TestTuneLifetimeSpreads: six connections opened together close over several seconds with a
// lifetime jitter, and all at once without it (pgx draws whole seconds per connection).
func TestTuneLifetimeSpreads(t *testing.T) {
	if testing.Short() {
		t.Skip("takes about 15 s")
	}
	closings := func(jitter time.Duration) []time.Time {
		cfg := tunedConfig(t, 6)
		cfg.MinConns, cfg.MinIdleConns = 0, 0
		cfg.MaxConnLifetime = time.Second
		cfg.MaxConnLifetimeJitter = jitter
		cfg.HealthCheckPeriod = 250 * time.Millisecond
		var mu sync.Mutex
		var closed []time.Time
		cfg.BeforeClose = func(*pgx.Conn) { mu.Lock(); closed = append(closed, time.Now()); mu.Unlock() }
		pool := openTuned(t, cfg)
		conns := make([]*pgxpool.Conn, 6)
		for i := range conns {
			c, err := pool.Acquire(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			conns[i] = c
		}
		for _, c := range conns {
			c.Release()
		}
		deadline := time.Now().Add(13 * time.Second)
		for time.Now().Before(deadline) {
			mu.Lock()
			n := len(closed)
			mu.Unlock()
			if n == 6 {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		mu.Lock()
		defer mu.Unlock()
		if len(closed) != 6 {
			t.Fatalf("all six connections reach their lifetime within 13 s: %d closed", len(closed))
		}
		return append([]time.Time(nil), closed...)
	}
	spread := closings(10 * time.Second)
	first := spread[0]
	buckets := map[int64]bool{}
	for _, at := range spread {
		if at.Before(first) {
			first = at
		}
	}
	for _, at := range spread {
		buckets[int64(at.Sub(first)/time.Second)] = true
	}
	if len(buckets) < 2 {
		t.Fatalf("with a 10 s jitter the closings fall into %d one-second buckets", len(buckets))
	}
	together := closings(0)
	lo, hi := together[0], together[0]
	for _, at := range together {
		if at.Before(lo) {
			lo = at
		}
		if at.After(hi) {
			hi = at
		}
	}
	if hi.Sub(lo) > 500*time.Millisecond {
		t.Fatalf("without jitter they close together, within %v", hi.Sub(lo))
	}
}

// TestTuneCanceledQueryKeepsConn: a statement whose request is cancelled mid-flight finishes
// within the grace and the connection stays in the pool (no re-dial).
func TestTuneCanceledQueryKeepsConn(t *testing.T) {
	cfg := tunedConfig(t, 1)
	pool := openTuned(t, cfg)
	if err := pool.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	before := pool.Stat().NewConnsCount()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, _ = pool.Exec(ctx, `SELECT pg_sleep(0.3)`)
	if err := pool.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	if st := pool.Stat(); st.TotalConns() != 1 || st.NewConnsCount() != before {
		t.Fatalf("the connection survived the cancel: total=%d new=%d (before %d)", st.TotalConns(), st.NewConnsCount(), before)
	}
}

// TestTuneCanceledTxKeepsConn: a transaction whose request is cancelled between two statements
// rolls back on a detached context and keeps its connection.
func TestTuneCanceledTxKeepsConn(t *testing.T) {
	cfg := tunedConfig(t, 1)
	pool := openTuned(t, cfg)
	if err := pool.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	before := pool.Stat().NewConnsCount()
	ctx, cancel := context.WithCancel(context.Background())
	err := Tx(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1`); err != nil {
			return err
		}
		cancel() // the client left between two statements
		_, err := tx.Exec(ctx, `SELECT 2`)
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("the second statement sees the cancel: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	if st := pool.Stat(); st.TotalConns() != 1 || st.NewConnsCount() != before {
		t.Fatalf("the rollback kept the connection: total=%d new=%d (before %d)", st.TotalConns(), st.NewConnsCount(), before)
	}
}
