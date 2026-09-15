package telemetry_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"memoryz/server/internal/httpx"
	"memoryz/server/internal/telemetry"
)

// TestSampler: requests reach the server the way Cloud Run's front end forwards them — a traceparent
// whose sampled flag is the platform's rate limit. With ratio 1 every one is kept under its own trace
// id, whatever the flag says; a remote "sampled" is kept even at a tiny ratio; a child of an unsampled
// span in the process stays unsampled. The old ParentBased(ratio) sampler is the control: it drops
// the forwarded "not sampled" request, which is how Cloud Trace lost all but one request in ten seconds.
func TestSampler(t *testing.T) {
	const (
		unsampled = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"
		sampled   = "00-5bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	)
	serve := func(s sdktrace.Sampler, traceparent string) []tracetest.SpanStub {
		mem := tracetest.NewInMemoryExporter()
		tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(mem), sdktrace.WithSampler(s))
		prevTP, prevProp := otel.GetTracerProvider(), otel.GetTextMapPropagator()
		otel.SetTracerProvider(tp)
		otel.SetTextMapPropagator(propagation.TraceContext{})
		defer func() { otel.SetTracerProvider(prevTP); otel.SetTextMapPropagator(prevProp) }()
		h := httpx.Trace()(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
		if traceparent != "" {
			req.Header.Set("traceparent", traceparent)
		}
		h.ServeHTTP(httptest.NewRecorder(), req)
		return mem.GetSpans()
	}
	traceOf := func(traceparent string) string { return traceparent[3:35] }

	for name, tc := range map[string]struct {
		sampler     sdktrace.Sampler
		traceparent string
		kept        bool
	}{
		"forwarded not-sampled, ratio 1":    {telemetry.Sampler(1), unsampled, true},
		"forwarded sampled, tiny ratio":     {telemetry.Sampler(1e-12), sampled, true},
		"no parent, ratio 1":                {telemetry.Sampler(1), "", true},
		"control: ParentBased(ratio 1)":     {sdktrace.ParentBased(sdktrace.TraceIDRatioBased(1)), unsampled, false},
		"forwarded not-sampled, tiny ratio": {telemetry.Sampler(1e-12), unsampled, false},
	} {
		spans := serve(tc.sampler, tc.traceparent)
		if kept := len(spans) == 1; kept != tc.kept {
			t.Errorf("%s: kept=%v, want %v", name, kept, tc.kept)
			continue
		}
		if tc.kept && tc.traceparent != "" {
			if got := spans[0].SpanContext.TraceID().String(); got != traceOf(tc.traceparent) || !spans[0].Parent.IsRemote() {
				t.Errorf("%s: trace %s (remote parent %v), want the forwarded trace %s", name, got, spans[0].Parent.IsRemote(), traceOf(tc.traceparent))
			}
		}
	}

	// Inside the process a child follows its parent, so a trace is never kept in pieces.
	s := telemetry.Sampler(1)
	parent := trace.NewSpanContext(trace.SpanContextConfig{TraceID: trace.TraceID{1}, SpanID: trace.SpanID{1}})
	res := s.ShouldSample(sdktrace.SamplingParameters{ParentContext: trace.ContextWithSpanContext(context.Background(), parent), TraceID: parent.TraceID(), Name: "child"})
	if res.Decision != sdktrace.Drop {
		t.Errorf("child of an unsampled local span: %v, want Drop", res.Decision)
	}
}
