package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"memoryz/bench/internal/app"
	"memoryz/bench/internal/candidates"
)

// runServe is the child mode: serve one candidate on 127.0.0.1:port until
// SIGTERM/SIGINT or, with -watch-stdin, until stdin reaches EOF. The pool DSN
// arrives in BENCH_DSN so credentials never appear on a command line.
func runServe(name string, port int, watchStdin bool) int {
	c, ok := candidates.Find(name)
	if !ok {
		fmt.Fprintf(os.Stderr, "unknown candidate %q\n", name)
		return 2
	}
	if port <= 0 {
		fmt.Fprintln(os.Stderr, "-port is required with -serve")
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if watchStdin {
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			cancel()
		}()
	}

	var store *app.Store
	if dsn := os.Getenv("BENCH_DSN"); dsn != "" {
		setupCtx, done := context.WithTimeout(ctx, 30*time.Second)
		pool, err := app.NewPool(setupCtx, dsn)
		done()
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", name, err)
			return 1
		}
		store = app.NewStore(pool)
		defer store.Close()
	}

	if err := candidates.Serve(ctx, c, store, fmt.Sprintf("127.0.0.1:%d", port)); err != nil {
		fmt.Fprintf(os.Stderr, "%s: %v\n", name, err)
		return 1
	}
	return 0
}
