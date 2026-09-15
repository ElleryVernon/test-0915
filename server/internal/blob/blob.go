// Package blob stores uploaded files and the images read out of them behind one interface, so the
// handlers are the same whether bytes live in Cloud Storage (cloud) or Postgres (local development).
// Keys mirror the object layout: uploads/<uploadId> and uploads/<uploadId>/images/<imageId>.
package blob

import (
	"context"
	"errors"
	"fmt"
	"io"
)

// ErrNotFound is returned when a key has no object.
var ErrNotFound = errors.New("blob: not found")

// Object is an opened object: its bytes as a stream plus what is known about it up front.
type Object struct {
	io.ReadCloser
	Size        int64
	ContentType string
}

// Store is the storage driver.
type Store interface {
	// Put writes data under key, replacing any existing object.
	Put(ctx context.Context, key, contentType string, data []byte) error
	// Get opens the object under key for streaming, or returns ErrNotFound. The caller closes it.
	Get(ctx context.Context, key string) (*Object, error)
	// Delete removes one object; a missing object is not an error.
	Delete(ctx context.Context, key string) error
	// DeletePrefix removes every object whose key starts with prefix.
	DeletePrefix(ctx context.Context, prefix string) error
	// List returns the keys under prefix (the sweep reconciles them against the database).
	List(ctx context.Context, prefix string) ([]string, error)
	// Name identifies the driver in health output.
	Name() string
}

// ReadAll fetches a whole object; for the bounded inputs that need bytes in memory (extraction).
func ReadAll(ctx context.Context, s Store, key string) ([]byte, string, error) {
	obj, err := s.Get(ctx, key)
	if err != nil {
		return nil, "", err
	}
	defer obj.Close()
	data, err := io.ReadAll(obj)
	if err != nil {
		return nil, "", err
	}
	return data, obj.ContentType, nil
}

// UploadKey is where an upload's original bytes live.
func UploadKey(uploadID string) string { return "uploads/" + uploadID }

// ImageKey is where one image extracted from an upload lives.
func ImageKey(uploadID, imageID string) string {
	return fmt.Sprintf("uploads/%s/images/%s", uploadID, imageID)
}

// UploadPrefix covers the upload and all of its images.
func UploadPrefix(uploadID string) string { return "uploads/" + uploadID + "/" }
