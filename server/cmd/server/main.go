// Command server runs the Memoryz API (and, when STATIC_DIR is set, the web build) or manages the
// database schema: `server serve` (default), `server migrate up|status|baseline <version>`.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	_ "net/http/pprof"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
	_ "time/tzdata" // Asia/Seoul dates must work inside a minimal container image

	"github.com/jackc/pgx/v5/pgxpool"

	"memoryz/server/internal/ai"
	"memoryz/server/internal/app"
	"memoryz/server/internal/blob"
	"memoryz/server/internal/cache"
	"memoryz/server/internal/config"
	"memoryz/server/internal/db"
	"memoryz/server/internal/demo"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/logx"
	"memoryz/server/internal/store"
	"memoryz/server/internal/sweep"
	"memoryz/server/internal/telemetry"
)

// version is set at build time with -ldflags "-X main.version=…".
var version = "dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "server:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	cmd := "serve"
	if len(args) > 0 {
		cmd = args[0]
	}
	switch cmd {
	case "version":
		fmt.Println(version)
		return nil
	case "help", "-h", "--help":
		fmt.Println("usage: server [serve | migrate up [version] | migrate status | migrate baseline <version> | seed-demo | sweep | verify-provider [--out <file>] | version]")
		return nil
	}
	cfg, err := config.Load(os.LookupEnv)
	if err != nil {
		return err
	}
	logger := logx.New(cfg.LogLevel, cfg.LogFormat == "json")
	slog.SetDefault(logger)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	switch cmd {
	case "serve":
		return serve(ctx, cfg, logger)
	case "migrate":
		return migrate(ctx, cfg, logger, args[1:])
	case "sweep":
		return sweepOnce(ctx, cfg, logger)
	case "verify-provider":
		return verifyProvider(ctx, cfg, logger, args[1:])
	case "seed-demo":
		if !cfg.DemoMode {
			return errors.New("seed-demo requires DEMO_MODE=true")
		}
		pool, closeDB, err := connect(ctx, cfg, logger)
		if err != nil {
			return err
		}
		defer closeDB()
		if err := demo.Seed(ctx, pool, time.Now().UTC()); err != nil {
			return err
		}
		fmt.Println("DEMO_SEED_OK")
		return nil
	}
	return fmt.Errorf("unknown command %q", cmd)
}

// verifyProvider is the billable provider check (one model call per skill); the report goes to
// .data/openrouter-verification.json unless --out says otherwise. Secrets are never printed.
func verifyProvider(ctx context.Context, cfg *config.Config, logger *slog.Logger, args []string) error {
	out := filepath.Join(".data", "openrouter-verification.json")
	for i := 0; i < len(args); i++ {
		if args[i] == "--out" && i+1 < len(args) {
			out = args[i+1]
			i++
		}
	}
	provider := ai.NewProvider(cfg, cfg.OpenRouterBaseURL, logger)
	// jitter: none — an operator runs this billable check by hand; it is not on the serving path [site server/cmd/server/main.go:107]
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	report, verr := ai.VerifyProvider(ctx, provider, cfg.OpenRouterEffort, cfg.OpenRouterProviderOrder)
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(out, append(encoded, '\n'), 0o644); err != nil {
		return err
	}
	if verr != nil {
		fmt.Printf("OPENROUTER_VERIFICATION_FAILED %s\n", verr)
		return verr
	}
	line, _ := json.Marshal(report)
	fmt.Printf("OPENROUTER_VERIFIED %s\n", line)
	return nil
}

func connect(ctx context.Context, cfg *config.Config, logger *slog.Logger) (*pgxpool.Pool, func(), error) {
	return db.Connect(ctx, db.Options{
		URL: cfg.DatabaseURL, Instance: cfg.DBInstance, User: cfg.DBUser, Name: cfg.DBName, Password: cfg.DBPassword,
		IAMAuth: cfg.DBIAMAuth, IPType: cfg.DBIPType, PoolMax: cfg.DBPoolMax,
	}, logger)
}

func serve(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	for _, w := range cfg.Warnings {
		logger.Warn(w)
	}
	logger.Info("config", slog.Any("config", cfg.Redacted()), slog.String("version", version))
	// Telemetry first: the pool's query tracer and the HTTP spans bind to the global providers.
	providers, err := telemetry.Setup(ctx, telemetry.Options{
		Exporter: cfg.OTelExporter, Project: cfg.GoogleProject, SampleRatio: cfg.OTelSampleRatio,
		ServiceName: "memoryz-server", Version: version, Writer: os.Stdout,
	})
	if err != nil {
		return err
	}
	defer func() {
		// jitter: none — runs once per instance; the flush fits the 10 s SIGTERM budget after the HTTP drain and the bounded closers [site server/cmd/server/main.go:150]
		flushCtx, cancel := context.WithTimeout(context.Background(), httpx.FlushGrace)
		defer cancel()
		if err := providers.Shutdown(flushCtx); err != nil {
			logger.Warn("telemetry shutdown", slog.String("error", err.Error()))
		}
	}()
	// The stores close before the flush, within httpx.CloseGrace: the pool's Close waits for every
	// connection still checked out (a detached cache fill can hold one for 12 s), and an unbounded
	// wait here would push the flush past Cloud Run's kill.
	var closers []func()
	defer func() { closeWithin(httpx.CloseGrace, closers, logger) }()
	pool, closeDB, err := connect(ctx, cfg, logger)
	if err != nil {
		return err
	}
	closers = append(closers, closeDB)
	if err := telemetry.ObservePool(pool); err != nil {
		return fmt.Errorf("pool metrics: %w", err)
	}
	if cfg.MigrateOnStart {
		applied, err := db.Migrate(ctx, pool, logger)
		if err != nil {
			return fmt.Errorf("migrate: %w", err)
		}
		logger.Info("migrations applied", slog.Any("versions", applied))
	}
	var blobs blob.Store
	if cfg.BlobStore == "gcs" {
		gcs, err := blob.NewGCS(ctx, cfg.GCSBucket)
		if err != nil {
			return err
		}
		closers = append(closers, func() { _ = gcs.Close() })
		blobs = gcs
	} else {
		blobs = blob.NewPG(pool)
	}
	var store cache.Cache
	if cfg.ValkeyAddr != "" {
		valkey, err := cache.NewValkey(ctx, cache.ValkeyOptions{
			Addr: cfg.ValkeyAddr, IAM: cfg.ValkeyIAMAuth, CAPEM: cfg.ValkeyCAPEM, ServerName: cfg.ValkeyTLSServerName,
			Username: cfg.ValkeyUsername, Password: cfg.ValkeyPassword,
		})
		if err != nil {
			return err
		}
		store = valkey
	} else {
		store = cache.NewMemory()
	}
	closers = append(closers, func() { _ = store.Close() })
	logger.Info("storage", slog.String("blobs", blobs.Name()), slog.String("cache", store.Name()))
	if cfg.PprofAddr != "" {
		// Profiling stays on loopback only; Cloud Run never exposes it.
		go func() {
			logger.Info("pprof", slog.String("addr", cfg.PprofAddr))
			if err := http.ListenAndServe(cfg.PprofAddr, nil); err != nil {
				logger.Warn("pprof stopped", slog.String("error", err.Error()))
			}
		}()
	}
	handler, drain := app.New(app.Deps{Cfg: cfg, Pool: pool, Log: logger, Blobs: blobs, Cache: store})
	return httpx.Serve(ctx, net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)), handler, logger, drain)
}

// closeWithin runs closers last-opened first and returns once they finish or after d, whichever is
// sooner; a closer still waiting (the pool, on a connection a request holds) is abandoned to the exit.
func closeWithin(d time.Duration, closers []func(), logger *slog.Logger) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := len(closers) - 1; i >= 0; i-- {
			closers[i]()
		}
	}()
	// jitter: none — a bound on one instance's own exit (CloseGrace), not a retry
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		logger.Warn("closing timed out; exiting without waiting", slog.Duration("after", d))
	}
}

// sweepOnce is the daily cleanup job (Cloud Run job + Cloud Scheduler): abandoned uploads and orphan objects.
func sweepOnce(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	// jitter: none — one scheduled job a day (04:00 KST) through db.Connect's startup ping loop [site server/cmd/server/main.go:212]
	pool, closeDB, err := connect(ctx, cfg, logger)
	if err != nil {
		return err
	}
	defer closeDB()
	var blobs blob.Store
	if cfg.BlobStore == "gcs" {
		gcs, err := blob.NewGCS(ctx, cfg.GCSBucket)
		if err != nil {
			return err
		}
		defer gcs.Close()
		blobs = gcs
	} else {
		blobs = blob.NewPG(pool)
	}
	report, err := sweep.Run(ctx, store.New(pool), blobs, time.Now().UTC(), sweep.TTL, logger)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(report)
}

func migrate(ctx context.Context, cfg *config.Config, logger *slog.Logger, args []string) error {
	if len(args) == 0 {
		return errors.New("usage: server migrate up [version] | status | baseline <version>")
	}
	pool, closeDB, err := connect(ctx, cfg, logger)
	if err != nil {
		return err
	}
	defer closeDB()
	out := json.NewEncoder(os.Stdout)
	switch args[0] {
	case "up":
		var applied []int64
		if len(args) > 1 {
			target, err := strconv.ParseInt(args[1], 10, 64)
			if err != nil {
				return fmt.Errorf("version: %w", err)
			}
			applied, err = db.MigrateTo(ctx, pool, logger, target)
			if err != nil {
				return err
			}
		} else if applied, err = db.Migrate(ctx, pool, logger); err != nil {
			return err
		}
		if applied == nil {
			applied = []int64{}
		}
		return out.Encode(map[string]any{"applied": applied})
	case "status":
		statuses, err := db.Statuses(ctx, pool, logger)
		if err != nil {
			return err
		}
		var current int64
		pending := 0
		for _, s := range statuses {
			if s.Applied && s.Version > current {
				current = s.Version
			}
			if !s.Applied {
				pending++
			}
		}
		return out.Encode(map[string]any{"current": current, "pending": pending, "migrations": statuses})
	case "baseline":
		if len(args) < 2 {
			return errors.New("usage: server migrate baseline <version>")
		}
		target, err := strconv.ParseInt(args[1], 10, 64)
		if err != nil {
			return fmt.Errorf("version: %w", err)
		}
		if err := db.Baseline(ctx, pool, logger, target); err != nil {
			return err
		}
		return out.Encode(map[string]any{"baseline": target})
	}
	return fmt.Errorf("unknown migrate command %q", args[0])
}
