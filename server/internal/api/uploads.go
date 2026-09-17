package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/text/unicode/norm"

	"memoryz/server/internal/ai"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/blob"
	"memoryz/server/internal/db"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/learning"
	"memoryz/server/internal/logx"
	"memoryz/server/internal/pdfx"
	"memoryz/server/internal/store"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		// An image upload waits for OCR, one model call bounded by ai.ProviderTimeout (175 s), so the
		// upload shares the AI handlers' deadline; 90 s cut a measured 91 s OCR off (review, 2026-09-16).
		// jitter: none — a per-request deadline (aiTimeout 180 s) syncs no retry; the client's 190 s sits above it [site server/internal/api/uploads.go:36]
		mux.Handle("/api/upload", httpx.Methods{http.MethodPost: httpx.Deadline(aiTimeout, s.withUser(s.handleUpload, store.RoleSTUDENT))})
		mux.Handle("/api/uploads/{id}", httpx.Methods{http.MethodGet: s.withUser(s.readUpload)})
		mux.Handle("/api/uploads/{id}/images/{imageId}", httpx.Methods{http.MethodGet: s.withUser(s.readUploadImage)})
	})
}

const (
	// jitter: none — uploadTTL is a per-user age cutoff read on that user's next upload; nothing fires when it passes
	maxUploadBytes = 10_000_000
	maxText        = learning.MaxSourceRunes
	uploadTTL      = 24 * time.Hour
	pdfWait        = 30 * time.Second
)

var (
	uploadIDShape    = regexp.MustCompile(`^[a-f0-9-]{36}$`)
	errUploadTooBig  = apierr.New(413, "파일은 10MB 이하로 올려 주세요.")
	errNoFile        = apierr.New(400, "파일을 선택해 주세요.")
	errEmptyOrTooBig = apierr.New(413, "빈 파일이거나 10MB를 초과했어요.")
	errNotUTF8       = apierr.New(400, "UTF-8 텍스트 파일을 올려 주세요.")
	errPDFUnreadable = apierr.New(422, "PDF를 읽지 못했어요. 암호를 해제하거나 다른 파일로 올려 주세요.")
	errImageContent  = apierr.New(400, "이미지 파일 내용을 확인해 주세요.")
	errFileType      = apierr.New(415, "TXT, PDF, PNG, JPG, WebP 파일을 올려 주세요.")
	errTextTooLong   = apierr.New(413, "본문이 너무 길어요. 자료를 나누어 올려 주세요.")
	// The refusal proves there are 30 s of queued extraction ahead, so coming back sooner re-enters
	// the same queue with another body of up to 10 MB; about 20 refusals spread over 30 s make at
	// most 0.7 re-uploads a second over a classroom uplink.
	// jitter: retry-after 30 s + U[0,30 s) on a pdfSlot refusal (the queue policy is on pdfSlot)
	errUploadsBusy     = apierr.New(429, "지금 올리는 파일이 많아요. 잠시 후 다시 시도해 주세요.").Retry(pdfWait, pdfWait)
	errFileNotFound    = apierr.New(404, "파일을 찾을 수 없어요.")
	errFileGone        = apierr.WithCode(410, "원본 파일을 찾을 수 없어요. 본문은 그대로 볼 수 있고, 파일은 다시 올려야 해요.", "UPLOAD_MISSING")
	errPictureNotFound = apierr.New(404, "그림을 찾을 수 없어요.")
	warnNoText         = "추출된 본문이 없어요. 학습 내용을 직접 입력해 주세요."
)

// textHash identifies extracted text, so a material can tell whether it still holds it unedited.
func textHash(text string) string {
	sum := sha256.Sum256([]byte(norm.NFC.String(text)))
	return hex.EncodeToString(sum[:])
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

type uploadResponse struct {
	UploadID   string      `json:"uploadId"`
	URL        string      `json:"url"`
	Content    string      `json:"content"`
	Type       string      `json:"type"`
	Title      string      `json:"title"`
	Pages      *int32      `json:"pages"`
	PageBreaks []int32     `json:"pageBreaks"`
	Extraction string      `json:"extraction"`
	Images     []imageMeta `json:"images"`
	Warning    string      `json:"warning,omitempty"`
}

func readFile(r *http.Request) ([]byte, *multipart.FileHeader, error) {
	if n, _ := strconv.Atoi(r.Header.Get("Content-Length")); n > 11_000_000 {
		return nil, nil, errUploadTooBig
	}
	r.Body = http.MaxBytesReader(nil, r.Body, 12_000_000)
	if err := r.ParseMultipartForm(12 << 20); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, nil, errUploadTooBig
		}
		return nil, nil, errNoFile
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		return nil, nil, errNoFile
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxUploadBytes+1))
	if err != nil {
		return nil, nil, errNoFile
	}
	if len(data) == 0 || len(data) > maxUploadBytes {
		return nil, nil, errEmptyOrTooBig
	}
	return data, header, nil
}

// handleUpload stores a file, reads its text (and a PDF's pages and images) and answers what a
// material can be made from.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request, user store.User) error {
	data, header, err := readFile(r)
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	if err != nil {
		return err
	}
	purpose := r.URL.Query().Get("purpose")
	if purpose != "" && purpose != "card-image" {
		return apierr.New(400, "파일 사용 목적을 확인해 주세요.")
	}
	cardImage := purpose == "card-image"
	if cardImage {
		if _, err := occlusionImageMIME(data); err != nil {
			return err
		}
	}
	ctx := r.Context()
	extension := strings.ToLower(strings.TrimPrefix(filepath.Ext(header.Filename), "."))
	var (
		kind, mime, content, extraction, warning string
		pages                                    *int32
		pageBreaks                               = []int32{}
		images                                   []pdfx.Image
	)
	switch {
	case extension == "txt":
		if bytes.IndexByte(data, 0) >= 0 {
			return errNotUTF8
		}
		kind, mime = "TXT", "text/plain; charset=utf-8"
		content = norm.NFC.String(strings.ReplaceAll(strings.ReplaceAll(string(data), "\r\n", "\n"), "\r", "\n"))
		content = strings.TrimPrefix(content, string(rune(0xFEFF)))
		extraction = "text"
	case extension == "pdf" && bytes.HasPrefix(data, []byte("%PDF-")):
		kind, mime = "PDF", "application/pdf"
		release, err := s.pdfSlot(ctx)
		if err != nil {
			return err
		}
		opts := pdfx.Options{}
		if s.ai.Available() {
			opts.OCR = func(ctx context.Context, png []byte) (string, error) {
				return ai.ExtractImageText(ctx, s.ai, png, "image/png")
			}
		}
		result, err := pdfx.Extract(ctx, data, opts)
		release()
		if err != nil {
			// A refused or failed model call (the admission queue's 429, a provider 5xx, a deadline)
			// is not an unreadable PDF: its status and retry hint reach the client unchanged.
			if e, ok := apierr.From(err); ok && (e.Status == http.StatusTooManyRequests || e.Status >= 500) {
				return err
			}
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
				return err
			}
			logx.From(ctx).Warn("pdf extraction failed", slog.String("error", err.Error()))
			return errPDFUnreadable
		}
		content, extraction, warning = result.Text, result.Method, result.Warning
		n := int32(result.Pages)
		pages = &n
		for _, offset := range result.PageBreaks {
			pageBreaks = append(pageBreaks, int32(offset))
		}
		images = result.Images
	case extension == "png" || extension == "jpg" || extension == "jpeg" || extension == "webp":
		png := bytes.HasPrefix(data, []byte{137, 80, 78, 71, 13, 10, 26, 10})
		jpeg := len(data) > 2 && data[0] == 255 && data[1] == 216 && data[2] == 255
		webp := len(data) > 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP"
		if !png && !jpeg && !webp {
			return errImageContent
		}
		kind = "IMAGE"
		switch {
		case png:
			mime = "image/png"
		case jpeg:
			mime = "image/jpeg"
		default:
			mime = "image/webp"
		}
		if s.ai.Available() && !cardImage {
			// jitter: admission OCR here and on PDF pages goes through Provider.JSON: 16 AI slots, 30 s wait, refusal Retry-After 10 s + U[0,10 s) [site server/internal/api/uploads.go:183]
			text, err := ai.ExtractImageText(ctx, s.ai, data, mime)
			if err != nil {
				return err
			}
			content = norm.NFC.String(text)
		}
		extraction = "manual"
		if content != "" {
			extraction = "image-ocr"
		}
	default:
		return errFileType
	}
	if length(content) > maxText {
		return errTextTooLong
	}
	// jitter: none — per user, on demand: only this uploader's own day-old unlinked uploads [site server/internal/api/uploads.go:199]
	if err := s.collectUnlinked(ctx, user.ID); err != nil {
		return err
	}
	uploadID := ids.New()
	// Objects first, rows second: a failed transaction leaves nothing the API can reach, and the
	// objects are removed right away (or by the daily sweep).
	if err := s.blobs.Put(ctx, blob.UploadKey(uploadID), mime, data); err != nil {
		return err
	}
	imageIDs := make([]string, len(images))
	for i, image := range images {
		imageIDs[i] = ids.New()
		if err := s.blobs.Put(ctx, blob.ImageKey(uploadID, imageIDs[i]), image.Mime, image.Data); err != nil {
			s.dropBlobs(ctx, uploadID)
			return err
		}
	}
	err = db.Tx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if err := q.CreateUpload(ctx, store.CreateUploadParams{
			ID: uploadID, UserID: user.ID, Mime: mime, Name: truncate(header.Filename, 200), Size: int32(len(data)), Sha256: ptr(sha256Hex(data)),
			Pages: pages, PageBreaks: pageBreaks, Extraction: ptr(extraction), TextHash: ptr(textHash(content)),
		}); err != nil {
			return err
		}
		for i, image := range images {
			if err := q.CreateUploadImage(ctx, store.CreateUploadImageParams{
				ID: imageIDs[i], UploadID: uploadID, Page: int32(image.Page), Order: int32(image.Order), Paragraph: int32(image.Paragraph), Anchor: int32(image.Anchor),
				X: image.Box.X, Y: image.Box.Y, W: image.Box.W, H: image.Box.H, Width: int32(image.Width), Height: int32(image.Height), Mime: image.Mime, Context: image.Context,
			}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		s.dropBlobs(ctx, uploadID)
		return err
	}
	metas, err := s.q.ListUploadImages(ctx, uploadID)
	if err != nil {
		return err
	}
	out := uploadResponse{UploadID: uploadID, URL: uploadURL(uploadID), Content: content, Type: kind, Title: truncate(strings.TrimSuffix(header.Filename, filepath.Ext(header.Filename)), 200), Pages: pages, PageBreaks: pageBreaks, Extraction: extraction, Images: []imageMeta{}, Warning: warning}
	for _, meta := range metas {
		out.Images = append(out.Images, imageMetaOf(uploadID, meta))
	}
	if out.Warning == "" && content == "" && !cardImage {
		out.Warning = warnNoText
	}
	httpx.OK(w, http.StatusOK, out)
	return nil
}

func truncate(s string, max int) string {
	runes := []rune(s)
	if len(runes) > max {
		return string(runes[:max])
	}
	return s
}

// pdfSlot bounds concurrent PDF extractions per instance; a queue that outlasts pdfWait answers 429
// with a [30 s, 60 s) hint. A waiter whose client has gone gives up its place: an abandoned upload
// cannot be replayed (every POST gets a new upload id), so holding the place would only feed the
// next wave of refusals.
// jitter: admission 30 s queue wait; refusal Retry-After 30 s + U[0,30 s); a waiter whose client left gives up its place [site server/internal/api/uploads.go:262]
func (s *Server) pdfSlot(ctx context.Context) (func(), error) {
	timer := time.NewTimer(pdfWait)
	defer timer.Stop()
	select {
	case s.pdfSlots <- struct{}{}:
		return func() { <-s.pdfSlots }, nil
	case <-timer.C:
		return nil, errUploadsBusy
	case <-httpx.ClientGone(ctx):
		return nil, context.Canceled
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// collectUnlinked removes uploads a day old that no material or card uses (abandoned sheets).
func (s *Server) collectUnlinked(ctx context.Context, userID string) error {
	stale, err := s.q.ListStaleUnlinkedUploads(ctx, store.ListStaleUnlinkedUploadsParams{UserID: userID, CreatedAt: s.now().Add(-uploadTTL)})
	if err != nil || len(stale) == 0 {
		return err
	}
	urls := make([]string, 0, len(stale))
	for _, id := range stale {
		urls = append(urls, uploadURL(id))
	}
	used := map[string]bool{}
	cardImages, err := s.q.ListCardImagesIn(ctx, store.ListCardImagesInParams{UserID: userID, Urls: urls})
	if err != nil {
		return err
	}
	for _, image := range cardImages {
		if image != nil {
			used[*image] = true
		}
	}
	materialURLs, err := s.q.ListMaterialUrlsIn(ctx, store.ListMaterialUrlsInParams{UserID: userID, Urls: urls})
	if err != nil {
		return err
	}
	for _, u := range materialURLs {
		if u != nil {
			used[*u] = true
		}
	}
	unused := []string{}
	for _, id := range stale {
		if !used[uploadURL(id)] {
			unused = append(unused, id)
		}
	}
	if len(unused) == 0 {
		return nil
	}
	if err := s.q.DeleteUploads(ctx, store.DeleteUploadsParams{UserID: userID, Ids: unused}); err != nil {
		return err
	}
	for _, id := range unused {
		s.dropBlobs(ctx, id)
	}
	return nil
}

func fileHeaders(h http.Header, etag string) {
	h.Set("ETag", etag)
	// jitter: none — the bytes under an id never change, so a year of private caching is correct [site server/internal/api/uploads.go:322]
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
}

// migrateLegacy copies a file written by an earlier version (on disk) into the blob store the
// first time it is asked for.
func (s *Server) migrateLegacy(ctx context.Context, upload store.GetOwnedUploadRow) []byte {
	dirs := append([]string{}, s.cfg.UploadLegacyDirs...)
	if cwd, err := os.Getwd(); err == nil {
		dirs = append(dirs, filepath.Join(cwd, ".data", "uploads"))
	}
	for _, dir := range dirs {
		data, err := os.ReadFile(filepath.Join(dir, upload.ID))
		if err != nil || len(data) != int(upload.Size) {
			continue
		}
		if err := s.blobs.Put(ctx, blob.UploadKey(upload.ID), upload.Mime, data); err != nil {
			logx.From(ctx).Warn("legacy upload not copied", slog.String("uploadId", upload.ID), slog.String("error", err.Error()))
			return data
		}
		_ = s.q.SetUploadSha(ctx, store.SetUploadShaParams{ID: upload.ID, Sha256: ptr(sha256Hex(data))})
		return data
	}
	return nil
}

func (s *Server) readUpload(w http.ResponseWriter, r *http.Request, user store.User) error {
	id := r.PathValue("id")
	if !uploadIDShape.MatchString(id) {
		return errFileNotFound
	}
	ctx := r.Context()
	upload, err := s.q.GetOwnedUpload(ctx, store.GetOwnedUploadParams{ID: id, UserID: user.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return errFileNotFound
	}
	if err != nil {
		return err
	}
	// The object is streamed; only a file whose hash was never recorded (legacy rows) is read whole,
	// once, to compute it.
	var (
		body          io.Reader
		size          int64
		digest        string
		selectedPages []int
	)
	if r.URL.Query().Has("pages") {
		selectedPages, err = requestedPDFPages(r.URL.Query().Get("pages"), upload.Mime)
		if err != nil {
			return err
		}
	}
	if upload.Sha256 != nil {
		digest = *upload.Sha256
	}
	obj, err := s.blobs.Get(ctx, blob.UploadKey(id))
	switch {
	case errors.Is(err, blob.ErrNotFound):
		data := s.migrateLegacy(ctx, upload)
		if data == nil {
			return errFileGone
		}
		if digest == "" {
			digest = sha256Hex(data)
			_ = s.q.SetUploadSha(ctx, store.SetUploadShaParams{ID: id, Sha256: &digest})
		}
		body, size = bytes.NewReader(data), int64(len(data))
	case err != nil:
		return err
	case digest == "":
		defer obj.Close()
		data, err := io.ReadAll(obj)
		if err != nil {
			return err
		}
		digest = sha256Hex(data)
		_ = s.q.SetUploadSha(ctx, store.SetUploadShaParams{ID: id, Sha256: &digest})
		body, size = bytes.NewReader(data), int64(len(data))
	default:
		defer obj.Close()
		body, size = obj, obj.Size
	}
	variant := digest
	if len(selectedPages) > 0 {
		variant += "-pages-v1-" + r.URL.Query().Get("pages")
	}
	etag := `"` + variant + `"`
	fileHeaders(w.Header(), etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return nil
	}
	if len(selectedPages) > 0 {
		data, readErr := io.ReadAll(io.LimitReader(body, pdfx.MaxBytes+1))
		if readErr != nil {
			return readErr
		}
		pageCtx, cancel := context.WithTimeout(ctx, pdfWait)
		defer cancel()
		data, err = pdfx.SelectPages(pageCtx, data, selectedPages)
		if errors.Is(err, pdfx.ErrPageSelection) {
			return errPDFPages
		}
		if err != nil {
			return err
		}
		body, size = bytes.NewReader(data), int64(len(data))
		w.Header().Set("X-Memoryz-Source-Pages", r.URL.Query().Get("pages"))
	}
	disposition := "inline"
	if r.URL.Query().Get("download") == "1" {
		disposition = "attachment"
	}
	w.Header().Set("Content-Type", upload.Mime)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Content-Disposition", disposition+"; filename*=UTF-8''"+encodeURIComponent(upload.Name))
	w.Header().Set("Accept-Ranges", "none")
	w.WriteHeader(http.StatusOK)
	_, err = io.Copy(w, body)
	return err
}

func (s *Server) readUploadImage(w http.ResponseWriter, r *http.Request, user store.User) error {
	uploadID, imageID := r.PathValue("id"), r.PathValue("imageId")
	if !uploadIDShape.MatchString(uploadID) {
		return errPictureNotFound
	}
	ctx := r.Context()
	image, err := s.q.GetOwnedUploadImage(ctx, store.GetOwnedUploadImageParams{ID: imageID, UploadID: uploadID, UserID: user.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return errPictureNotFound
	}
	if err != nil {
		return err
	}
	etag := `"` + image.ID + `"`
	fileHeaders(w.Header(), etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return nil
	}
	obj, err := s.blobs.Get(ctx, blob.ImageKey(uploadID, imageID))
	if errors.Is(err, blob.ErrNotFound) {
		return errPictureNotFound
	}
	if err != nil {
		return err
	}
	defer obj.Close()
	w.Header().Set("Content-Type", image.Mime)
	w.Header().Set("Content-Length", strconv.FormatInt(obj.Size, 10))
	w.WriteHeader(http.StatusOK)
	_, err = io.Copy(w, obj)
	return err
}

// encodeURIComponent escapes like JavaScript's function of the same name.
func encodeURIComponent(s string) string {
	const keep = "-_.!~*'()"
	var b strings.Builder
	for _, c := range []byte(s) {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || strings.IndexByte(keep, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteString("%" + strings.ToUpper(hex.EncodeToString([]byte{c})))
	}
	return b.String()
}
