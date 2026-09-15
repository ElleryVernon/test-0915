package httpx

import (
	"compress/gzip"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

var gzipPool = sync.Pool{New: func() any {
	w, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
	return w
}}

// Gzip compresses text-like responses (JSON, HTML, scripts, styles, SVG) of at least 1 KiB for
// clients that accept it. Files that are already compressed (images, PDF, fonts) pass through.
func Gzip() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodHead || !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
				next.ServeHTTP(w, r)
				return
			}
			gw := &gzipWriter{ResponseWriter: w}
			defer gw.Close()
			next.ServeHTTP(gw, r)
		})
	}
}

func compressible(contentType string) bool {
	ct := strings.ToLower(contentType)
	switch {
	case strings.HasPrefix(ct, "text/"),
		strings.HasPrefix(ct, "application/json"),
		strings.HasPrefix(ct, "application/javascript"),
		strings.HasPrefix(ct, "application/manifest+json"),
		strings.HasPrefix(ct, "application/xml"),
		strings.HasPrefix(ct, "image/svg+xml"),
		strings.HasPrefix(ct, "application/wasm"):
		return true
	}
	return false
}

type gzipWriter struct {
	http.ResponseWriter
	gz       *gzip.Writer
	decided  bool
	compress bool
	wrote    bool
}

func (g *gzipWriter) decide(status int) {
	if g.decided {
		return
	}
	g.decided = true
	h := g.Header()
	if h.Get("Content-Encoding") != "" || status == http.StatusNoContent || status == http.StatusNotModified || status == http.StatusSwitchingProtocols {
		return
	}
	if !compressible(h.Get("Content-Type")) {
		return
	}
	h.Add("Vary", "Accept-Encoding")
	if cl := h.Get("Content-Length"); cl != "" {
		if n, err := strconv.Atoi(cl); err == nil && n < 1024 {
			return
		}
	}
	g.compress = true
	h.Del("Content-Length")
	h.Set("Content-Encoding", "gzip")
	g.gz = gzipPool.Get().(*gzip.Writer)
	g.gz.Reset(g.ResponseWriter)
}

func (g *gzipWriter) WriteHeader(status int) {
	if g.wrote {
		return
	}
	g.wrote = true
	g.decide(status)
	g.ResponseWriter.WriteHeader(status)
}

func (g *gzipWriter) Write(b []byte) (int, error) {
	if !g.wrote {
		if g.Header().Get("Content-Type") == "" {
			g.Header().Set("Content-Type", http.DetectContentType(b))
		}
		g.WriteHeader(http.StatusOK)
	}
	if g.compress {
		return g.gz.Write(b)
	}
	return g.ResponseWriter.Write(b)
}

func (g *gzipWriter) Flush() {
	if g.compress && g.gz != nil {
		_ = g.gz.Flush()
	}
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Close finishes the gzip stream and returns the writer to the pool.
func (g *gzipWriter) Close() {
	if g.compress && g.gz != nil {
		_ = g.gz.Close()
		gzipPool.Put(g.gz)
		g.gz = nil
	}
}
