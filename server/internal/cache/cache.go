// Package cache is the performance layer in front of Postgres: session snapshots, versioned
// bootstrap payloads, rate-limit counters and short leases. Correctness never depends on it — a
// miss or a lost key only costs a query.
package cache

import (
	"context"
	"time"
)

// Cache is implemented by Valkey (cloud) and an in-process map (development, tests).
type Cache interface {
	// Get returns the value and whether it was present.
	Get(ctx context.Context, key string) ([]byte, bool, error)
	// Set stores value for ttl (ttl <= 0 keeps it until evicted).
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	// Del removes keys; missing keys are fine.
	Del(ctx context.Context, keys ...string) error
	// Incr adds one and returns the new count and the time left before the key expires, in one
	// atomic step. A new key — or one that somehow lost its expiry — expires after ttl.
	Incr(ctx context.Context, key string, ttl time.Duration) (n int64, left time.Duration, err error)
	// Bump stores max(current+1, floor) as decimal text for ttl and returns it: a version that only
	// ever increases, even after the key expired or two writers raced (docs/JITTER.md).
	Bump(ctx context.Context, key string, floor int64, ttl time.Duration) (string, error)
	// Lock takes a lease on key for ttl if nobody holds it; release is safe to call once.
	Lock(ctx context.Context, key string, ttl time.Duration) (release func(), ok bool, err error)
	// Flush drops every key. Development tooling only (a check that wrote to the database directly);
	// nothing in the production request path calls it.
	Flush(ctx context.Context) error
	// Name identifies the driver in health output.
	Name() string
	// Close releases the driver.
	Close() error
}
