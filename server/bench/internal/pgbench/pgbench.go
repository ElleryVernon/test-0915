// Package pgbench provisions the throwaway benchmark database and removes it
// afterwards. It never names any database other than memoryz_bench.
//
// Preferred mode is a throwaway Docker Postgres. The fallback (only when the
// Docker daemon is unreachable, or when forced with ModeLocal) creates the
// database memoryz_bench on the local server named by DATABASE_URL in .env and
// drops it afterwards; the app's own database is never touched.
package pgbench

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"memoryz/bench/internal/app"
)

// DBName is the only database this package creates or drops.
const DBName = "memoryz_bench"

// Defaults for the Docker mode.
const (
	DefaultContainer = "memoryz-bench-pg"
	DefaultPort      = 15555
	dockerPassword   = "bench"
)

// DefaultImages are tried in order; the first that runs wins.
var DefaultImages = []string{"postgres:18-alpine", "postgres:17-alpine"}

// Mode selects how the database is provisioned.
type Mode string

// Modes.
const (
	ModeAuto   Mode = "auto"
	ModeDocker Mode = "docker"
	ModeLocal  Mode = "local"
)

// Options configure Start.
type Options struct {
	Mode      Mode
	Container string
	Port      int
	Images    []string
	EnvFile   string // .env with DATABASE_URL (local mode); "" searches upward from the working directory
	Logf      func(format string, args ...any)
}

// DB is a provisioned benchmark database.
type DB struct {
	Mode Mode
	// DSN carries credentials: hand it to child processes through the
	// environment and never print it.
	DSN string
	// Display is the printable description (no credentials).
	Display       string
	Image         string
	ServerVersion string
	// Commands are the exact provisioning commands and SQL statements run.
	Commands []string
	cleanup  func(context.Context) error
	cleaned  bool
}

// Start provisions and seeds the database.
func Start(ctx context.Context, o Options) (*DB, error) {
	if o.Container == "" {
		o.Container = DefaultContainer
	}
	if o.Port == 0 {
		o.Port = DefaultPort
	}
	if len(o.Images) == 0 {
		o.Images = DefaultImages
	}
	if o.Logf == nil {
		o.Logf = func(string, ...any) {}
	}
	switch o.Mode {
	case ModeDocker:
		return startDocker(ctx, o)
	case ModeLocal:
		return startLocal(ctx, o)
	case ModeAuto, "":
		// The native local server first: on macOS a Docker container's
		// published port goes through Docker Desktop's user-space proxy, which
		// made /db throughput erratic in trial runs (identical repeats of the
		// same server: 12,886 vs 2,102 req/s at c=256) while the native server
		// repeated within normal noise. Docker remains the fallback.
		t, err := localTarget(o)
		if err == nil {
			if err = waitReady(ctx, t.adminDSN, 3*time.Second); err == nil {
				return startLocal(ctx, o)
			}
		}
		o.Logf("local server not usable (%v); trying Docker", err)
		if derr := dockerAvailable(ctx); derr != nil {
			return nil, fmt.Errorf("no database available: local: %v; docker: %v", err, derr)
		}
		return startDocker(ctx, o)
	default:
		return nil, fmt.Errorf("unknown database mode %q", o.Mode)
	}
}

// Cleanup removes the container or drops memoryz_bench. It is idempotent.
func (d *DB) Cleanup(ctx context.Context) error {
	if d == nil || d.cleaned || d.cleanup == nil {
		return nil
	}
	d.cleaned = true
	return d.cleanup(ctx)
}

func dockerAvailable(ctx context.Context) error {
	out, err := exec.CommandContext(ctx, "docker", "version", "--format", "{{.Server.Version}}").CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker version: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func startDocker(ctx context.Context, o Options) (*DB, error) {
	if err := dockerAvailable(ctx); err != nil {
		return nil, err
	}
	// A container left behind by an interrupted run would block the name and port.
	_ = exec.CommandContext(ctx, "docker", "rm", "-f", o.Container).Run()

	var (
		image   string
		runCmd  string
		lastErr error
	)
	for _, img := range o.Images {
		args := []string{"run", "-d", "--rm", "--name", o.Container,
			"-e", "POSTGRES_PASSWORD=" + dockerPassword,
			"-p", fmt.Sprintf("127.0.0.1:%d:5432", o.Port), img}
		out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
		if err == nil {
			image, runCmd = img, "docker "+strings.Join(args, " ")
			break
		}
		lastErr = fmt.Errorf("docker run %s: %w: %s", img, err, strings.TrimSpace(string(out)))
		if !missingImage(string(out)) {
			return nil, lastErr
		}
		o.Logf("%v; trying the next image", lastErr)
	}
	if image == "" {
		return nil, lastErr
	}
	db := &DB{Mode: ModeDocker, Image: image, Commands: []string{runCmd}}
	db.cleanup = func(ctx context.Context) error {
		out, err := exec.CommandContext(ctx, "docker", "rm", "-f", o.Container).CombinedOutput()
		if err != nil {
			return fmt.Errorf("docker rm -f %s: %w: %s", o.Container, err, strings.TrimSpace(string(out)))
		}
		return nil
	}
	admin := fmt.Sprintf("postgres://postgres:%s@127.0.0.1:%d/postgres?sslmode=disable&connect_timeout=5", dockerPassword, o.Port)
	db.DSN = fmt.Sprintf("postgres://postgres:%s@127.0.0.1:%d/%s?sslmode=disable&connect_timeout=5", dockerPassword, o.Port, DBName)
	db.Display = fmt.Sprintf("throwaway Docker container %s (%s) on 127.0.0.1:%d, database %s; the container is removed after the run",
		o.Container, image, o.Port, DBName)
	if err := waitReady(ctx, admin, 90*time.Second); err != nil {
		_ = db.Cleanup(context.Background())
		return nil, err
	}
	if err := createAndSeed(ctx, admin, db); err != nil {
		_ = db.Cleanup(context.Background())
		return nil, err
	}
	return db, nil
}

func missingImage(out string) bool {
	out = strings.ToLower(out)
	return strings.Contains(out, "manifest unknown") || strings.Contains(out, "not found") ||
		strings.Contains(out, "manifest for") || strings.Contains(out, "pull access denied")
}

// target is the local server named by DATABASE_URL, with the admin and
// benchmark connection strings derived from it (same host and credentials,
// different database).
type target struct {
	envPath  string
	host     string
	adminDSN string
	benchDSN string
}

func localTarget(o Options) (target, error) {
	envPath := o.EnvFile
	if envPath == "" {
		p, err := findUp(".env")
		if err != nil {
			return target{}, err
		}
		envPath = p
	}
	raw, err := readDatabaseURL(envPath)
	if err != nil {
		return target{}, err
	}
	u, err := url.Parse(raw)
	if err != nil {
		return target{}, fmt.Errorf("DATABASE_URL in %s does not parse: %w", envPath, err)
	}
	admin := *u
	admin.Path = "/postgres"
	bench := *u
	bench.Path = "/" + DBName
	return target{envPath: envPath, host: u.Host, adminDSN: admin.String(), benchDSN: bench.String()}, nil
}

func startLocal(ctx context.Context, o Options) (*DB, error) {
	t, err := localTarget(o)
	if err != nil {
		return nil, err
	}
	db := &DB{Mode: ModeLocal, DSN: t.benchDSN}
	db.Display = fmt.Sprintf("local native PostgreSQL at %s (credentials from %s), throwaway database %s created for this run and dropped afterwards; the app database was not touched",
		t.host, t.envPath, DBName)
	adminDSN := t.adminDSN
	db.cleanup = func(ctx context.Context) error {
		conn, err := pgx.Connect(ctx, adminDSN)
		if err != nil {
			return fmt.Errorf("connect to drop %s: %w", DBName, err)
		}
		defer conn.Close(ctx)
		if _, err := conn.Exec(ctx, "DROP DATABASE IF EXISTS "+DBName+" WITH (FORCE)"); err != nil {
			return fmt.Errorf("drop %s: %w", DBName, err)
		}
		var n int
		if err := conn.QueryRow(ctx, "SELECT count(*) FROM pg_database WHERE datname=$1", DBName).Scan(&n); err != nil {
			return err
		}
		if n != 0 {
			return fmt.Errorf("%s still exists after DROP DATABASE", DBName)
		}
		return nil
	}
	if err := waitReady(ctx, adminDSN, 10*time.Second); err != nil {
		return nil, err
	}
	if err := createAndSeed(ctx, adminDSN, db); err != nil {
		_ = db.Cleanup(context.Background())
		return nil, err
	}
	return db, nil
}

func waitReady(ctx context.Context, dsn string, max time.Duration) error {
	deadline := time.Now().Add(max)
	var last error
	for {
		conn, err := pgx.Connect(ctx, dsn)
		if err == nil {
			var one int
			err = conn.QueryRow(ctx, "SELECT 1").Scan(&one)
			_ = conn.Close(ctx)
			if err == nil {
				return nil
			}
		}
		last = err
		if time.Now().After(deadline) {
			return fmt.Errorf("postgres not ready after %s: %w", max, last)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		// jitter: none — development tooling: one harness polls its own Postgres every 500 ms [site server/bench/internal/pgbench/pgbench.go:285]
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func createAndSeed(ctx context.Context, adminDSN string, db *DB) error {
	conn, err := pgx.Connect(ctx, adminDSN)
	if err != nil {
		return fmt.Errorf("connect (admin): %w", err)
	}
	if err := conn.QueryRow(ctx, "SELECT version()").Scan(&db.ServerVersion); err != nil {
		_ = conn.Close(ctx)
		return err
	}
	for _, stmt := range []string{
		"DROP DATABASE IF EXISTS " + DBName + " WITH (FORCE)",
		"CREATE DATABASE " + DBName,
	} {
		if _, err := conn.Exec(ctx, stmt); err != nil {
			_ = conn.Close(ctx)
			return fmt.Errorf("%s: %w", stmt, err)
		}
		db.Commands = append(db.Commands, stmt)
	}
	_ = conn.Close(ctx)

	bconn, err := pgx.Connect(ctx, db.DSN)
	if err != nil {
		return fmt.Errorf("connect (%s): %w", DBName, err)
	}
	defer bconn.Close(ctx)
	for _, stmt := range app.SeedSQL {
		if _, err := bconn.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("%s: %w", stmt, err)
		}
		db.Commands = append(db.Commands, stmt)
	}
	var n int
	if err := bconn.QueryRow(ctx, "SELECT count(*) FROM bench").Scan(&n); err != nil {
		return err
	}
	if n != app.SeedRows {
		return fmt.Errorf("seeded %d rows, want %d", n, app.SeedRows)
	}
	var row app.Row
	if err := bconn.QueryRow(ctx, app.LookupSQL, app.SeedRows).Scan(&row.ID, &row.Name, &row.Score); err != nil {
		return err
	}
	if row.Name != app.SeedName(app.SeedRows) || row.Score != app.SeedScore(app.SeedRows) {
		return fmt.Errorf("seed mismatch for id %d: %+v", app.SeedRows, row)
	}
	return warm(ctx, db)
}

// WarmConns × WarmQueries lookups are run right after seeding so the first
// measured candidate does not pay for cold buffers, catalog caches and the
// post-insert autovacuum of the new table.
const (
	WarmConns   = app.PoolMaxConns
	WarmQueries = 1000
)

func warm(ctx context.Context, db *DB) error {
	pool, err := app.NewPool(ctx, db.DSN)
	if err != nil {
		return fmt.Errorf("warm-up pool: %w", err)
	}
	defer pool.Close()
	store := app.NewStore(pool)
	errs := make(chan error, WarmConns)
	for w := 0; w < WarmConns; w++ {
		go func(w int) {
			for i := 0; i < WarmQueries; i++ {
				id := (w*WarmQueries+i*7919)%app.SeedRows + 1
				if _, err := store.Lookup(ctx, id); err != nil {
					errs <- err
					return
				}
			}
			errs <- nil
		}(w)
	}
	for w := 0; w < WarmConns; w++ {
		if err := <-errs; err != nil {
			return fmt.Errorf("warm-up query: %w", err)
		}
	}
	db.Commands = append(db.Commands, fmt.Sprintf("-- warm-up: %d connections x %d lookups (%s)", WarmConns, WarmQueries, app.LookupSQL))
	return nil
}

var databaseURLLine = regexp.MustCompile(`^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.+?)\s*$`)

func readDatabaseURL(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		m := databaseURLLine.FindStringSubmatch(sc.Text())
		if m == nil {
			continue
		}
		v := m[1]
		if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
			v = v[1 : len(v)-1]
		}
		return v, nil
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	return "", errors.New("DATABASE_URL not found in " + path)
}

func findUp(name string) (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		p := filepath.Join(dir, name)
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("%s not found in the working directory or any parent", name)
		}
		dir = parent
	}
}
