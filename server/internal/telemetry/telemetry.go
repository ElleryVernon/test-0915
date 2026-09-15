// Package telemetry wires OpenTelemetry: server and query spans, request metrics, pool and cache
// gauges. In the cloud everything goes over OTLP/gRPC to Google Cloud Observability's ingestion
// endpoint (telemetry.googleapis.com, the successor of the deprecated Cloud Trace / Cloud
// Monitoring exporters); in development the same records can be printed as JSON lines or
// discarded entirely (the default).
package telemetry

import (
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/contrib/detectors/gcp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/exporters/stdout/stdoutmetric"
	"go.opentelemetry.io/otel/exporters/stdout/stdouttrace"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/oauth"
)

// Exporter names.
const (
	ExporterNone   = "none"
	ExporterStdout = "stdout"
	ExporterGCP    = "gcp"
)

// googleOTLP is Google Cloud Observability's OTLP ingestion endpoint (traces and metrics).
const googleOTLP = "telemetry.googleapis.com:443"

// Options selects where telemetry goes.
type Options struct {
	Exporter    string
	Project     string  // Google Cloud project that receives the data (gcp)
	SampleRatio float64 // fraction of root traces kept
	ServiceName string
	Version     string
	Writer      io.Writer // stdout exporter target
}

// Providers holds what Setup started.
type Providers struct {
	tracer *sdktrace.TracerProvider
	meter  *sdkmetric.MeterProvider
}

// Setup installs the global providers and propagators; call Shutdown before exit.
func Setup(ctx context.Context, o Options) (*Providers, error) {
	// W3C trace context only: Cloud Run's front end sends traceparent alongside its legacy header, and
	// Google has deprecated its own propagator. httpx.Observe still reads X-Cloud-Trace-Context for log correlation.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	if o.Exporter == ExporterNone || o.Exporter == "" {
		return &Providers{}, nil
	}
	attrs := []attribute.KeyValue{semconv.ServiceName(o.ServiceName), semconv.ServiceVersion(o.Version)}
	opts := []resource.Option{resource.WithAttributes(attrs...)}
	if o.Exporter == ExporterGCP {
		if o.Project == "" {
			return nil, errors.New("telemetry: the gcp exporter needs GOOGLE_CLOUD_PROJECT")
		}
		// gcp.project_id routes the data; the detector adds the Cloud Run service, revision and location.
		opts = append(opts, resource.WithAttributes(attribute.String("gcp.project_id", o.Project)), resource.WithDetectors(gcp.NewDetector()))
	}
	res, err := resource.New(ctx, opts...)
	if err != nil && !errors.Is(err, resource.ErrPartialResource) {
		return nil, fmt.Errorf("telemetry resource: %w", err)
	}
	var spans sdktrace.SpanExporter
	var metrics sdkmetric.Exporter
	switch o.Exporter {
	case ExporterGCP:
		creds, err := oauth.NewApplicationDefault(ctx, "https://www.googleapis.com/auth/cloud-platform")
		if err != nil {
			return nil, fmt.Errorf("telemetry credentials: %w", err)
		}
		dial := grpc.WithPerRPCCredentials(creds)
		tls := credentials.NewTLS(nil)
		headers := map[string]string{"x-goog-user-project": o.Project}
		if spans, err = otlptracegrpc.New(ctx, otlptracegrpc.WithEndpoint(googleOTLP), otlptracegrpc.WithTLSCredentials(tls), otlptracegrpc.WithDialOption(dial), otlptracegrpc.WithHeaders(headers)); err != nil {
			return nil, fmt.Errorf("otlp traces: %w", err)
		}
		if metrics, err = otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithEndpoint(googleOTLP), otlpmetricgrpc.WithTLSCredentials(tls), otlpmetricgrpc.WithDialOption(dial), otlpmetricgrpc.WithHeaders(headers)); err != nil {
			return nil, fmt.Errorf("otlp metrics: %w", err)
		}
	case ExporterStdout:
		if spans, err = stdouttrace.New(stdouttrace.WithWriter(o.Writer)); err != nil {
			return nil, err
		}
		if metrics, err = stdoutmetric.New(stdoutmetric.WithWriter(o.Writer)); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("telemetry: unknown exporter %q", o.Exporter)
	}
	ratio := o.SampleRatio
	if ratio <= 0 || ratio > 1 {
		ratio = 1
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(ratio))),
		// jitter: none — the OTLP exporters' default retry is already randomized; at most 6 export streams [site server/internal/telemetry/telemetry.go:116]
		sdktrace.WithBatcher(Redact(spans), sdktrace.WithBatchTimeout(2*time.Second)),
	)
	// jitter: none — a 60 s PeriodicReader; up to 3 instances exporting in phase is 3 requests a minute [site server/internal/telemetry/telemetry.go:118]
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithResource(res), sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metrics, sdkmetric.WithInterval(60*time.Second))))
	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)
	return &Providers{tracer: tp, meter: mp}, nil
}

// personalKeys are the request attributes otelhttp records by default that identify a person: the
// client address (the first X-Forwarded-For entry, which the client itself chooses), the socket
// peer and the user agent. Spans keep only counts about the client (memoryz.client.hop and
// memoryz.client.entries), never these, so a learner's address does not reach Cloud Trace.
var personalKeys = map[attribute.Key]bool{
	"client.address": true, "client.port": true, "network.peer.address": true, "network.peer.port": true, "user_agent.original": true,
}

// Redact wraps a span exporter so spans leave the process without personalKeys.
func Redact(e sdktrace.SpanExporter) sdktrace.SpanExporter { return redactExporter{e} }

type redactExporter struct{ sdktrace.SpanExporter }

func (e redactExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	out := make([]sdktrace.ReadOnlySpan, len(spans))
	for i, s := range spans {
		out[i] = redactedSpan{s}
	}
	return e.SpanExporter.ExportSpans(ctx, out)
}

type redactedSpan struct{ sdktrace.ReadOnlySpan }

func (s redactedSpan) Attributes() []attribute.KeyValue {
	in := s.ReadOnlySpan.Attributes()
	out := make([]attribute.KeyValue, 0, len(in))
	for _, kv := range in {
		if !personalKeys[kv.Key] {
			out = append(out, kv)
		}
	}
	return out
}

// Shutdown flushes and stops the providers.
func (p *Providers) Shutdown(ctx context.Context) error {
	var errs []error
	if p.tracer != nil {
		errs = append(errs, p.tracer.Shutdown(ctx))
	}
	if p.meter != nil {
		errs = append(errs, p.meter.Shutdown(ctx))
	}
	return errors.Join(errs...)
}

var (
	meter          = otel.Meter("memoryz/server")
	cacheRequests  metric.Int64Counter
	cacheRequestsK = attribute.Key("cache.result")
	retryAfter     metric.Float64Histogram
	aiQueueWait    metric.Float64Histogram
	aiUpstream429  metric.Int64Counter
)

func init() {
	cacheRequests, _ = meter.Int64Counter("memoryz.cache.requests", metric.WithDescription("Cache lookups by result"))
	retryAfter, _ = meter.Float64Histogram("memoryz.http.retry_after", metric.WithDescription("Retry-After hints sent to clients, by status"), metric.WithUnit("s"))
	aiQueueWait, _ = meter.Float64Histogram("memoryz.ai.queue_wait", metric.WithDescription("Time a paid model call waited for an admission slot, by outcome"), metric.WithUnit("s"))
	aiUpstream429, _ = meter.Int64Counter("memoryz.ai.upstream_429", metric.WithDescription("Model calls the provider refused with 429"))
}

// AIQueueWait records how long one model call waited for a slot and whether it got one.
func AIQueueWait(ctx context.Context, wait time.Duration, admitted bool) {
	aiQueueWait.Record(ctx, wait.Seconds(), metric.WithAttributes(attribute.Bool("admitted", admitted)))
}

// AIUpstream429 counts one provider refusal.
func AIUpstream429(ctx context.Context) { aiUpstream429.Add(ctx, 1) }

// RetryAfter records one hint a refusal carried, so a bell's refusals and their spread show up.
func RetryAfter(ctx context.Context, status int, wait time.Duration) {
	retryAfter.Record(ctx, wait.Seconds(), metric.WithAttributes(attribute.Int("http.response.status_code", status)))
}

// CacheResult records one cache lookup (hit or miss) under name.
func CacheResult(ctx context.Context, name string, hit bool) {
	result := "miss"
	if hit {
		result = "hit"
	}
	cacheRequests.Add(ctx, 1, metric.WithAttributes(attribute.String("cache.name", name), cacheRequestsK.String(result)))
}

// ObservePool exports the connection pool's occupancy as gauges, and its cumulative waits and
// lifetime closes as counters: a 10 s bell is invisible in a 60 s occupancy sample but shows up as
// a jump in acquires that found no idle connection and in the time they waited.
func ObservePool(pool *pgxpool.Pool) error {
	total, err := meter.Int64ObservableGauge("memoryz.db.pool.connections", metric.WithDescription("Pool connections by state"))
	if err != nil {
		return err
	}
	empty, err := meter.Int64ObservableCounter("memoryz.db.pool.empty_acquires", metric.WithDescription("Acquires that waited because no idle connection was available"))
	if err != nil {
		return err
	}
	emptyWait, err := meter.Float64ObservableCounter("memoryz.db.pool.empty_acquire_wait", metric.WithDescription("Total time acquires waited for a connection"), metric.WithUnit("s"))
	if err != nil {
		return err
	}
	canceled, err := meter.Int64ObservableCounter("memoryz.db.pool.canceled_acquires", metric.WithDescription("Acquires given up because their context ended"))
	if err != nil {
		return err
	}
	lifetime, err := meter.Int64ObservableCounter("memoryz.db.pool.lifetime_closes", metric.WithDescription("Connections closed at MaxConnLifetime (+ jitter)"))
	if err != nil {
		return err
	}
	// jitter: none — measurement, not load; the cumulative acquire counters keep a 10 s bell visible in 60 s exports [site server/internal/telemetry/telemetry.go:161]
	_, err = meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		st := pool.Stat()
		o.ObserveInt64(total, int64(st.AcquiredConns()), metric.WithAttributes(attribute.String("state", "acquired")))
		o.ObserveInt64(total, int64(st.IdleConns()), metric.WithAttributes(attribute.String("state", "idle")))
		o.ObserveInt64(total, int64(st.MaxConns()), metric.WithAttributes(attribute.String("state", "max")))
		o.ObserveInt64(empty, st.EmptyAcquireCount())
		o.ObserveFloat64(emptyWait, st.EmptyAcquireWaitTime().Seconds())
		o.ObserveInt64(canceled, st.CanceledAcquireCount())
		o.ObserveInt64(lifetime, st.MaxLifetimeDestroyCount())
		return nil
	}, total, empty, emptyWait, canceled, lifetime)
	return err
}

var idSegment = regexp.MustCompile(`^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|c[a-z0-9]{24}|demo-[a-z0-9-]+|[0-9]+)$`)

// RouteName collapses identifiers so span names stay low-cardinality: /api/materials/{id}.
func RouteName(method, path string) string {
	out := make([]byte, 0, len(path)+8)
	start := 0
	for i := 0; i <= len(path); i++ {
		if i == len(path) || path[i] == '/' {
			segment := path[start:i]
			if idSegment.MatchString(segment) {
				segment = "{id}"
			}
			out = append(out, segment...)
			if i < len(path) {
				out = append(out, '/')
			}
			start = i + 1
		}
	}
	return method + " " + string(out)
}
