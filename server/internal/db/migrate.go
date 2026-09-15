package db

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// VersionTable keeps goose's bookkeeping out of the public schema, so schema comparisons against
// the Prisma mirror only see application tables.
const VersionTable = "ops.goose_db_version"

// Status is one migration's state.
type Status struct {
	Version int64  `json:"version"`
	Source  string `json:"source"`
	Applied bool   `json:"applied"`
}

func provider(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) (*goose.Provider, error) {
	if _, err := pool.Exec(ctx, "CREATE SCHEMA IF NOT EXISTS ops"); err != nil {
		return nil, fmt.Errorf("create ops schema: %w", err)
	}
	sub, err := fs.Sub(migrationFiles, "migrations")
	if err != nil {
		return nil, err
	}
	// One migrator at a time per database: a session-level advisory lock, waited for up to 5 minutes.
	// jitter: none — goose retries the lock every 5 s, but production has one migrator job (MIGRATE_ON_START off) [site server/internal/db/migrate.go:39]
	locker, err := lock.NewPostgresSessionLocker(lock.WithLockTimeout(5, 60))
	if err != nil {
		return nil, err
	}
	return goose.NewProvider(goose.DialectPostgres, stdlib.OpenDBFromPool(pool), sub,
		goose.WithTableName(VersionTable), goose.WithSessionLocker(locker), goose.WithSlog(logger))
}

// Migrate applies every pending migration and returns the versions it applied.
func Migrate(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) ([]int64, error) {
	p, err := provider(ctx, pool, logger)
	if err != nil {
		return nil, err
	}
	results, err := p.Up(ctx)
	if err != nil {
		return nil, err
	}
	applied := make([]int64, 0, len(results))
	for _, r := range results {
		applied = append(applied, r.Source.Version)
	}
	return applied, nil
}

// MigrateTo applies pending migrations up to and including version.
func MigrateTo(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger, version int64) ([]int64, error) {
	p, err := provider(ctx, pool, logger)
	if err != nil {
		return nil, err
	}
	results, err := p.UpTo(ctx, version)
	if err != nil {
		return nil, err
	}
	applied := make([]int64, 0, len(results))
	for _, r := range results {
		applied = append(applied, r.Source.Version)
	}
	return applied, nil
}

// Statuses lists every embedded migration with whether it has been applied.
func Statuses(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) ([]Status, error) {
	p, err := provider(ctx, pool, logger)
	if err != nil {
		return nil, err
	}
	statuses, err := p.Status(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Status, 0, len(statuses))
	for _, s := range statuses {
		out = append(out, Status{Version: s.Source.Version, Source: s.Source.Path, Applied: s.State == goose.StateApplied})
	}
	return out, nil
}

// Baseline records that a database created by the previous (Prisma-managed) server already holds
// the schema of migrations up to and including version, without running them.
func Baseline(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger, version int64) error {
	p, err := provider(ctx, pool, logger)
	if err != nil {
		return err
	}
	current, err := p.GetDBVersion(ctx) // creates the version table when missing
	if err != nil {
		return err
	}
	if current >= version {
		return fmt.Errorf("database is already at version %d", current)
	}
	var users int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'User'`).Scan(&users); err != nil {
		return err
	}
	if users == 0 {
		return fmt.Errorf("no existing schema to baseline; run migrate up instead")
	}
	for _, src := range p.ListSources() {
		if src.Version <= current || src.Version > version {
			continue
		}
		if _, err := pool.Exec(ctx, fmt.Sprintf(`INSERT INTO %s (version_id, is_applied) VALUES ($1, true)`, VersionTable), src.Version); err != nil {
			return err
		}
	}
	return nil
}
