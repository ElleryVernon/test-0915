package httpx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"net/url"
	"runtime/debug"
	"strings"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/trace"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/logx"
	"memoryz/server/internal/telemetry"
)

// Trace opens one server span per request, named by method and identifier-free route, and
// continues a trace the load balancer or the browser started (traceparent, X-Cloud-Trace-Context).
func Trace() Middleware {
	return func(next http.Handler) http.Handler {
		return otelhttp.NewHandler(next, "http.server",
			otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string { return telemetry.RouteName(r.Method, r.URL.Path) }),
			otelhttp.WithFilter(func(r *http.Request) bool { return !probe(r.URL.Path) }),
		)
	}
}

// probe reports the platform's own checks (startup /api/health, liveness /api/live): they are
// neither traced nor logged above DEBUG.
func probe(path string) bool { return path == "/api/health" || path == "/api/live" }

// Middleware wraps a handler.
type Middleware func(http.Handler) http.Handler

// Chain applies middleware so the first listed runs outermost.
func Chain(h http.Handler, m ...Middleware) http.Handler {
	for i := len(m) - 1; i >= 0; i-- {
		h = m[i](h)
	}
	return h
}

type requestIDKey struct{}

// RequestID returns the id attached to the request, for correlation in logs and answers.
func RequestID(r *http.Request) string {
	id, _ := r.Context().Value(requestIDKey{}).(string)
	return id
}

// Observe attaches a request id and a request-scoped logger (with the Cloud Trace id when the
// front end sends one) and logs every request once it finishes.
func Observe(base *slog.Logger, project string) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := r.Header.Get("X-Request-Id")
			if id == "" || len(id) > 64 {
				var b [8]byte
				_, _ = rand.Read(b[:])
				id = hex.EncodeToString(b[:])
			}
			logger := base.With(slog.String("requestId", id))
			// The span context comes from the tracing middleware outside this one (which also
			// extracts the load balancer's trace header); a raw header is the fallback without it.
			traceHex, spanHex := "", ""
			if sc := trace.SpanContextFromContext(r.Context()); sc.HasTraceID() {
				traceHex = sc.TraceID().String()
				if sc.HasSpanID() {
					spanHex = sc.SpanID().String()
				}
			} else {
				traceHex = traceID(r.Header.Get("X-Cloud-Trace-Context"), r.Header.Get("traceparent"))
			}
			if traceHex != "" {
				logger = logger.With(slog.String("traceId", traceHex))
				if spanHex != "" {
					logger = logger.With(slog.String("logging.googleapis.com/spanId", spanHex))
				}
				if project != "" {
					logger = logger.With(slog.String("logging.googleapis.com/trace", "projects/"+project+"/traces/"+traceHex))
				}
			}
			ctx := logx.With(context.WithValue(r.Context(), requestIDKey{}, id), logger)
			w.Header().Set("X-Request-Id", id)
			rec := &recorder{ResponseWriter: w, status: 200}
			started := time.Now()
			next.ServeHTTP(rec, r.WithContext(ctx))
			level := slog.LevelInfo
			switch {
			case rec.status >= 500 && rec.Header().Get("Retry-After") != "":
				level = slog.LevelWarn // a designed transient state with its retry hint (an interrupted run)
			case rec.status >= 500:
				level = slog.LevelError
			case strings.HasPrefix(r.URL.Path, "/_next/") || probe(r.URL.Path):
				level = slog.LevelDebug
			}
			logger.Log(ctx, level, "request",
				slog.String("method", r.Method), slog.String("path", r.URL.Path), slog.Int("status", rec.status),
				slog.Int64("bytes", rec.bytes), slog.Float64("durationMs", float64(time.Since(started).Microseconds())/1000))
		})
	}
}

func traceID(cloud, traceparent string) string {
	if cloud != "" {
		if i := strings.IndexByte(cloud, '/'); i > 0 {
			return cloud[:i]
		}
		return cloud
	}
	if parts := strings.Split(traceparent, "-"); len(parts) == 4 && len(parts[1]) == 32 {
		return parts[1]
	}
	return ""
}

type recorder struct {
	http.ResponseWriter
	status int
	bytes  int64
	wrote  bool
}

func (r *recorder) WriteHeader(status int) {
	if r.wrote {
		return
	}
	r.wrote = true
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *recorder) Write(b []byte) (int, error) {
	if !r.wrote {
		r.WriteHeader(http.StatusOK)
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += int64(n)
	return n, err
}

func (r *recorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Recover turns a panic into the API's 500 and logs the stack.
func Recover() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					if rec == http.ErrAbortHandler {
						panic(rec)
					}
					logx.From(r.Context()).Error("panic", slog.Any("panic", rec), slog.String("stack", string(debug.Stack())))
					Fail(w, r, apierr.ErrInternal)
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// SecurityHeaders adds the headers the previous Next.js config set on every response; with hsts
// (an https public origin) browsers are told to keep using TLS for a year.
func SecurityHeaders(hsts bool) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			if hsts {
				h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
			}
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
			h.Set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
			if strings.HasPrefix(r.URL.Path, "/api/uploads/") {
				h.Set("X-Frame-Options", "SAMEORIGIN")
			} else {
				h.Set("X-Frame-Options", "DENY")
			}
			next.ServeHTTP(w, r)
		})
	}
}

// Timeout bounds the request context; handlers pass it to every query and upstream call. It first
// remembers the connection's own context, so a handler under a detached Deadline can still tell
// that its client has gone (ClientGone).
func Timeout(d time.Duration) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(WithClient(r.Context(), r.Context()), d)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

type clientKey struct{}

// WithClient records client, a context that ends when the client's connection does.
func WithClient(ctx, client context.Context) context.Context {
	return context.WithValue(ctx, clientKey{}, client)
}

// ClientGone is closed once the client's connection has ended; nil (never ready) when unknown.
// Deadline keeps it, because context.WithoutCancel keeps values.
func ClientGone(ctx context.Context) <-chan struct{} {
	if client, ok := ctx.Value(clientKey{}).(context.Context); ok {
		return client.Done()
	}
	return nil
}

// Deadline is Timeout for a single handler, for the few endpoints that legitimately run longer.
func Deadline(d time.Duration, h Handler) Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), d)
		defer cancel()
		return h(w, r.WithContext(ctx))
	}
}

// RequestScheme is the scheme the browser used, behind Cloud Run's proxy or not.
func RequestScheme(r *http.Request) string {
	if proto := r.Header.Get("X-Forwarded-Proto"); proto == "https" || proto == "http" {
		return proto
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

// CSRF is the previous server's mutation rule: a cross-site fetch is refused, and an Origin that is
// neither this request's origin, the app origin, nor the request's own host on the same scheme is refused.
func CSRF(appOrigin string) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet || r.Method == http.MethodHead {
				next.ServeHTTP(w, r)
				return
			}
			origin := r.Header.Get("Origin")
			matchesHost := false
			if origin != "" {
				u, err := url.Parse(origin)
				if err != nil || u.Host == "" {
					Fail(w, r, apierr.ErrBadOrigin)
					return
				}
				matchesHost = u.Host == r.Host && u.Scheme == RequestScheme(r)
			}
			requestOrigin := RequestScheme(r) + "://" + r.Host
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" || (origin != "" && origin != requestOrigin && origin != appOrigin && !matchesHost) {
				Fail(w, r, apierr.ErrBadOrigin)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
