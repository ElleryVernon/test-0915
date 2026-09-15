// Package testenv gives integration tests the dedicated local database and throwaway copies of it.
// Anything but the loopback development server is refused, so a misconfigured shell can never run
// tests against real data.
package testenv

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"memoryz/server/internal/ids"
)

// DatabaseURL returns DATABASE_URL from the environment or the repository's .env, after checking
// it points at 127.0.0.1:15444/memoryz.
func DatabaseURL(t testing.TB) string {
	t.Helper()
	raw := os.Getenv("DATABASE_URL")
	if raw == "" {
		raw = fromDotEnv()
	}
	if raw == "" {
		t.Fatal("DATABASE_URL is not set and no .env with it was found above the package directory")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || u.Port() != "15444" || u.Path != "/memoryz" {
		t.Fatalf("tests run only against the dedicated local database 127.0.0.1:15444/memoryz, not %q", raw)
	}
	return raw
}

func fromDotEnv() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for {
		data, err := os.ReadFile(filepath.Join(dir, ".env"))
		if err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				if value, ok := strings.CutPrefix(strings.TrimSpace(line), "DATABASE_URL="); ok {
					return strings.Trim(strings.TrimSpace(value), `"'`)
				}
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// Pool connects to rawURL for the test's lifetime.
func Pool(t testing.TB, rawURL string) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), rawURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// Scratch creates an empty database on the same server and drops it when the test ends.
func Scratch(t testing.TB, baseURL string) string {
	t.Helper()
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, baseURL)
	if err != nil {
		t.Fatal(err)
	}
	name := "memoryz_test_" + strings.ReplaceAll(ids.New()[:13], "-", "")
	if _, err := admin.Exec(ctx, fmt.Sprintf(`CREATE DATABASE %s`, pgx.Identifier{name}.Sanitize())); err != nil {
		_ = admin.Close(ctx)
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(ctx, fmt.Sprintf(`DROP DATABASE IF EXISTS %s WITH (FORCE)`, pgx.Identifier{name}.Sanitize()))
		_ = admin.Close(ctx)
	})
	u, _ := url.Parse(baseURL)
	u.Path = "/" + name
	return u.String()
}
