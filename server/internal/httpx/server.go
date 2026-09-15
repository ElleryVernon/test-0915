package httpx

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"
)

// Cloud Run sends SIGTERM and stops the instance 10 s later; the whole shutdown fits inside that.
// In-flight requests get ShutdownGrace to finish. AI runs still waiting on the model are
// interrupted at DrainAfter (leaving their 2 s to record INTERRUPTED before ShutdownGrace), so each
// answers with a retry hint while the server still can instead of all of them flipping together
// when their 5-minute lease runs out. Then the stores close within CloseGrace and the telemetry
// flush gets FlushGrace: 7.5 s + 0.5 s + 1.5 s = 9.5 s. No random delay here: the spread is in the
// hint the interrupted runs carry.
// jitter: retry-after no random delay at shutdown; drain at SIGTERM + 5.5 s interrupts AI runs, which answer Retry-After 10 s + U[0,10 s) [site server/internal/httpx/server.go:13]
const (
	ShutdownGrace = 7500 * time.Millisecond
	DrainAfter    = 5500 * time.Millisecond
	CloseGrace    = 500 * time.Millisecond
	FlushGrace    = 1500 * time.Millisecond
)

// Serve runs the server until ctx is cancelled, then drains connections; drain (may be nil) runs
// DrainAfter into the shutdown if requests are still in flight.
func Serve(ctx context.Context, addr string, handler http.Handler, logger *slog.Logger, drain func()) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	return serve(ctx, ln, handler, logger, drain, DrainAfter)
}

func serve(ctx context.Context, ln net.Listener, handler http.Handler, logger *slog.Logger, drain func(), drainAfter time.Duration) error {
	// jitter: none — per-connection bounds with no synchronized retry [site server/internal/httpx/server.go:21]
	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       2 * time.Minute, // a 10 MB upload on a slow school network
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
	}
	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()
	logger.Info("listening", slog.String("addr", ln.Addr().String()))
	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("listen: %w", err)
	case <-ctx.Done():
		if drain != nil {
			// jitter: retry-after no delay of its own; the runs it interrupts answer Retry-After 10 s + U[0,10 s)
			timer := time.AfterFunc(drainAfter, drain)
			defer timer.Stop()
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), ShutdownGrace)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shutdown: %w", err)
		}
		logger.Info("stopped")
		return nil
	}
}
