package api

import (
	"errors"
	"github.com/jackc/pgx/v5"
	"memoryz/server/internal/curriculum"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/store"
	"net/http"
	"time"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/quiz/connections", httpx.Methods{http.MethodGet: s.withUser(s.curriculumConnections, store.RoleSTUDENT)})
	})
}
func (s *Server) curriculumConnections(w http.ResponseWriter, r *http.Request, user store.User) error {
	q, err := s.q.GetOwnedQuestion(r.Context(), store.GetOwnedQuestionParams{ID: r.URL.Query().Get("questionId"), UserID: user.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return errQuestionNotFound
	}
	if err != nil {
		return err
	}
	version := curriculum.VersionForGrade(user.Grade, time.Now())
	matches := []curriculum.Match{}
	coverage := "no_match"
	if version == "" {
		coverage = "unknown_grade"
	} else if version != "2022" {
		coverage = "unsupported_curriculum"
	} else {
		subject, err := s.ownedSubject(r.Context(), user, q.SubjectID)
		if err == nil {
			matches = curriculum.Retrieve(subject.Name, user.Grade, time.Now(), q.Prompt+" "+q.Explanation+" "+q.Citation)
		}
		if len(matches) > 0 {
			coverage = "matched"
		}
	}
	httpx.OK(w, 200, map[string]any{"curriculumVersion": version, "standards": matches, "coverage": coverage})
	return nil
}
