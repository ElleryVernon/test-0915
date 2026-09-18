package api

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http/httptest"
	"strings"
	"testing"
)

func profilePNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	img.Set(0, 0, color.RGBA{255, 0, 0, 255})
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestProfilePhotoNormalization(t *testing.T) {
	raw := profilePNG(t, 160, 80)
	data, err := normalizeProfilePhoto(raw, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	config, err := jpeg.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width != 512 || config.Height != 512 {
		t.Fatalf("not a normalized JPEG: %v %v", config, err)
	}
	for _, tc := range []struct {
		raw  []byte
		mime string
	}{
		{[]byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`), "image/svg+xml"},
		{raw, "image/jpeg"}, {[]byte("not an image"), "image/png"},
		{make([]byte, maxProfilePhotoBytes+1), "image/png"}, {profilePNG(t, 12001, 1), "image/png"},
	} {
		if _, err := normalizeProfilePhoto(tc.raw, tc.mime); err == nil {
			t.Errorf("accepted invalid %s input", tc.mime)
		}
	}
}

func TestProfilePhotoOwnershipAndRemoval(t *testing.T) {
	h := newAIHarness(t, nil)
	raw := profilePNG(t, 100, 80)
	request := func(method, cookie, mime string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/profile/photo?userId="+h.student, bytes.NewReader(body))
		req.Header.Set("Cookie", cookie)
		req.Header.Set("Content-Type", mime)
		res := httptest.NewRecorder()
		h.handler.ServeHTTP(res, req)
		return res
	}
	if res := request("PUT", "", "image/png", raw); res.Code != 401 {
		t.Fatalf("anonymous upload %d", res.Code)
	}
	profilePhotoSlots <- struct{}{}
	profilePhotoSlots <- struct{}{}
	busy := request("PUT", h.cookie, "image/png", raw)
	<-profilePhotoSlots
	<-profilePhotoSlots
	if busy.Code != 429 {
		t.Fatalf("unbounded concurrent photo decode: %d", busy.Code)
	}
	res := request("PUT", h.cookie, "image/png", raw)
	photo := communityData(t, res, 200)["avatarUrl"].(string)
	boot := communityData(t, h.do("GET", "/api/bootstrap", nil), 200)
	if boot["profile"].(map[string]any)["avatarUrl"] != photo {
		t.Fatal("bootstrap missing avatar")
	}
	res = request("GET", h.cookie, "", nil)
	if res.Code != 200 || res.Header().Get("Cache-Control") != "private, no-store" || res.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("private photo response %d %v", res.Code, res.Header())
	}
	if _, err := jpeg.Decode(bytes.NewReader(res.Body.Bytes())); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := h.pool.Exec(ctx, `INSERT INTO "User"("id","name","nickname","role") VALUES('other-photo','other','other','PARENT')`); err != nil {
		t.Fatal(err)
	}
	other, _, err := h.s.auth.Create(ctx, "other-photo")
	if err != nil {
		t.Fatal(err)
	}
	if res = request("GET", strings.Split(other, ";")[0], "", nil); res.Code != 404 {
		t.Fatalf("copied owner URL exposed photo: %d", res.Code)
	}
	if res = request("PUT", h.cookie, "image/svg+xml", []byte("<svg/>")); res.Code != 400 {
		t.Fatal("SVG accepted")
	}
	communityData(t, h.do("DELETE", "/api/profile/photo", nil), 200)
	if res = request("GET", h.cookie, "", nil); res.Code != 404 {
		t.Fatalf("photo remained: %d", res.Code)
	}
	boot = communityData(t, h.do("GET", "/api/bootstrap", nil), 200)
	if boot["profile"].(map[string]any)["avatarUrl"] != nil {
		t.Fatal("deleted avatar URL persisted")
	}
}
