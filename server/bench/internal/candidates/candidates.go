// Package candidates wires the shared handler bodies (internal/app) into each
// framework under test. Only routing, parameter extraction and the
// framework's own JSON helpers differ between the per-framework files.
package candidates

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"

	"github.com/gofiber/fiber/v3"

	"memoryz/bench/internal/app"
)

// Meta describes a candidate before it is measured.
type Meta struct {
	// Name is the report name; "net/http" is the standard library.
	Name string
	// Module is the module path ("" for the standard library).
	Module string
	// Pinned is the version required by the ledger; it is verified against the
	// binary's build info before anything is measured.
	Pinned string
	// NetHTTPCompatible means: the router is an http.Handler served by
	// net/http.Server, a plain http.Handler / func(http.Handler) http.Handler
	// middleware mounts without copying the request or response (so otelhttp
	// and http.Flusher streaming work), and the http.ResponseWriter and
	// *http.Request are reachable from a handler.
	NetHTTPCompatible bool
	// Compat is the one-line justification for NetHTTPCompatible.
	Compat string
	// JSONPath names the JSON code path the glue uses.
	JSONPath string
}

// Candidate is a measurable framework.
type Candidate struct {
	Meta
	// NewHandler builds the net/http handler (nil for fiber).
	NewHandler func(store *app.Store) http.Handler
	// NewFiber builds the fasthttp application (fiber only).
	NewFiber func(store *app.Store) *fiber.App
}

// StdlibName is the report name of the standard library candidate.
const StdlibName = "net/http"

// All returns the six candidates in report order.
func All() []Candidate {
	return []Candidate{
		{
			Meta: Meta{
				Name:              StdlibName,
				NetHTTPCompatible: true,
				Compat:            "the standard library itself: http.ServeMux with Go 1.22+ method/pattern routing",
				JSONPath:          "encoding/json Encoder to the ResponseWriter, Decoder from the body",
			},
			NewHandler: newStdlib,
		},
		{
			Meta: Meta{
				Name:              "chi",
				Module:            "github.com/go-chi/chi/v5",
				Pinned:            "v5.3.2",
				NetHTTPCompatible: true,
				Compat:            "*chi.Mux is an http.Handler; handlers are http.HandlerFunc; middleware is func(http.Handler) http.Handler",
				JSONPath:          "encoding/json Encoder to the ResponseWriter, Decoder from the body (chi has no JSON helpers)",
			},
			NewHandler: newChi,
		},
		{
			Meta: Meta{
				Name:              "echo",
				Module:            "github.com/labstack/echo/v5",
				Pinned:            "v5.3.1",
				NetHTTPCompatible: true,
				Compat:            "*echo.Echo is an http.Handler; echo.WrapHandler/WrapMiddleware mount http.Handler and net/http middleware unchanged; c.Response() is the http.ResponseWriter and c.Request() the *http.Request",
				JSONPath:          "c.JSON via DefaultJSONSerializer (encoding/json Encoder); c.Bind via encoding/json Unmarshal",
			},
			NewHandler: newEcho,
		},
		{
			Meta: Meta{
				Name:              "gin",
				Module:            "github.com/gin-gonic/gin",
				Pinned:            "v1.12.0",
				NetHTTPCompatible: true,
				Compat:            "*gin.Engine is an http.Handler; gin.WrapH/WrapF mount http.Handler/HandlerFunc unchanged; c.Writer is the http.ResponseWriter and c.Request the *http.Request",
				JSONPath:          "c.JSON via render.JSON (encoding/json Marshal; built without the jsoniter/go_json/sonic tags); c.ShouldBindJSON via encoding/json Decoder plus go-playground/validator",
			},
			NewHandler: newGin,
		},
		{
			Meta: Meta{
				Name:              "fiber",
				Module:            "github.com/gofiber/fiber/v3",
				Pinned:            "v3.5.0",
				NetHTTPCompatible: false,
				Compat:            "fasthttp server: *fiber.App is not an http.Handler and cannot be served by net/http.Server; net/http handlers and middleware only through the adaptor package, which copies requests and responses (no http.Flusher streaming, otelhttp cannot wrap the server); fasthttp speaks no HTTP/2",
				JSONPath:          "c.JSON via Config.JSONEncoder (default encoding/json Marshal); c.Bind().JSON via Config.JSONDecoder (default encoding/json Unmarshal)",
			},
			NewFiber: newFiber,
		},
		{
			Meta: Meta{
				Name:              "huma",
				Module:            "github.com/danielgtaylor/huma/v2",
				Pinned:            "v2.39.1",
				NetHTTPCompatible: true,
				Compat:            "humago adapter registers plain http.HandlerFunc on a net/http ServeMux, which is the http.Handler; typed operation handlers sit on top; net/http middleware wraps the mux",
				JSONPath:          "huma.DefaultJSONFormat (encoding/json Encoder / Unmarshal) with request validation against the generated schema",
			},
			NewHandler: newHuma,
		},
	}
}

// Find returns the candidate with the given report name.
func Find(name string) (Candidate, bool) {
	for _, c := range All() {
		if c.Name == name {
			return c, true
		}
	}
	return Candidate{}, false
}

// Serve runs the candidate on addr until ctx is done, then shuts down
// gracefully.
func Serve(ctx context.Context, c Candidate, store *app.Store, addr string) error {
	if c.NewFiber != nil {
		return serveFiber(ctx, c.NewFiber(store), addr)
	}
	return ServeNetHTTP(ctx, c.NewHandler(store), addr)
}

// ServeNetHTTP is the single net/http server configuration shared by every
// net/http candidate: HTTP/1.1 plus unencrypted HTTP/2 (h2c) via
// Server.Protocols, which Go 1.24+ supports without golang.org/x/net.
func ServeNetHTTP(ctx context.Context, h http.Handler, addr string) error {
	ln, err := net.Listen("tcp4", addr)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second}
	srv.Protocols = new(http.Protocols)
	srv.Protocols.SetHTTP1(true)
	srv.Protocols.SetUnencryptedHTTP2(true)
	done := make(chan error, 1)
	go func() { done <- srv.Serve(ln) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return err
		}
		if err := <-done; err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}

func serveFiber(ctx context.Context, f *fiber.App, addr string) error {
	err := f.Listen(addr, fiber.ListenConfig{
		DisableStartupMessage: true,
		GracefulContext:       ctx,
		ShutdownTimeout:       10 * time.Second,
		ListenerNetwork:       fiber.NetworkTCP4,
	})
	if ctx.Err() != nil {
		return nil
	}
	return err
}
