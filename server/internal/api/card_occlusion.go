package api

import (
	"bytes"
	"encoding/json"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"time"

	_ "golang.org/x/image/webp"
	"memoryz/server/internal/ai"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/store"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/cards/occlusion-preview", httpx.Methods{http.MethodPost: httpx.Deadline(aiTimeout, s.withUser(s.previewOcclusion, store.RoleSTUDENT))})
	})
}

// Inspect actual bytes, not a filename/MIME claim. DecodeConfig avoids allocating the bitmap.
func occlusionImageMIME(data []byte) (string, error) {
	if len(data) == 0 || len(data) > maxUploadBytes {
		return "", errEmptyOrTooBig
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width < 16 || cfg.Height < 16 || cfg.Width > 10000 || cfg.Height > 10000 || int64(cfg.Width)*int64(cfg.Height) > 36_000_000 {
		return "", errImageContent
	}
	mime := map[string]string{"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp"}[format]
	if mime == "" {
		return "", errImageContent
	}
	return mime, nil
}

func (s *Server) previewOcclusion(w http.ResponseWriter, r *http.Request, user store.User) error {
	data, _, err := readFile(r)
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	if err != nil {
		return err
	}
	mime, err := occlusionImageMIME(data)
	if err != nil {
		return err
	}
	if !s.ai.Available() {
		return ai.ErrUnavailable
	}
	ctx := r.Context()
	// Short user-scoped result reuse prevents an accidental repeated click paying twice.
	key := "occlusion:v1:" + user.ID + ":" + sha256Hex(data)
	if cached, ok, e := s.cache.Get(ctx, key); e == nil && ok {
		var result ai.OcclusionPreview
		if json.Unmarshal(cached, &result) == nil {
			httpx.OK(w, http.StatusOK, result)
			return nil
		}
	}
	release, locked, err := s.cache.Lock(ctx, key+":running", aiTimeout+time.Minute)
	if err != nil {
		return err
	}
	if !locked {
		return apierr.New(429, "이미 같은 이미지의 가림 위치를 찾고 있어요. 잠시 후 확인해 주세요.").Retry(10*time.Second, 5*time.Second)
	}
	defer release()
	// Another request may have completed between our first cache lookup and lease acquisition.
	if cached, ok, e := s.cache.Get(ctx, key); e == nil && ok {
		var result ai.OcclusionPreview
		if json.Unmarshal(cached, &result) == nil {
			httpx.OK(w, http.StatusOK, result)
			return nil
		}
	}
	if err := s.aiBudget(ctx, user.ID); err != nil {
		return err
	}
	result, err := ai.SuggestOcclusion(ctx, s.ai, data, mime)
	if err != nil {
		return err
	}
	if encoded, e := json.Marshal(result); e == nil {
		_ = s.cache.Set(ctx, key, encoded, 10*time.Minute)
	}
	httpx.OK(w, http.StatusOK, result)
	return nil
}
