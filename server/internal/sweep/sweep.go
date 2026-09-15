// Package sweep is the daily cleanup job: uploads that were never attached to a material (a sheet
// abandoned after choosing a file) and objects in the blob store whose upload row is gone. The
// request path keeps a per-user variant (api.collectUnlinked); this one runs across every user and
// also reconciles storage, so a crash between "delete row" and "delete bytes" cannot leak forever.
package sweep

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"memoryz/server/internal/blob"
	"memoryz/server/internal/store"
)

// TTL is how long an unattached upload may wait for its material before it is considered abandoned.
// jitter: none — a cutoff one daily job reads; an expiry sends no request
const TTL = 24 * time.Hour

// Report is what a run did.
type Report struct {
	Cutoff         time.Time `json:"cutoff"`
	UploadsDeleted int       `json:"uploadsDeleted"`
	ImagesDeleted  int64     `json:"imagesDeleted"`
	BlobsDeleted   int       `json:"blobsDeleted"` // objects of the deleted uploads (file + images)
	OrphansDeleted int       `json:"orphanBlobsDeleted"`
	Kept           int       `json:"uploadsKept"`
}

// Run removes abandoned uploads (rows, image rows, objects) and orphan objects.
func Run(ctx context.Context, q *store.Queries, blobs blob.Store, now time.Time, ttl time.Duration, log *slog.Logger) (Report, error) {
	report := Report{Cutoff: now.Add(-ttl).UTC()}
	stale, err := q.ListSweepableUploads(ctx, report.Cutoff)
	if err != nil {
		return report, fmt.Errorf("list sweepable uploads: %w", err)
	}
	for _, id := range stale {
		// Bytes first: a failure here leaves the row, so the next run tries again.
		removed, err := deleteObjects(ctx, blobs, id)
		if err != nil {
			return report, fmt.Errorf("delete objects of upload %s: %w", id, err)
		}
		report.BlobsDeleted += removed
	}
	if len(stale) > 0 {
		images, err := q.DeleteUploadImagesByUpload(ctx, stale)
		if err != nil {
			return report, fmt.Errorf("delete upload images: %w", err)
		}
		report.ImagesDeleted = images
		deleted, err := q.DeleteUploadsByID(ctx, stale)
		if err != nil {
			return report, fmt.Errorf("delete uploads: %w", err)
		}
		report.UploadsDeleted = int(deleted)
	}
	// Orphans: objects whose upload row no longer exists (or never did).
	// jitter: none — a race with one scheduled job, not load; a minimum object age fixes it in a separate change [site server/internal/sweep/sweep.go:59]
	ids, err := q.ListUploadIDs(ctx)
	if err != nil {
		return report, fmt.Errorf("list uploads: %w", err)
	}
	live := make(map[string]bool, len(ids))
	for _, id := range ids {
		live[id] = true
	}
	report.Kept = len(ids)
	keys, err := blobs.List(ctx, "uploads/")
	if err != nil {
		return report, fmt.Errorf("list objects: %w", err)
	}
	for _, key := range keys {
		parts := strings.Split(strings.TrimPrefix(key, "uploads/"), "/")
		if len(parts) == 0 || parts[0] == "" || live[parts[0]] {
			continue
		}
		if err := blobs.Delete(ctx, key); err != nil {
			return report, fmt.Errorf("delete orphan %s: %w", key, err)
		}
		report.OrphansDeleted++
	}
	if log != nil {
		log.Info("sweep", slog.Time("cutoff", report.Cutoff), slog.Int("uploadsDeleted", report.UploadsDeleted), slog.Int64("imagesDeleted", report.ImagesDeleted), slog.Int("blobsDeleted", report.BlobsDeleted), slog.Int("orphanBlobsDeleted", report.OrphansDeleted), slog.Int("uploadsKept", report.Kept))
	}
	return report, nil
}

// deleteObjects removes an upload's file and images and reports how many objects existed.
func deleteObjects(ctx context.Context, blobs blob.Store, uploadID string) (int, error) {
	keys, err := blobs.List(ctx, blob.UploadKey(uploadID))
	if err != nil {
		return 0, err
	}
	count := 0
	for _, key := range keys {
		if key != blob.UploadKey(uploadID) && !strings.HasPrefix(key, blob.UploadPrefix(uploadID)) {
			continue // another upload whose id shares this prefix
		}
		if err := blobs.Delete(ctx, key); err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}
