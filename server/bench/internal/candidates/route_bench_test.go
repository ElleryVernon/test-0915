package candidates

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v3"
	"github.com/valyala/fasthttp"

	"memoryz/bench/internal/app"
)

// nopWriter discards the response so the measured allocations are the
// router's and the framework's own, not the recorder's.
type nopWriter struct{ h http.Header }

func (w *nopWriter) Header() http.Header         { return w.h }
func (w *nopWriter) Write(p []byte) (int, error) { return len(p), nil }
func (w *nopWriter) WriteHeader(int)             {}

// BenchmarkRoute sends GET /users/12345 through each candidate's router
// in-process: route match, path parameter extraction and the framework's JSON
// write of the small User payload. fiber is driven through its fasthttp
// handler with a reused RequestCtx.
func BenchmarkRoute(b *testing.B) {
	for _, c := range All() {
		b.Run(strings.ReplaceAll(c.Name, "/", "_"), func(b *testing.B) {
			if c.NewFiber != nil {
				benchFiber(b, c.NewFiber(nil))
				return
			}
			benchNetHTTP(b, c.NewHandler(nil))
		})
	}
}

func benchNetHTTP(b *testing.B, h http.Handler) {
	req := httptest.NewRequest(http.MethodGet, "/users/12345", nil)
	w := &nopWriter{h: make(http.Header)}
	b.ReportAllocs()
	for b.Loop() {
		clear(w.h)
		h.ServeHTTP(w, req)
	}
}

func benchFiber(b *testing.B, f *fiber.App) {
	h := f.Handler()
	var req fasthttp.Request
	req.SetRequestURI("http://127.0.0.1/users/12345")
	req.Header.SetMethod(fasthttp.MethodGet)
	var ctx fasthttp.RequestCtx
	ctx.Init(&req, nil, nil)
	b.ReportAllocs()
	for b.Loop() {
		ctx.Response.Reset()
		h(&ctx)
	}
}

// TestSameSemantics checks in-process that every candidate answers the three
// database-free endpoints identically (the orchestrator repeats this, plus
// /db, against the live child server before measuring).
func TestSameSemantics(t *testing.T) {
	want, err := app.SampleEchoBody()
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range All() {
		t.Run(c.Name, func(t *testing.T) {
			do := requester(t, c)

			status, ct, raw := do(http.MethodGet, "/json", nil)
			var h app.Hello
			if status != 200 || !strings.HasPrefix(ct, "application/json") || json.Unmarshal(raw, &h) != nil || h.Message != "hello" || h.TS <= 0 {
				t.Fatalf("GET /json: status=%d content-type=%q body=%s", status, ct, raw)
			}

			status, _, raw = do(http.MethodGet, "/users/abc-123", nil)
			var u app.User
			if status != 200 || json.Unmarshal(raw, &u) != nil || u != app.NewUser("abc-123") {
				t.Fatalf("GET /users/abc-123: status=%d body=%s", status, raw)
			}

			status, _, raw = do(http.MethodPost, "/echo", app.SampleEchoJSON)
			var e app.EchoBody
			if status != 200 || json.Unmarshal(raw, &e) != nil || !reflect.DeepEqual(e, want) {
				t.Fatalf("POST /echo: status=%d body=%s", status, raw)
			}

			status, _, _ = do(http.MethodGet, "/db?id=0", nil)
			if status != 400 {
				t.Fatalf("GET /db?id=0: status=%d, want 400", status)
			}
		})
	}
}

func requester(t *testing.T, c Candidate) func(method, path string, body []byte) (int, string, []byte) {
	t.Helper()
	newReq := func(method, path string, body []byte) *http.Request {
		var r io.Reader
		if body != nil {
			r = bytes.NewReader(body)
		}
		req := httptest.NewRequest(method, "http://127.0.0.1"+path, r)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		return req
	}
	if c.NewFiber != nil {
		f := c.NewFiber(nil)
		return func(method, path string, body []byte) (int, string, []byte) {
			resp, err := f.Test(newReq(method, path, body))
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			raw, _ := io.ReadAll(resp.Body)
			return resp.StatusCode, resp.Header.Get("Content-Type"), raw
		}
	}
	h := c.NewHandler(nil)
	return func(method, path string, body []byte) (int, string, []byte) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, newReq(method, path, body))
		return rec.Code, rec.Header().Get("Content-Type"), rec.Body.Bytes()
	}
}
