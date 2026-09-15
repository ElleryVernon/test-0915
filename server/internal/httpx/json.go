// Package httpx is the thin HTTP layer: handler and error conventions, middleware, JSON helpers
// and the static SPA server. Handlers return errors; the layer turns them into the API's JSON.
package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/db"
	"memoryz/server/internal/jitter"
	"memoryz/server/internal/logx"
	"memoryz/server/internal/telemetry"
)

// MaxJSONBody caps request bodies for JSON endpoints (the previous server's 3,000,000 characters).
const MaxJSONBody = 3_000_000

// Handler is an endpoint that reports failures by returning an error.
type Handler func(w http.ResponseWriter, r *http.Request) error

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if err := h(w, r); err != nil {
		Fail(w, r, err)
	}
}

// Methods dispatches on the request method; anything else is the API's 404, as before.
type Methods map[string]Handler

func (m Methods) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h, ok := m[r.Method]
	if !ok {
		Fail(w, r, apierr.ErrRouteNotFound)
		return
	}
	h.ServeHTTP(w, r)
}

// NotFound is the JSON 404 for unknown API paths.
var NotFound = Handler(func(w http.ResponseWriter, r *http.Request) error { return apierr.ErrRouteNotFound })

func jsonHeaders(h http.Header) {
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
}

// writeJSON encodes first so Content-Length is exact; the gzip layer then knows whether the body is
// worth compressing.
func writeJSON(w http.ResponseWriter, status int, body any) {
	raw, err := json.Marshal(body)
	if err != nil {
		raw = []byte(`{"error":"` + apierr.ErrInternal.Message + `"}`)
		status = http.StatusInternalServerError
	}
	raw = append(raw, '\n')
	jsonHeaders(w.Header())
	w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

// OK writes {"data": data} with the API's headers.
func OK(w http.ResponseWriter, status int, data any) {
	writeJSON(w, status, map[string]any{"data": data})
}

// Raw is OK for data that is already encoded JSON (a cached document).
func Raw(w http.ResponseWriter, status int, data []byte) {
	body := make([]byte, 0, len(data)+10)
	body = append(append(append(body, `{"data":`...), data...), '}', '\n')
	jsonHeaders(w.Header())
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// Fail writes the error contract: known API errors keep their status and message, driver and
// deadline errors are translated, everything else is a logged 500.
func Fail(w http.ResponseWriter, r *http.Request, err error) {
	e := Translate(err)
	if e.Status >= 500 && !errors.Is(err, context.DeadlineExceeded) {
		// A 5xx that carries a retry hint is a designed transient state (a run interrupted at a
		// deploy, a queue that ran out): worth a warning, not an error page for the operator.
		level := slog.LevelError
		if e.RetryMin > 0 || e.RetrySpread > 0 {
			level = slog.LevelWarn
		}
		logx.From(r.Context()).Log(r.Context(), level, "request failed", slog.String("error", err.Error()), slog.String("path", r.URL.Path))
	}
	body := map[string]any{"error": e.Message}
	if e.Code != "" {
		body["code"] = e.Code
	}
	if wait, ok := RetryAfter(e, jitter.Std); ok {
		// Whole seconds in the header (RFC 9110), milliseconds in the body; clients prefer the body.
		w.Header().Set("Retry-After", strconv.FormatInt(int64((wait+time.Second-1)/time.Second), 10))
		body["retryAfterMs"] = wait.Milliseconds()
		telemetry.RetryAfter(r.Context(), e.Status, wait)
	}
	writeJSON(w, e.Status, body)
}

// RetryAfter draws the hint for e: RetryMin + U[0, RetrySpread), at least one second. Errors without
// a hint (most 4xx, permanent 503s) get none.
func RetryAfter(e *apierr.Error, r jitter.Rand) (time.Duration, bool) {
	if e.RetryMin <= 0 && e.RetrySpread <= 0 {
		return 0, false
	}
	// jitter: retry-after RetryMin + U[0, RetrySpread), ≥ 1 s, drawn per response [site server/internal/httpx/json.go:84]
	d := max(time.Second, e.RetryMin+jitter.Between(r, 0, e.RetrySpread))
	// Whole milliseconds, rounded up: the header's ceil(seconds) and the body's milliseconds then
	// always agree, and an exact deadline (a parent's lock) is never reported early.
	return (d + time.Millisecond - 1).Truncate(time.Millisecond), true
}

// Translate maps any error onto the API error it is answered with.
func Translate(err error) *apierr.Error {
	if e, ok := apierr.From(err); ok {
		return e
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return apierr.ErrTooLarge
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return apierr.ErrTimeout
	}
	if errors.Is(err, context.Canceled) {
		// The client left (a classroom's Wi-Fi dropping): not a server fault, and no one reads it.
		return apierr.ErrClientGone
	}
	if mapped := db.Map(err); mapped != err {
		if e, ok := apierr.From(mapped); ok {
			return e
		}
	}
	return apierr.ErrInternal
}

// Decode reads a JSON body of at most MaxJSONBody bytes into v.
func Decode(r *http.Request, v any) error {
	if n, _ := strconv.Atoi(r.Header.Get("Content-Length")); n > MaxJSONBody {
		return apierr.ErrTooLarge
	}
	raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, MaxJSONBody))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return apierr.ErrTooLarge
		}
		return apierr.ErrBadJSON
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return apierr.ErrBadJSON
	}
	return nil
}
