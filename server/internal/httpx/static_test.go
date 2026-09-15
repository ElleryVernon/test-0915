package httpx

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestSPADocuments(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		t.Helper()
		full := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("index.html", "<html>shell</html>")
	write("study/index.html", "<html>study</html>")
	write("planner.html", "<html>planner</html>")
	write("_next/static/app.js", "console.log(1)")
	write("_next/static/app.js.br", "brotli-bytes")
	write("sw.js", "self.addEventListener('fetch', () => {})")
	spa := NewSPA(dir)
	get := func(path string, headers map[string]string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		spa.ServeHTTP(w, r)
		return w
	}
	for path, body := range map[string]string{"/": "shell", "/study": "study", "/study/": "study", "/planner": "planner", "/subjects/abc": "shell", "/flashcards": "shell"} {
		res := get(path, nil)
		if res.Code != 200 || res.Header().Get("ETag") == "" || res.Header().Get("Cache-Control") != "no-cache" || res.Header().Get("Content-Type") != "text/html; charset=utf-8" || !contains(res.Body.String(), body) {
			t.Fatalf("%s: %d %v %q", path, res.Code, res.Header(), res.Body.String())
		}
		if again := get(path, map[string]string{"If-None-Match": res.Header().Get("ETag")}); again.Code != http.StatusNotModified {
			t.Fatalf("%s: conditional request got %d", path, again.Code)
		}
	}
	if a, b := get("/study", nil).Header().Get("ETag"), get("/", nil).Header().Get("ETag"); a == b {
		t.Fatal("different documents must not share an ETag")
	}
	if res := get("/_next/static/app.js", map[string]string{"Accept-Encoding": "br"}); res.Code != 200 || res.Header().Get("Content-Encoding") != "br" || res.Body.String() != "brotli-bytes" || res.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" || res.Header().Get("Content-Type") != "text/javascript; charset=utf-8" {
		t.Fatalf("precompressed asset: %d %v %q", res.Code, res.Header(), res.Body.String())
	}
	if res := get("/_next/static/app.js", nil); res.Code != 200 || res.Header().Get("Content-Encoding") != "" || res.Body.String() != "console.log(1)" {
		t.Fatalf("identity asset: %d %v", res.Code, res.Header())
	}
	if res := get("/sw.js", nil); res.Header().Get("Cache-Control") != "no-cache, no-store, must-revalidate" {
		t.Fatalf("sw.js: %v", res.Header())
	}
	if res := get("/_next/static/missing.js", nil); res.Code != 404 {
		t.Fatalf("missing asset: %d", res.Code)
	}
	if res := get("/../index.html", nil); res.Code != 200 {
		t.Fatalf("path is cleaned: %d", res.Code)
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && (s == sub || indexOf(s, sub) >= 0))
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
