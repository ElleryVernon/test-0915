package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"memoryz/server/internal/ai"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/jsonx"
	"memoryz/server/internal/learning"
	"memoryz/server/internal/store"
	"memoryz/server/internal/textmatch"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/materials/{id}/sources", httpx.Methods{http.MethodGet: s.withUser(s.materialSources, store.RoleSTUDENT)})
	})
}

const generationContextLimit = learning.MaxSourceRunes

var errGenerationSources = apierr.New(400, "내 자료를 1개부터 5개까지 서로 다르게 선택해 주세요.")
var errGenerationContext = apierr.New(400, "선택한 자료의 전체 본문이 500,000자를 넘어요. 자료를 나눠서 선택해 주세요. 본문을 임의로 줄이지 않아요.")
var errGenerationSubject = apierr.New(400, "선택한 자료에 속한 과목을 저장할 과목으로 골라 주세요.")
var errSnapshotImmutable = apierr.New(409, "여러 자료로 만든 원본은 수정할 수 없어요. 기존 자료를 수정한 뒤 새로 만들어 주세요.")

type generationSource struct {
	ID            string     `json:"id"`
	Title         string     `json:"title"`
	SubjectID     string     `json:"subjectId"`
	Content       string     `json:"content"`
	ContentHash   string     `json:"contentHash"`
	ContentLength int        `json:"contentLength"`
	Type          string     `json:"type"`
	CreatedAt     jsonx.Time `json:"createdAt"`
	Available     bool       `json:"available"`
	Changed       bool       `json:"changed"`
}
type generationContext struct {
	sources   []generationSource
	content   string
	subjectID string
}
type generationQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func generationIDs(single string, multiple []string) ([]string, error) {
	if multiple == nil {
		if single == "" {
			return nil, errGenerationSources
		}
		multiple = []string{single}
	} else if single != "" && (len(multiple) != 1 || multiple[0] != single) {
		return nil, errGenerationSources
	}
	if len(multiple) < 1 || len(multiple) > 5 {
		return nil, errGenerationSources
	}
	seen := map[string]bool{}
	v := &validator{}
	for _, id := range multiple {
		v.id(id)
		if seen[id] {
			return nil, errGenerationSources
		}
		seen[id] = true
	}
	if err := v.result(); err != nil {
		return nil, err
	}
	return multiple, nil
}

func loadGenerationSources(ctx context.Context, db generationQueryer, userID string, materialIDs []string, lock bool) ([]generationSource, error) {
	sql := `SELECT m."id",m."title",m."subjectId",m."content",m."type",m."createdAt" FROM "Material" m JOIN "Subject" s ON s."id"=m."subjectId" WHERE m."id"=ANY($1::text[]) AND m."userId"=$2 AND s."userId"=$2 AND s."deleted"=false ORDER BY m."id"`
	if lock {
		sql += " FOR SHARE OF m,s"
	}
	rows, err := db.Query(ctx, sql, materialIDs, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := map[string]generationSource{}
	for rows.Next() {
		var source generationSource
		var created time.Time
		if err = rows.Scan(&source.ID, &source.Title, &source.SubjectID, &source.Content, &source.Type, &created); err != nil {
			return nil, err
		}
		source.CreatedAt = jsonx.Time(created)
		source.ContentHash = textHash(source.Content)
		source.ContentLength = length(source.Content)
		source.Available = true
		byID[source.ID] = source
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(byID) != len(materialIDs) {
		return nil, errMaterialNotFound
	}
	out := make([]generationSource, 0, len(materialIDs))
	for _, id := range materialIDs {
		out = append(out, byID[id])
	}
	return out, nil
}

func combineGenerationSources(sources []generationSource, subjectID string) (generationContext, error) {
	result := generationContext{sources: sources, subjectID: subjectID}
	if len(sources) == 0 {
		return result, errGenerationSources
	}
	if subjectID == "" {
		result.subjectID = sources[0].SubjectID
	}
	subjectFound := false
	var context strings.Builder
	for i, source := range sources {
		if length(strings.TrimSpace(source.Content)) < 20 {
			return result, errMaterialTooShort
		}
		if source.SubjectID == result.subjectID {
			subjectFound = true
		}
		if subjectID == "" && source.SubjectID != result.subjectID {
			return result, errGenerationSubject
		}
		if len(sources) > 1 {
			fmt.Fprintf(&context, "[자료 %d: %s]\n", i+1, source.Title)
		}
		context.WriteString(source.Content)
		if i+1 < len(sources) {
			context.WriteString("\n\n")
		}
	}
	if !subjectFound {
		return result, errGenerationSubject
	}
	result.content = context.String()
	if length(result.content) > generationContextLimit {
		return result, errGenerationContext
	}
	return result, nil
}

func (g generationContext) checkUnchanged(ctx context.Context, tx pgx.Tx, userID string) error {
	sourceIDs := make([]string, len(g.sources))
	for i, s := range g.sources {
		sourceIDs[i] = s.ID
	}
	current, err := loadGenerationSources(ctx, tx, userID, sourceIDs, true)
	if errors.Is(err, errMaterialNotFound) {
		return errMaterialChanged
	}
	if err != nil {
		return err
	}
	for i, s := range current {
		old := g.sources[i]
		if s.Content != old.Content || s.Title != old.Title || s.SubjectID != old.SubjectID || s.Type != old.Type {
			return errMaterialChanged
		}
	}
	return nil
}

func (g generationContext) materialID(ctx context.Context, tx pgx.Tx, q *store.Queries, userID, topic string) (string, error) {
	if len(g.sources) == 1 {
		return g.sources[0].ID, nil
	}
	title := topic
	if title == "" {
		title = fmt.Sprintf("%s 외 %d개 자료", g.sources[0].Title, len(g.sources)-1)
	}
	if len([]rune(title)) > 190 {
		title = string([]rune(title)[:190])
	}
	title += " · 모음"
	material, err := q.CreateMaterial(ctx, store.CreateMaterialParams{ID: ids.New(), UserID: userID, SubjectID: g.subjectID, Title: title, Content: g.content, Type: "TXT", PageBreaks: []int32{}, Extraction: ptr("combined")})
	if err != nil {
		return "", err
	}
	raw, err := json.Marshal(g.sources)
	if err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `INSERT INTO "GenerationSources"("materialId","sources","topic") VALUES($1,$2,$3)`, material.ID, raw, topic)
	return material.ID, err
}

// Headings and topic labels are metadata, never acceptable evidence for generated learning items.
func (g generationContext) grounded(items ai.Items) bool {
	citations := []string{}
	for _, q := range items.Questions {
		citations = append(citations, q.Citation)
	}
	for _, e := range items.Essays {
		citations = append(citations, e.Citation)
	}
	for _, c := range items.Cards {
		citations = append(citations, c.Citation)
	}
	for _, citation := range citations {
		found := false
		for _, source := range g.sources {
			if textmatch.HasCitation(source.Content, citation) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func (s *Server) materialSources(w http.ResponseWriter, r *http.Request, user store.User) error {
	material, err := s.ownedMaterial(r, user)
	if err != nil {
		return err
	}
	var raw []byte
	var topic string
	err = s.pool.QueryRow(r.Context(), `SELECT "sources","topic" FROM "GenerationSources" WHERE "materialId"=$1`, material.ID).Scan(&raw, &topic)
	combined := err == nil
	sources := []generationSource{}
	if errors.Is(err, pgx.ErrNoRows) {
		sources, err = loadGenerationSources(r.Context(), s.pool, user.ID, []string{material.ID}, false)
	} else if err == nil {
		err = json.Unmarshal(raw, &sources)
	}
	if err != nil {
		return err
	}
	if combined {
		for i, source := range sources {
			current, e := loadGenerationSources(r.Context(), s.pool, user.ID, []string{source.ID}, false)
			if e != nil && !errors.Is(e, errMaterialNotFound) {
				return e
			}
			sources[i].Available = e == nil
			sources[i].Changed = e == nil && (current[0].ContentHash != source.ContentHash || current[0].Title != source.Title || current[0].SubjectID != source.SubjectID)
		}
	}
	httpx.OK(w, 200, map[string]any{"sources": sources, "topic": topic, "combined": combined})
	return nil
}
