package db

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"memoryz/server/internal/testenv"
)

func TestTimestampsAreInstants(t *testing.T) {
	ctx := context.Background()
	pool, closePool, err := Connect(ctx, Options{URL: testenv.DatabaseURL(t), PoolMax: 2}, slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	defer closePool()
	seoul, err := time.LoadLocation("Asia/Seoul")
	if err != nil {
		t.Fatal(err)
	}
	local := time.Date(2026, 9, 15, 18, 30, 0, 123_000_000, seoul)
	var back time.Time
	if err := pool.QueryRow(ctx, `SELECT $1::timestamp`, local).Scan(&back); err != nil {
		t.Fatal(err)
	}
	if !back.Equal(local) {
		t.Fatalf("a Seoul time must round-trip as the same instant: sent %s, got %s", local.UTC(), back.UTC())
	}
	if back.Location() != time.UTC {
		t.Fatalf("timestamps read back in UTC, got %s", back.Location())
	}
	var viaPointer time.Time
	if err := pool.QueryRow(ctx, `SELECT $1::timestamp`, &local).Scan(&viaPointer); err != nil {
		t.Fatal(err)
	}
	if !viaPointer.Equal(local) {
		t.Fatalf("pointer round trip: %s vs %s", viaPointer.UTC(), local.UTC())
	}
}
