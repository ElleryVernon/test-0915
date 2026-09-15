package sweep

import (
	"context"
	"fmt"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"memoryz/server/internal/blob"
	"memoryz/server/internal/db"
	"memoryz/server/internal/store"
	"memoryz/server/internal/testenv"
)

// TestSweep: an abandoned upload (two days old, no material) loses its rows and objects; a fresh
// unattached upload, an attached upload and an upload named by a card image stay; an object with
// no upload row at all is removed; a second run is a no-op.
func TestSweep(t *testing.T) {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, testenv.Scratch(t, testenv.DatabaseURL(t)))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := db.Migrate(ctx, pool, slog.Default()); err != nil {
		t.Fatal(err)
	}
	q := store.New(pool)
	blobs := blob.NewPG(pool)
	now := time.Now().UTC()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	exec(`INSERT INTO "User" ("id", "name", "nickname", "role") VALUES ('u1', 'u1', 'u1', 'STUDENT')`)
	exec(`INSERT INTO "Subject" ("id", "userId", "name") VALUES ('s1', 'u1', '과목')`)
	upload := func(id string, age time.Duration) {
		exec(`INSERT INTO "Upload" ("id", "userId", "mime", "name", "size", "createdAt") VALUES ($1, 'u1', 'application/pdf', $1, 3, $2)`, id, now.Add(-age))
		if err := blobs.Put(ctx, blob.UploadKey(id), "application/pdf", []byte("pdf")); err != nil {
			t.Fatal(err)
		}
	}
	upload("abandoned", 48*time.Hour)
	exec(`INSERT INTO "UploadImage" ("id", "uploadId", "page", "order", "paragraph", "anchor", "x", "y", "w", "h", "width", "height", "mime", "context") VALUES ('img1', 'abandoned', 1, 0, 0, 0, 0, 0, 1, 1, 10, 10, 'image/webp', '')`)
	if err := blobs.Put(ctx, blob.ImageKey("abandoned", "img1"), "image/webp", []byte("img")); err != nil {
		t.Fatal(err)
	}
	upload("fresh", time.Hour)
	upload("attached", 72*time.Hour)
	exec(`INSERT INTO "Material" ("id", "userId", "subjectId", "title", "content", "type", "uploadId", "url") VALUES ('m1', 'u1', 's1', '자료', '본문', 'PDF', 'attached', '/api/uploads/attached')`)
	upload("cardimage", 72*time.Hour)
	exec(`INSERT INTO "Card" ("id", "userId", "subjectId", "front", "back", "type", "image") VALUES ('c1', 'u1', 's1', '앞', '뒤', 'BLIND', '/api/uploads/cardimage')`)
	if err := blobs.Put(ctx, blob.UploadKey("ghost"), "application/pdf", []byte("orphan")); err != nil {
		t.Fatal(err)
	}
	if err := blobs.Put(ctx, blob.ImageKey("ghost", "g1"), "image/webp", []byte("orphan")); err != nil {
		t.Fatal(err)
	}

	report, err := Run(ctx, q, blobs, now, TTL, slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	if report.UploadsDeleted != 1 || report.ImagesDeleted != 1 || report.BlobsDeleted != 2 || report.OrphansDeleted != 2 || report.Kept != 3 {
		t.Fatalf("report: %+v", report)
	}
	exists := func(key string) bool {
		obj, err := blobs.Get(ctx, key)
		if err == nil {
			obj.Close()
			return true
		}
		return false
	}
	for key, want := range map[string]bool{
		blob.UploadKey("abandoned"): false, blob.ImageKey("abandoned", "img1"): false,
		blob.UploadKey("fresh"): true, blob.UploadKey("attached"): true, blob.UploadKey("cardimage"): true,
		blob.UploadKey("ghost"): false, blob.ImageKey("ghost", "g1"): false,
	} {
		if exists(key) != want {
			t.Fatalf("object %s exists=%v want %v", key, !want, want)
		}
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM "Upload"`).Scan(&rows); err != nil || rows != 3 {
		t.Fatalf("upload rows: %d %v", rows, err)
	}
	again, err := Run(ctx, q, blobs, now, TTL, nil)
	if err != nil || again.UploadsDeleted != 0 || again.BlobsDeleted != 0 || again.OrphansDeleted != 0 {
		t.Fatalf("second run must be a no-op: %+v %v", again, err)
	}
	fmt.Println("SWEEP_TEST_OK")
}
