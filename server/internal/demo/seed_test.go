package demo

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"memoryz/server/internal/db"
	"memoryz/server/internal/testenv"
)

func TestSeedIsCompleteAndIdempotent(t *testing.T) {
	ctx := context.Background()
	scratch := testenv.Scratch(t, testenv.DatabaseURL(t))
	pool := testenv.Pool(t, scratch)
	if _, err := db.Migrate(ctx, pool, slog.Default()); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 15, 23, 30, 0, 0, time.UTC) // 08:30 next day in Seoul
	if err := Seed(ctx, pool, now); err != nil {
		t.Fatal(err)
	}
	counts := func() map[string]int {
		out := map[string]int{}
		for _, table := range []string{"User", "ParentLink", "School", "Subject", "Material", "Question", "Essay", "Card", "Schedule", "Post", "Comment", "Cheer", "Notification"} {
			var n int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM "`+table+`"`).Scan(&n); err != nil {
				t.Fatal(err)
			}
			out[table] = n
		}
		return out
	}
	first := counts()
	want := map[string]int{"User": 6, "ParentLink": 1, "School": 5, "Subject": 4, "Material": 4, "Question": 5, "Essay": 2, "Card": 12, "Schedule": 3, "Post": 4, "Comment": 1, "Cheer": 1, "Notification": 1}
	for table, n := range want {
		if first[table] != n {
			t.Fatalf("%s: %d rows, want %d", table, first[table], n)
		}
	}
	var date string
	if err := pool.QueryRow(ctx, `SELECT "date" FROM "Schedule" LIMIT 1`).Scan(&date); err != nil {
		t.Fatal(err)
	}
	if date != "2026-09-16" {
		t.Fatalf("schedules use the Seoul date: %s", date)
	}
	var mastered int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM "Card" WHERE "bucket" = 'MASTERED' AND "consecutiveEasy" = 2`).Scan(&mastered); err != nil {
		t.Fatal(err)
	}
	if mastered != 2 {
		t.Fatalf("mastered cards: %d", mastered)
	}
	if err := Seed(ctx, pool, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if second := counts(); second["User"] != first["User"] || second["Card"] != first["Card"] || second["Comment"] != first["Comment"] {
		t.Fatalf("second seed changed rows: %v vs %v", second, first)
	}
}
