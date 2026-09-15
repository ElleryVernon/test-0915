package httpx

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// SPA serves a static web build (Next.js `output: 'export'`): real files with cache headers that
// match how they are named, precompressed variants (.br, .gz written at build time) negotiated by
// Accept-Encoding, and the shell (index.html, kept in memory with an ETag) for every other path so
// the client router owns it.
type SPA struct {
	dir  string
	mu   sync.Mutex
	docs map[string]document // HTML documents by path, kept in memory with an ETag
}

type document struct {
	body    []byte
	etag    string
	modTime time.Time
	loaded  time.Time
}

func init() {
	// Types Go's table lacks for a web app manifest and Next's route-tree text files.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
	_ = mime.AddExtensionType(".txt", "text/plain; charset=utf-8")
}

// NewSPA returns the handler for dir.
func NewSPA(dir string) *SPA { return &SPA{dir: dir, docs: map[string]document{}} }

// load returns an HTML document, re-reading the file when its modification time changed (a deploy
// replaces the directory; development rebuilds it in place). The stat is skipped for a second so a
// burst of requests costs one syscall.
func (s *SPA) load(file string) (document, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	doc := s.docs[file]
	if doc.body != nil && time.Since(doc.loaded) < time.Second {
		return doc, nil
	}
	st, err := os.Stat(file)
	if err != nil {
		return document{}, err
	}
	if doc.body == nil || !st.ModTime().Equal(doc.modTime) {
		body, err := os.ReadFile(file)
		if err != nil {
			return document{}, err
		}
		sum := sha256.Sum256(body)
		doc = document{body: body, etag: `"` + hex.EncodeToString(sum[:8]) + `"`, modTime: st.ModTime()}
	}
	doc.loaded = time.Now()
	s.docs[file] = doc
	return doc, nil
}

// serveDocument answers an HTML document from memory: no-cache with an ETag, so a returning client
// revalidates with one conditional request and receives 304 while the build is unchanged.
func (s *SPA) serveDocument(w http.ResponseWriter, r *http.Request, file string) {
	doc, err := s.load(file)
	if err != nil {
		// jitter: none — a 503 only on a broken image; the 1 s stat cache is local to each instance [site server/internal/httpx/static.go:75]
		http.Error(w, "web build missing", http.StatusServiceUnavailable)
		return
	}
	h := w.Header()
	h.Set("Cache-Control", "no-cache")
	h.Set("ETag", doc.etag)
	h.Set("Content-Type", "text/html; charset=utf-8")
	if r.Header.Get("If-None-Match") == doc.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	http.ServeContent(w, r, filepath.Base(file), doc.modTime, bytes.NewReader(doc.body))
}

func (s *SPA) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p := path.Clean("/" + r.URL.Path)
	if p != "/" {
		full := filepath.Join(s.dir, filepath.FromSlash(p))
		if st, err := os.Stat(full); err == nil && !st.IsDir() {
			if strings.HasSuffix(full, ".html") {
				s.serveDocument(w, r, full)
				return
			}
			w.Header().Set("Cache-Control", cacheControl(p))
			s.serveFile(w, r, full, st)
			return
		}
		// `next export` writes /study.html (or /study/index.html) for /study; deep links fall through to the shell.
		for _, candidate := range []string{full + ".html", filepath.Join(full, "index.html")} {
			if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
				s.serveDocument(w, r, candidate)
				return
			}
		}
		if path.Ext(p) != "" {
			http.NotFound(w, r)
			return
		}
	}
	s.serveDocument(w, r, filepath.Join(s.dir, "index.html"))
}

// serveFile prefers a precompressed sibling (name.br, then name.gz) when the client accepts it;
// the response keeps the original file's media type and a Vary so caches key on the encoding.
func (s *SPA) serveFile(w http.ResponseWriter, r *http.Request, full string, st os.FileInfo) {
	accept := r.Header.Get("Accept-Encoding")
	contentType := mime.TypeByExtension(filepath.Ext(full))
	for _, enc := range []struct{ name, ext string }{{"br", ".br"}, {"gzip", ".gz"}} {
		if !strings.Contains(accept, enc.name) {
			continue
		}
		f, err := os.Open(full + enc.ext)
		if err != nil {
			continue
		}
		defer f.Close()
		cst, err := f.Stat()
		if err != nil {
			continue
		}
		h := w.Header()
		h.Add("Vary", "Accept-Encoding")
		h.Set("Content-Encoding", enc.name)
		if contentType != "" {
			h.Set("Content-Type", contentType)
		}
		http.ServeContent(w, r, filepath.Base(full), cst.ModTime(), f)
		return
	}
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	http.ServeFile(w, r, full)
}

// jitter: none — each device revalidates on its own next navigation, and hashed chunks are immutable [site server/internal/httpx/static.go:154]
func cacheControl(p string) string {
	switch {
	case strings.HasPrefix(p, "/_next/static/"):
		return "public, max-age=31536000, immutable"
	case p == "/sw.js":
		return "no-cache, no-store, must-revalidate"
	case strings.HasSuffix(p, ".html"):
		return "no-cache"
	case strings.HasPrefix(p, "/fonts/") || strings.HasPrefix(p, "/pdfjs/"):
		return "public, max-age=604800"
	default:
		return "public, max-age=3600, stale-while-revalidate=86400"
	}
}
