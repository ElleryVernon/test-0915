// Package logx builds the process logger: JSON lines with the field names Cloud Logging reads
// (severity, message, time, trace), or a readable text handler for development.
package logx

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"time"
)

// New returns a logger at the given level. Structured output is JSON with Cloud Logging keys.
func New(level string, structured bool) *slog.Logger {
	var lv slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lv = slog.LevelDebug
	case "warn":
		lv = slog.LevelWarn
	case "error":
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	if structured {
		return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lv, ReplaceAttr: cloudKeys}))
	}
	return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: lv}))
}

// cloudKeys renames the standard attributes to what Cloud Logging's agent understands.
func cloudKeys(groups []string, a slog.Attr) slog.Attr {
	if len(groups) > 0 {
		return a
	}
	switch a.Key {
	case slog.LevelKey:
		level, _ := a.Value.Any().(slog.Level)
		return slog.String("severity", severity(level))
	case slog.MessageKey:
		return slog.String("message", a.Value.String())
	case slog.TimeKey:
		return slog.String("time", a.Value.Time().UTC().Format(time.RFC3339Nano))
	}
	return a
}

func severity(level slog.Level) string {
	switch {
	case level >= slog.LevelError:
		return "ERROR"
	case level >= slog.LevelWarn:
		return "WARNING"
	case level >= slog.LevelInfo:
		return "INFO"
	default:
		return "DEBUG"
	}
}

type ctxKey struct{}

// With attaches a request-scoped logger to ctx.
func With(ctx context.Context, logger *slog.Logger) context.Context {
	return context.WithValue(ctx, ctxKey{}, logger)
}

// From returns the request-scoped logger, or the default logger.
func From(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(ctxKey{}).(*slog.Logger); ok && l != nil {
		return l
	}
	return slog.Default()
}
