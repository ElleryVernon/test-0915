package api

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"memoryz/server/internal/auth"
	"memoryz/server/internal/cache"
	"memoryz/server/internal/config"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/store"
)

func occlusionPNG(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 32, 32))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func occlusionRequest(t *testing.T, data []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("file", "source.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.Write(data)
	_ = form.Close()
	r := httptest.NewRequest(http.MethodPost, "/api/cards/occlusion-preview", &body)
	r.Header.Set("Content-Type", form.FormDataContentType())
	return r
}
func TestOcclusionImageRejectsDisguisedFile(t *testing.T) {
	if mime, err := occlusionImageMIME(occlusionPNG(t)); err != nil || mime != "image/png" {
		t.Fatalf("%s %v", mime, err)
	}
	for _, data := range [][]byte{nil, []byte("%PDF-1.4"), []byte("<svg><script/></svg>"), []byte{137, 80, 78, 71, 13, 10, 26, 10}} {
		if _, err := occlusionImageMIME(data); err == nil {
			t.Fatal("non-image accepted")
		}
	}
}
func TestOcclusionAPIPreviewAuthenticationAndCache(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		body, _ := io.ReadAll(r.Body)
		if !bytes.Contains(body, []byte("image_url")) {
			t.Error("model did not receive image")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"finish_reason":"stop","message":{"tool_calls":[{"function":{"name":"memoryz_occlusion_preview","arguments":"{\"regions\":[{\"x\":10,\"y\":20,\"width\":20,\"height\":5,\"answer\":\"세포막\"}]}"}}]}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)
	}))
	defer upstream.Close()
	cfg := &config.Config{AuthSecret: strings.Repeat("s", 40), OpenRouterAPIKey: "synthetic", OpenRouterModel: "openai/test", OpenRouterEffort: "high", OpenRouterBaseURL: upstream.URL, AIRatePerMinute: 10, AIRatePerDay: 20, AIConcurrency: 1, PDFWorkers: 1}
	c := cache.NewMemory()
	defer c.Close()
	s := New(cfg, nil, c, auth.New(cfg, nil, c), nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	mux := http.NewServeMux()
	s.Mount(mux)
	r := occlusionRequest(t, occlusionPNG(t))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, r)
	if rec.Code != 401 || calls.Load() != 0 {
		t.Fatalf("unauthenticated preview reached AI: %d calls %d", rec.Code, calls.Load())
	}
	user := store.User{ID: "owned-test", Role: store.RoleSTUDENT}
	for i := 0; i < 2; i++ {
		rec = httptest.NewRecorder()
		err := s.previewOcclusion(rec, occlusionRequest(t, occlusionPNG(t)), user)
		if err != nil || rec.Code != 200 || !strings.Contains(rec.Body.String(), "세포막") {
			t.Fatalf("preview %d %s %v", rec.Code, rec.Body.String(), err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("repeated image paid %d times", calls.Load())
	}
	rec = httptest.NewRecorder()
	httpx.Handler(func(w http.ResponseWriter, r *http.Request) error { return s.previewOcclusion(w, r, user) }).ServeHTTP(rec, occlusionRequest(t, []byte("fake.png")))
	if rec.Code != 400 || calls.Load() != 1 {
		t.Fatalf("invalid image called AI: %d calls %d", rec.Code, calls.Load())
	}
}

// The shared harness creates a scratch database after checking the dedicated loopback DB target.
func TestCardImageUploadSkipsOCR(t *testing.T) {
	h := newAIHarness(t, nil)
	r := occlusionRequest(t, occlusionPNG(t))
	r.URL.Path = "/api/upload"
	r.URL.RawQuery = "purpose=card-image"
	r.Header.Set("Cookie", h.cookie+"; "+auth.SignedInCookie+"=1")
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, r)
	if rec.Code != 200 || h.model.calls.Load() != 0 {
		t.Fatalf("card image upload %d %s paid calls %d", rec.Code, rec.Body.String(), h.model.calls.Load())
	}
	data := bodyOf(rec)["data"].(map[string]any)
	if data["type"] != "IMAGE" || data["content"] != "" || data["extraction"] != "manual" {
		t.Fatalf("unexpected card image result: %v", data)
	}
	var owner string
	if err := h.pool.QueryRow(context.Background(), `SELECT "userId" FROM "Upload" WHERE "id"=$1`, data["uploadId"]).Scan(&owner); err != nil || owner != h.student {
		t.Fatalf("image ownership %q %v", owner, err)
	}
	for _, payload := range [][]byte{[]byte("%PDF-1.4"), []byte("plain source text")} {
		r = occlusionRequest(t, payload)
		r.URL.Path = "/api/upload"
		r.URL.RawQuery = "purpose=card-image"
		r.Header.Set("Cookie", h.cookie+"; "+auth.SignedInCookie+"=1")
		rec = httptest.NewRecorder()
		h.handler.ServeHTTP(rec, r)
		if rec.Code != 400 || h.model.calls.Load() != 0 {
			t.Fatalf("non-image accepted: %d calls %d", rec.Code, h.model.calls.Load())
		}
	}
}
