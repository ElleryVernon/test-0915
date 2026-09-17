package api

import (
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/schools"
	"memoryz/server/internal/store"
	"net/http"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/schools/select", httpx.Methods{http.MethodPost: s.withUser(s.selectSchool)})
	})
}
func (s *Server) selectSchool(w http.ResponseWriter, r *http.Request, user store.User) error {
	var input struct {
		ID string `json:"id"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	school, ok := schools.Find(input.ID)
	if !ok {
		return apierr.New(400, "검색 결과에서 학교를 선택해 주세요.")
	}
	if _, err := s.pool.Exec(r.Context(), `UPDATE "User" SET "school"=$2 WHERE "id"=$1`, user.ID, school.Identity()); err != nil {
		return err
	}
	s.auth.Invalidate(r.Context(), user.ID)
	httpx.OK(w, http.StatusOK, map[string]any{"school": school.Identity()})
	return nil
}
