package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/blob"
	"memoryz/server/internal/db"
	"memoryz/server/internal/demo"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/jsonx"
	"memoryz/server/internal/learning"
	"memoryz/server/internal/logx"
	"memoryz/server/internal/store"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/materials", httpx.Methods{http.MethodPost: s.withUser(s.createMaterial, store.RoleSTUDENT)})
		mux.Handle("/api/materials/sample", httpx.Methods{http.MethodPost: s.withUser(s.createSampleMaterial, store.RoleSTUDENT)})
		mux.Handle("/api/materials/{id}", httpx.Methods{
			http.MethodGet:    s.withUser(s.getMaterial, store.RoleSTUDENT),
			http.MethodPatch:  s.withUser(s.patchMaterial, store.RoleSTUDENT),
			http.MethodDelete: s.withUser(s.deleteMaterial, store.RoleSTUDENT),
		})
	})
}

var (
	errMaterialNotFound = apierr.New(404, "자료를 찾을 수 없어요.")
	errExternalURL      = apierr.New(400, "이 앱에 업로드한 자료만 연결할 수 있어요.")
	errUploadNotFound   = apierr.New(404, "업로드한 자료를 찾을 수 없어요.")
	errUploadLinked     = apierr.New(409, "이미 다른 자료에 쓰인 파일이에요. 파일을 다시 올려 주세요.")
)

func typeOfMime(mime string) string {
	switch {
	case mime == "application/pdf":
		return "PDF"
	case strings.HasPrefix(mime, "image/"):
		return "IMAGE"
	default:
		return "TXT"
	}
}

func (s *Server) createMaterial(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		SubjectID string  `json:"subjectId"`
		Title     string  `json:"title"`
		Content   string  `json:"content"`
		Type      string  `json:"type"`
		URL       *string `json:"url"`
		UploadID  *string `json:"uploadId"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	v.id(in.SubjectID)
	in.Title = v.text(in.Title, 200)
	v.bounded(in.Content, learning.MaxSourceRunes)
	v.enum(in.Type, "TXT", "PDF", "IMAGE", "txt", "pdf", "image")
	if in.URL != nil {
		v.bounded(*in.URL, 2000)
	}
	if in.UploadID != nil {
		v.bounded(*in.UploadID, 64)
	}
	if err := v.result(); err != nil {
		return err
	}
	ctx := r.Context()
	if _, err := s.ownedSubject(ctx, user, in.SubjectID); err != nil {
		return err
	}
	if in.URL != nil && !strings.HasPrefix(*in.URL, "/api/uploads/") {
		return errExternalURL
	}
	uploadID := ""
	if in.UploadID != nil {
		uploadID = *in.UploadID
	} else if in.URL != nil {
		parts := strings.Split(*in.URL, "/")
		uploadID = parts[len(parts)-1]
	}
	params := store.CreateMaterialParams{ID: ids.New(), UserID: user.ID, SubjectID: in.SubjectID, Title: in.Title, Content: in.Content, Type: strings.ToUpper(in.Type), PageBreaks: []int32{}, Extraction: ptr("manual")}
	if uploadID != "" {
		upload, err := s.q.GetOwnedUploadWithMaterial(ctx, store.GetOwnedUploadWithMaterialParams{ID: uploadID, UserID: user.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			return errUploadNotFound
		}
		if err != nil {
			return err
		}
		if upload.MaterialID != nil {
			return errUploadLinked
		}
		// The file decides the type; page offsets hold only while the text is the one read from it.
		unedited := upload.TextHash != nil && textHash(in.Content) == *upload.TextHash
		params.Type = typeOfMime(upload.Mime)
		params.UploadID = &upload.ID
		params.Url = ptr(uploadURL(upload.ID))
		if unedited {
			params.PageBreaks = upload.PageBreaks
			if params.PageBreaks == nil {
				params.PageBreaks = []int32{}
			}
			params.Extraction = upload.Extraction
		}
	}
	material, err := s.q.CreateMaterial(ctx, params)
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusCreated, materialOf(material))
	return nil
}

func ptr(s string) *string { return &s }

// createSampleMaterial copies the sample chapter (demo.Sample) into the account so a new learner
// can try questions, an essay and card generation without uploading anything. It is idempotent:
// a second call answers 200 with the material made before, and nothing is duplicated.
func (s *Server) createSampleMaterial(w http.ResponseWriter, r *http.Request, user store.User) error {
	sample := demo.Sample()
	ctx := r.Context()
	type answer struct {
		Material  materialRow       `json:"material"`
		Questions []questionRow     `json:"questions"`
		Essays    []essayRow        `json:"essays"`
		Created   bool              `json:"created"`
		Lesson    map[string]string `json:"lesson"`
	}
	var out answer
	err := db.Tx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "sample:"+user.ID); err != nil {
			return err
		}
		prepareLesson := func() error {
			var questionID string
			if err := tx.QueryRow(ctx, `SELECT "id" FROM "Question" WHERE "userId"=$1 AND "materialId"=$2 AND "prompt"=$3 ORDER BY "id" LIMIT 1`, user.ID, out.Material.ID, sample.Questions[0].Prompt).Scan(&questionID); err != nil {
				return err
			}
			var cardID string
			// One starter card per owned question, including concurrent/retried starts.
			// Preserve edited content and review history when the learner returns.
			if err := tx.QueryRow(ctx, `INSERT INTO "Card" ("id","userId","subjectId","materialId","front","back","type","sourceQuestionId","sourceKind") VALUES($1,$2,$3,$4,$5,$6,'CONCEPT',$7,'STARTER') ON CONFLICT ("userId","sourceQuestionId","sourceKind") DO UPDATE SET "deleted"=false RETURNING "id"`, ids.New(), user.ID, out.Material.SubjectID, out.Material.ID, "탈분극이 일어날 때 어떤 이온이 어디로 이동할까요?", "나트륨 이온이 세포 안으로 들어와요.\n그 결과 세포막 안쪽의 전위가 상승해요.", questionID).Scan(&cardID); err != nil {
				return err
			}
			out.Lesson = map[string]string{"questionId": questionID, "cardId": cardID}
			return nil
		}
		existing, err := q.GetOwnedSampleMaterial(ctx, user.ID)
		if err == nil {
			out = answer{Material: materialOf(existing), Questions: []questionRow{}, Essays: []essayRow{}}
			return prepareLesson()
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		subject, err := q.GetOwnedSubjectByName(ctx, store.GetOwnedSubjectByNameParams{UserID: user.ID, Name: sample.Subject})
		if errors.Is(err, pgx.ErrNoRows) {
			subject, err = q.CreateSubject(ctx, store.CreateSubjectParams{ID: ids.New(), UserID: user.ID, Name: sample.Subject})
		}
		if err != nil {
			return err
		}
		material, err := q.CreateMaterial(ctx, store.CreateMaterialParams{ID: ids.New(), UserID: user.ID, SubjectID: subject.ID, Title: sample.Title, Content: sample.Content, Type: "TXT", PageBreaks: []int32{}, Extraction: ptr("sample")})
		if err != nil {
			return err
		}
		out = answer{Material: materialOf(material), Questions: []questionRow{}, Essays: []essayRow{}, Created: true}
		for _, item := range sample.Questions {
			row, err := q.CreateQuestion(ctx, store.CreateQuestionParams{ID: ids.New(), UserID: user.ID, SubjectID: subject.ID, MaterialID: material.ID, Prompt: item.Prompt, Options: item.Options, Answer: int32(item.Answer), Explanation: item.Explanation, Citation: item.Citation, Past: item.Past, Future: item.Future})
			if err != nil {
				return err
			}
			out.Questions = append(out.Questions, questionOf(row))
		}
		for _, item := range sample.Essays {
			row, err := q.CreateEssay(ctx, store.CreateEssayParams{ID: ids.New(), UserID: user.ID, SubjectID: subject.ID, MaterialID: material.ID, Prompt: item.Prompt, Keywords: item.Keywords, Distractors: item.Distractors, ModelAnswer: item.ModelAnswer, Citation: item.Citation})
			if err != nil {
				return err
			}
			out.Essays = append(out.Essays, essayOf(row))
		}
		return prepareLesson()
	})
	if err != nil {
		return err
	}
	status := http.StatusOK
	if out.Created {
		status = http.StatusCreated
	}
	httpx.OK(w, status, out)
	return nil
}

// materialDetail is GET /materials/:id — the row with the file's page count and located images.
type materialDetail struct {
	ID            string      `json:"id"`
	UserID        string      `json:"userId"`
	SubjectID     string      `json:"subjectId"`
	Title         string      `json:"title"`
	Content       string      `json:"content"`
	Type          string      `json:"type"`
	URL           *string     `json:"url,omitempty"`
	UploadID      *string     `json:"uploadId"`
	PageBreaks    []int32     `json:"pageBreaks"`
	Extraction    *string     `json:"extraction"`
	CreatedAt     jsonx.Time  `json:"createdAt"`
	Pages         *int32      `json:"pages"`
	Images        []imageMeta `json:"images"`
	ContentLength int         `json:"contentLength"`
	Excerpt       string      `json:"excerpt"`
	ContentHash   string      `json:"contentHash"`
}

func (s *Server) ownedMaterial(r *http.Request, user store.User) (store.Material, error) {
	material, err := s.q.GetOwnedMaterial(r.Context(), store.GetOwnedMaterialParams{ID: r.PathValue("id"), UserID: user.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return store.Material{}, errMaterialNotFound
	}
	return material, err
}

func (s *Server) getMaterial(w http.ResponseWriter, r *http.Request, user store.User) error {
	material, err := s.ownedMaterial(r, user)
	if err != nil {
		return err
	}
	row := materialOf(material)
	detail := materialDetail{ContentLength: row.ContentLength, Excerpt: row.Excerpt, ContentHash: row.ContentHash, ID: row.ID, UserID: row.UserID, SubjectID: row.SubjectID, Title: row.Title, Content: row.Content, Type: row.Type, URL: row.URL, UploadID: row.UploadID, PageBreaks: row.PageBreaks, Extraction: row.Extraction, CreatedAt: row.CreatedAt, Images: []imageMeta{}}
	if material.UploadID != nil {
		upload, err := s.q.GetUploadMeta(r.Context(), *material.UploadID)
		if err == nil {
			detail.Pages = upload.Pages
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		images, err := s.q.ListUploadImages(r.Context(), *material.UploadID)
		if err != nil {
			return err
		}
		for _, image := range images {
			detail.Images = append(detail.Images, imageMetaOf(*material.UploadID, image))
		}
	}
	httpx.OK(w, http.StatusOK, detail)
	return nil
}

func (s *Server) patchMaterial(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		Title   *string `json:"title"`
		Content *string `json:"content"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	in.Title = v.optText(in.Title, 200)
	if in.Content != nil {
		v.bounded(*in.Content, learning.MaxSourceRunes)
	}
	if err := v.result(); err != nil {
		return err
	}
	material, err := s.ownedMaterial(r, user)
	if err != nil {
		return err
	}
	var snapshot bool
	if err := s.pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM "GenerationSources" WHERE "materialId"=$1)`, material.ID).Scan(&snapshot); err != nil {
		return err
	}
	if snapshot {
		return errSnapshotImmutable
	}
	params := store.UpdateMaterialParams{ID: material.ID, Title: in.Title, Content: in.Content}
	if in.Content != nil {
		// Editing the text drops the page offsets unless the file's text was put back verbatim.
		params.SetPages = true
		params.PageBreaks = []int32{}
		params.Extraction = ptr("manual")
		// The sample chapter stays recognisable after an edit, so POST /api/materials/sample never
		// makes a second copy for someone who changed the first.
		if material.Extraction != nil && *material.Extraction == "sample" {
			params.Extraction = material.Extraction
		}
		if material.UploadID != nil {
			upload, err := s.q.GetUploadMeta(r.Context(), *material.UploadID)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if err == nil && upload.TextHash != nil && textHash(*in.Content) == *upload.TextHash {
				params.PageBreaks = upload.PageBreaks
				if params.PageBreaks == nil {
					params.PageBreaks = []int32{}
				}
				params.Extraction = upload.Extraction
			}
		}
	}
	updated, err := s.q.UpdateMaterial(r.Context(), params)
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, materialOf(updated))
	return nil
}

// deleteMaterial removes the material and, with it, the file, its bytes and its images.
func (s *Server) deleteMaterial(w http.ResponseWriter, r *http.Request, user store.User) error {
	material, err := s.ownedMaterial(r, user)
	if err != nil {
		return err
	}
	ctx := r.Context()
	err = db.Tx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if err := q.DeleteMaterial(ctx, material.ID); err != nil {
			return err
		}
		if material.UploadID != nil {
			if _, err := q.DeleteOwnedUpload(ctx, store.DeleteOwnedUploadParams{ID: *material.UploadID, UserID: user.ID}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if material.UploadID != nil {
		s.dropBlobs(ctx, *material.UploadID)
	}
	httpx.OK(w, http.StatusOK, map[string]bool{"deleted": true})
	return nil
}

// dropBlobs removes an upload's objects after its rows are gone; a failure only leaves orphans
// that the next collection sweep or a bucket lifecycle rule can remove. The cleanup keeps the
// request's logger but not its cancellation, so a client that has gone cannot leave objects behind.
func (s *Server) dropBlobs(ctx context.Context, uploadID string) {
	bctx := context.WithoutCancel(ctx)
	if err := s.blobs.DeletePrefix(bctx, blob.UploadPrefix(uploadID)); err != nil {
		logx.From(bctx).Warn("upload images not removed from storage", slog.String("uploadId", uploadID), slog.String("error", err.Error()))
	}
	if err := s.blobs.Delete(bctx, blob.UploadKey(uploadID)); err != nil {
		logx.From(bctx).Warn("upload not removed from storage", slog.String("uploadId", uploadID), slog.String("error", err.Error()))
	}
}
