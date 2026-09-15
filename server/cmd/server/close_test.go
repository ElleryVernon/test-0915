package main

import (
	"io"
	"log/slog"
	"testing"
	"time"
)

// TestCloseWithin: closers run last-opened first, and one that never returns (the pool waiting on a
// connection a request still holds) cannot hold the exit past the grace.
func TestCloseWithin(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	var order []int
	closeWithin(time.Second, []func(){func() { order = append(order, 1) }, func() { order = append(order, 2) }}, logger)
	if len(order) != 2 || order[0] != 2 || order[1] != 1 {
		t.Fatalf("last opened closes first: %v", order)
	}
	block := make(chan struct{})
	defer close(block)
	started := time.Now()
	closeWithin(100*time.Millisecond, []func(){func() { <-block }}, logger)
	if took := time.Since(started); took < 100*time.Millisecond || took > 500*time.Millisecond {
		t.Fatalf("a stuck closer is abandoned after the grace: %v", took)
	}
}
