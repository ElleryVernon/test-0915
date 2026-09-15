package api

import (
	"net/http"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/store"
)

// Admin: the moderation overview, report triage, account suspension and the school directory
// (api.ts admin). Every route needs the ADMIN role.

var errSelfSuspend = apierr.New(400, "자신의 계정은 제한할 수 없어요.")

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/admin", httpx.Methods{http.MethodGet: s.withUser(s.adminOverview, store.RoleADMIN)})
		mux.Handle("/api/admin/reports/{id}", httpx.Methods{http.MethodPatch: s.withUser(s.updateReportStatus, store.RoleADMIN)})
		mux.Handle("/api/admin/users/{id}", httpx.Methods{http.MethodPatch: s.withUser(s.updateUserSuspension, store.RoleADMIN)})
		mux.Handle("/api/admin/schools", httpx.Methods{http.MethodPost: s.withUser(s.createSchool, store.RoleADMIN)})
	})
}

// adminUser is an account as the overview lists it.
type adminUser struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Nickname  string     `json:"nickname"`
	Role      store.Role `json:"role"`
	Suspended bool       `json:"suspended"`
}

// adminReport is a report with its post's title. The previous server spread Prisma's included
// relation into the row, so `post: {title}` travels next to `postTitle`.
type adminReport struct {
	reportRecord
	Post struct {
		Title string `json:"title"`
	} `json:"post"`
	PostTitle string `json:"postTitle"`
}

// adminOverview answers GET /api/admin: the 500 newest accounts, the 500 newest reports and up to
// 1000 schools by name.
func (s *Server) adminOverview(w http.ResponseWriter, r *http.Request, _ store.User) error {
	ctx := r.Context()
	userRows, err := s.q.ListAdminUsers(ctx)
	if err != nil {
		return err
	}
	reportRows, err := s.q.ListAdminReports(ctx)
	if err != nil {
		return err
	}
	schoolRows, err := s.q.ListAdminSchools(ctx)
	if err != nil {
		return err
	}
	users := make([]adminUser, 0, len(userRows))
	for _, row := range userRows {
		users = append(users, adminUser{ID: row.ID, Name: row.Name, Nickname: row.Nickname, Role: row.Role, Suspended: row.Suspended})
	}
	reports := make([]adminReport, 0, len(reportRows))
	for _, row := range reportRows {
		report := adminReport{reportRecord: reportRecordOf(row.Report), PostTitle: row.PostTitle}
		report.Post.Title = row.PostTitle
		reports = append(reports, report)
	}
	httpx.OK(w, http.StatusOK, struct {
		Users   []adminUser    `json:"users"`
		Reports []adminReport  `json:"reports"`
		Schools []schoolRecord `json:"schools"`
	}{Users: users, Reports: reports, Schools: schoolRecords(schoolRows)})
	return nil
}

// updateReportStatus answers PATCH /api/admin/reports/{id} with the updated row.
func (s *Server) updateReportStatus(w http.ResponseWriter, r *http.Request, _ store.User) error {
	var input struct {
		Status string `json:"status"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	v := &validator{}
	status := v.enum(input.Status, "OPEN", "RESOLVED", "DISMISSED")
	if err := v.result(); err != nil {
		return err
	}
	report, err := s.q.UpdateReportStatus(r.Context(), store.UpdateReportStatusParams{ID: r.PathValue("id"), Status: status})
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, reportRecordOf(report))
	return nil
}

// updateUserSuspension answers PATCH /api/admin/users/{id}. The cached user row is dropped so the
// suspension holds on the target's very next request.
func (s *Server) updateUserSuspension(w http.ResponseWriter, r *http.Request, user store.User) error {
	id := r.PathValue("id")
	if id == user.ID {
		return errSelfSuspend
	}
	var input struct {
		Suspended *bool `json:"suspended"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	v := &validator{}
	v.check(input.Suspended != nil, msgInput)
	if err := v.result(); err != nil {
		return err
	}
	ctx := r.Context()
	row, err := s.q.UpdateUserSuspended(ctx, store.UpdateUserSuspendedParams{ID: id, Suspended: *input.Suspended})
	if err != nil {
		return err
	}
	s.auth.Invalidate(ctx, id)
	s.bump(ctx, id)
	httpx.OK(w, http.StatusOK, struct {
		ID        string `json:"id"`
		Suspended bool   `json:"suspended"`
	}{ID: row.ID, Suspended: row.Suspended})
	return nil
}

// createSchool answers POST /api/admin/schools with the new row; a duplicate name is the API's 409.
func (s *Server) createSchool(w http.ResponseWriter, r *http.Request, _ store.User) error {
	var input struct {
		Name string `json:"name"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	v := &validator{}
	name := v.text(input.Name, 100)
	if err := v.result(); err != nil {
		return err
	}
	school, err := s.q.CreateSchool(r.Context(), store.CreateSchoolParams{ID: ids.New(), Name: name})
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusCreated, schoolRecord{ID: school.ID, Name: school.Name})
	return nil
}
