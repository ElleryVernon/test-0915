package blob

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"cloud.google.com/go/storage"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/iterator"
)

// GCS keeps objects in one Cloud Storage bucket. Objects are private; the API streams them to
// their owner with its own headers, so no signed URLs are handed out.
type GCS struct {
	client *storage.Client
	bucket *storage.BucketHandle
	name   string
	// putBudget bounds one write with its retries; retry adjusts the client's backoff (tests only).
	putBudget time.Duration
	retry     []storage.RetryOption
}

// NewGCS connects with Application Default Credentials (the Cloud Run service account).
// jitter: none — the client's gax retry already applies full jitter to idempotent operations [site server/internal/blob/gcs.go:22]
func NewGCS(ctx context.Context, bucket string) (*GCS, error) {
	client, err := storage.NewClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("storage client: %w", err)
	}
	return &GCS{client: client, bucket: client.Bucket(bucket), name: bucket, putBudget: putBudget}, nil
}

// putBudget bounds a write and its retries. A single-request upload retries until its context ends
// (the client's attempt limit does not apply to it), so the bound is time: 20 s of full-jitter
// backoff, well inside the upload's 180 s deadline.
const putBudget = 20 * time.Second

func (s *GCS) Name() string { return "gcs:" + s.name }

// Close releases the client.
func (s *GCS) Close() error { return s.client.Close() }

// Put writes a new object. The DoesNotExist precondition makes the write idempotent, which is what
// lets the storage client retry it (full jitter) on a transient error; keys are fresh UUIDv7 ids, so
// a 412 means an earlier attempt already landed and counts as success.
// jitter: library idempotent write (DoesNotExist) so the client's full-jitter retry applies, bounded at 20 s; 412 = already written [site server/internal/blob/gcs.go:35]
func (s *GCS) Put(ctx context.Context, key, contentType string, data []byte) error {
	ctx, cancel := context.WithTimeout(ctx, s.putBudget)
	defer cancel()
	w := s.bucket.Object(key).If(storage.Conditions{DoesNotExist: true}).Retryer(s.retry...).NewWriter(ctx)
	w.ContentType = contentType
	w.CacheControl = "private, max-age=0"
	if _, err := w.Write(data); err != nil {
		_ = w.Close()
		return fmt.Errorf("gcs write %s: %w", key, err)
	}
	if err := w.Close(); err != nil {
		var apiErr *googleapi.Error
		if errors.As(err, &apiErr) && apiErr.Code == http.StatusPreconditionFailed {
			return nil
		}
		return fmt.Errorf("gcs close %s: %w", key, err)
	}
	return nil
}

// Get streams the object; the bytes never sit in memory as a whole.
func (s *GCS) Get(ctx context.Context, key string) (*Object, error) {
	r, err := s.bucket.Object(key).NewReader(ctx)
	if errors.Is(err, storage.ErrObjectNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("gcs read %s: %w", key, err)
	}
	return &Object{ReadCloser: r, Size: r.Attrs.Size, ContentType: r.Attrs.ContentType}, nil
}

func (s *GCS) Delete(ctx context.Context, key string) error {
	err := s.bucket.Object(key).Delete(ctx)
	if err != nil && !errors.Is(err, storage.ErrObjectNotExist) {
		return fmt.Errorf("gcs delete %s: %w", key, err)
	}
	return nil
}

func (s *GCS) List(ctx context.Context, prefix string) ([]string, error) {
	it := s.bucket.Objects(ctx, &storage.Query{Prefix: prefix})
	keys := []string{}
	for {
		attrs, err := it.Next()
		if errors.Is(err, iterator.Done) {
			return keys, nil
		}
		if err != nil {
			return nil, fmt.Errorf("gcs list %s: %w", prefix, err)
		}
		keys = append(keys, attrs.Name)
	}
}

func (s *GCS) DeletePrefix(ctx context.Context, prefix string) error {
	it := s.bucket.Objects(ctx, &storage.Query{Prefix: prefix})
	for {
		attrs, err := it.Next()
		if errors.Is(err, iterator.Done) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("gcs list %s: %w", prefix, err)
		}
		if err := s.Delete(ctx, attrs.Name); err != nil {
			return err
		}
	}
}
