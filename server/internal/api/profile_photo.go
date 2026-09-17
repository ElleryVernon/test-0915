package api

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png"
	"io"
	"mime"
	"net/http"

	"github.com/jackc/pgx/v5"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/store"
)

const maxProfilePhotoBytes = 5_000_000

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/profile/photo", httpx.Methods{
			http.MethodGet:    s.withUser(s.readProfilePhoto),
			http.MethodPut:    s.withUser(s.putProfilePhoto),
			http.MethodDelete: s.withUser(s.deleteProfilePhoto),
		})
	})
}

var errProfilePhoto = apierr.New(400, "JPG, PNG, WebP 사진을 선택해 주세요.")
var errProfilePhotoSize = apierr.New(413, "사진은 5MB 이하, 2,400만 화소 이하로 선택해 주세요.")

// At most two large raster decodes per process; do not let simultaneous photos
// consume the whole Cloud Run memory budget.
var profilePhotoSlots = make(chan struct{}, 2)

// Decode only bounded raster images, center-crop and re-encode them. This removes
// location/EXIF metadata, active content and oversized original files before storage.
func normalizeProfilePhoto(raw []byte, mediaType string) ([]byte, error) {
	if len(raw) == 0 || len(raw) > maxProfilePhotoBytes {
		return nil, errProfilePhotoSize
	}
	allowed := map[string]string{"image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp"}
	expected, ok := allowed[mediaType]
	if !ok || http.DetectContentType(raw) != mediaType {
		return nil, errProfilePhoto
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || format != expected {
		return nil, errProfilePhoto
	}
	if config.Width < 1 || config.Height < 1 || config.Width > 12000 || config.Height > 12000 || int64(config.Width)*int64(config.Height) > 24_000_000 {
		return nil, errProfilePhotoSize
	}
	original, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, errProfilePhoto
	}
	bounds := original.Bounds()
	side := min(bounds.Dx(), bounds.Dy())
	source := image.Rect(bounds.Min.X+(bounds.Dx()-side)/2, bounds.Min.Y+(bounds.Dy()-side)/2, bounds.Min.X+(bounds.Dx()+side)/2, bounds.Min.Y+(bounds.Dy()+side)/2)
	target := image.NewRGBA(image.Rect(0, 0, 512, 512))
	draw.Draw(target, target.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.CatmullRom.Scale(target, target.Bounds(), original, source, draw.Over, nil)
	var result bytes.Buffer
	if err := jpeg.Encode(&result, target, &jpeg.Options{Quality: 85}); err != nil {
		return nil, err
	}
	return result.Bytes(), nil
}

func (s *Server) ownProfilePhotoURL(ctx context.Context, userID string) (string, error) {
	var version string
	err := s.pool.QueryRow(ctx, `SELECT "version" FROM "ProfilePhoto" WHERE "userId"=$1`, userID).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return "/api/profile/photo?v=" + version, nil
}

func (s *Server) putProfilePhoto(w http.ResponseWriter, r *http.Request, user store.User) error {
	select {
	case profilePhotoSlots <- struct{}{}:
		defer func() { <-profilePhotoSlots }()
	default:
		return apierr.New(429, "사진 저장 요청이 많아요. 잠시 후 다시 시도해 주세요.")
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		return errProfilePhoto
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxProfilePhotoBytes+1))
	if err != nil {
		return errProfilePhotoSize
	}
	data, err := normalizeProfilePhoto(raw, mediaType)
	if err != nil {
		return err
	}
	version := sha256Hex(data)
	_, err = s.pool.Exec(r.Context(), `INSERT INTO "ProfilePhoto"("userId","version","data") VALUES($1,$2,$3) ON CONFLICT("userId") DO UPDATE SET "version"=EXCLUDED."version", "data"=EXCLUDED."data", "updatedAt"=now()`, user.ID, version, data)
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, map[string]string{"avatarUrl": "/api/profile/photo?v=" + version})
	return nil
}

// The endpoint has no caller-selected owner or object key. Even a copied URL only
// reads the authenticated account's photo, and private bytes never enter a public cache.
func (s *Server) readProfilePhoto(w http.ResponseWriter, r *http.Request, user store.User) error {
	var data []byte
	if err := s.pool.QueryRow(r.Context(), `SELECT "data" FROM "ProfilePhoto" WHERE "userId"=$1`, user.ID).Scan(&data); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return apierr.New(404, "등록한 프로필 사진이 없어요.")
		}
		return err
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, err := w.Write(data)
	return err
}

func (s *Server) deleteProfilePhoto(w http.ResponseWriter, r *http.Request, user store.User) error {
	if _, err := s.pool.Exec(r.Context(), `DELETE FROM "ProfilePhoto" WHERE "userId"=$1`, user.ID); err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, map[string]string{"avatarUrl": ""})
	return nil
}
