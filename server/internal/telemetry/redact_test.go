package telemetry_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"memoryz/server/internal/httpx"
	"memoryz/server/internal/telemetry"
)

// TestRedact: a request through the real tracing middleware leaves no client address, peer address
// or user agent on the exported span, while the client counts stay; the unredacted control has them.
func TestRedact(t *testing.T) {
	export := func(wrap func(sdktrace.SpanExporter) sdktrace.SpanExporter) map[attribute.Key]string {
		mem := tracetest.NewInMemoryExporter()
		tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(wrap(mem)))
		prev := otel.GetTracerProvider()
		otel.SetTracerProvider(tp)
		defer otel.SetTracerProvider(prev)
		h := httpx.Trace()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			trace.SpanFromContext(r.Context()).SetAttributes(attribute.Int("memoryz.client.hop", 1), attribute.Int("memoryz.client.entries", 3))
		}))
		req := httptest.NewRequest(http.MethodPost, "/api/session", nil)
		req.RemoteAddr = "198.51.100.2:4321"
		req.Header.Set("X-Forwarded-For", "203.0.113.7, 198.51.100.2, 136.110.129.207")
		req.Header.Set("User-Agent", "Mozilla/5.0 (a learner's phone)")
		h.ServeHTTP(httptest.NewRecorder(), req)
		spans := mem.GetSpans()
		if len(spans) != 1 {
			t.Fatalf("one server span: %d", len(spans))
		}
		got := map[attribute.Key]string{}
		for _, kv := range spans[0].Attributes {
			got[kv.Key] = kv.Value.String()
		}
		return got
	}
	raw := export(func(e sdktrace.SpanExporter) sdktrace.SpanExporter { return e })
	if raw["client.address"] == "" || raw["user_agent.original"] == "" {
		t.Fatalf("control: the tracing middleware records the address and agent by default: %v", raw)
	}
	red := export(telemetry.Redact)
	for _, k := range []attribute.Key{"client.address", "client.port", "network.peer.address", "network.peer.port", "user_agent.original"} {
		if v, ok := red[k]; ok {
			t.Fatalf("%s left the process: %q", k, v)
		}
	}
	if red["memoryz.client.hop"] != "1" || red["memoryz.client.entries"] != "3" || red["http.request.method"] != "POST" {
		t.Fatalf("the counts and request shape stay: %v", red)
	}
}
