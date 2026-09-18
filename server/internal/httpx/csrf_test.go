package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCSRFLoopbackAliases(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	cases := []struct {
		name, app, host, origin string
		want                    int
	}{
		// The dev proxy forwards its own host; the browser origin is the app origin.
		{"app origin through the proxy", "http://127.0.0.1:3000", "127.0.0.1:8080", "http://127.0.0.1:3000", http.StatusNoContent},
		// The same preview opened as localhost is one development origin, not a cross-site caller.
		{"localhost alias of a loopback app", "http://127.0.0.1:3000", "127.0.0.1:8080", "http://localhost:3000", http.StatusNoContent},
		{"127.0.0.1 alias of a localhost app", "http://localhost:3000", "127.0.0.1:8080", "http://127.0.0.1:3000", http.StatusNoContent},
		{"alias on another port", "http://127.0.0.1:3000", "127.0.0.1:8080", "http://localhost:3219", http.StatusForbidden},
		{"alias on another scheme", "http://127.0.0.1:3000", "127.0.0.1:8080", "https://localhost:3000", http.StatusForbidden},
		{"other site", "http://127.0.0.1:3000", "127.0.0.1:8080", "http://evil.example:3000", http.StatusForbidden},
		// Production is not loopback: a loopback origin never passes as its alias.
		{"loopback origin against the public app", "https://memoryz.kr", "memoryz.kr", "http://localhost:443", http.StatusForbidden},
		{"public app origin", "https://memoryz.kr", "memoryz.kr", "https://memoryz.kr", http.StatusNoContent},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPatch, "http://"+c.host+"/api/schedules/x", nil)
			req.Host = c.host
			req.Header.Set("Origin", c.origin)
			if c.app == "https://memoryz.kr" {
				req.Header.Set("X-Forwarded-Proto", "https")
			}
			rec := httptest.NewRecorder()
			CSRF(c.app)(ok).ServeHTTP(rec, req)
			if rec.Code != c.want {
				t.Fatalf("origin %s against app %s (host %s): got %d, want %d", c.origin, c.app, c.host, rec.Code, c.want)
			}
		})
	}
}
