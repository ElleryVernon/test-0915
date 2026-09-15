package api

import (
	"net/http"
	"strings"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/jsonx"
	"memoryz/server/internal/store"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/subjects", httpx.Methods{http.MethodPost: s.withUser(s.createSubject, store.RoleSTUDENT)})
		mux.Handle("/api/subjects/{id}", httpx.Methods{
			http.MethodPatch:  s.withUser(s.updateSubject, store.RoleSTUDENT),
			http.MethodDelete: s.withUser(s.deleteSubject, store.RoleSTUDENT),
		})
	})
}

var errNothingToChange = apierr.New(400, "바꿀 내용을 입력해 주세요.")

type subjectInput struct {
	Name     jsonx.Opt[string] `json:"name"`
	ExamName jsonx.Opt[string] `json:"examName"`
	ExamDate jsonx.Opt[string] `json:"examDate"`
}

// validate applies the zod shapes: name is text(60); examName is a trimmed string of at most 20
// characters or null; examDate is a real date or null.
func (in *subjectInput) validate(v *validator, nameRequired bool) {
	if in.Name.Present() {
		in.Name.Value = v.text(in.Name.Value, 60)
	} else if nameRequired || in.Name.Set {
		v.fail(msgInput)
	}
	if in.ExamName.Present() {
		in.ExamName.Value = strings.TrimSpace(in.ExamName.Value)
		v.check(length(in.ExamName.Value) <= 20, msgInput)
	}
	if in.ExamDate.Present() {
		v.date(in.ExamDate.Value)
	}
}

func (s *Server) createSubject(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in subjectInput
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	in.validate(v, true)
	if err := v.result(); err != nil {
		return err
	}
	params := store.CreateSubjectParams{ID: ids.New(), UserID: user.ID, Name: in.Name.Value}
	// An exam is recorded only with a date; its name is optional and an empty one reads as "시험".
	if in.ExamDate.Present() && in.ExamDate.Value != "" {
		params.ExamDate = &in.ExamDate.Value
		if in.ExamName.Present() && in.ExamName.Value != "" {
			params.ExamName = &in.ExamName.Value
		}
	}
	subject, err := s.q.CreateSubject(r.Context(), params)
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusCreated, subjectOf(subject))
	return nil
}

func (s *Server) updateSubject(w http.ResponseWriter, r *http.Request, user store.User) error {
	if _, err := s.ownedSubject(r.Context(), user, r.PathValue("id")); err != nil {
		return err
	}
	var in subjectInput
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	in.validate(v, false)
	if err := v.result(); err != nil {
		return err
	}
	if !in.Name.Set && !in.ExamName.Set && !in.ExamDate.Set {
		return errNothingToChange
	}
	params := store.UpdateSubjectParams{ID: r.PathValue("id")}
	if in.Name.Present() && in.Name.Value != "" {
		params.Name = &in.Name.Value
	}
	switch {
	case in.ExamDate.Set && in.ExamDate.Null:
		// A null date clears the exam entirely.
		params.SetExamDate, params.SetExamName = true, true
	default:
		if in.ExamDate.Present() && in.ExamDate.Value != "" {
			params.SetExamDate = true
			params.ExamDate = &in.ExamDate.Value
		}
		if in.ExamName.Set {
			params.SetExamName = true
			if in.ExamName.Present() && in.ExamName.Value != "" {
				params.ExamName = &in.ExamName.Value
			}
		}
	}
	subject, err := s.q.UpdateSubject(r.Context(), params)
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, subjectOf(subject))
	return nil
}

func (s *Server) deleteSubject(w http.ResponseWriter, r *http.Request, user store.User) error {
	subject, err := s.ownedSubject(r.Context(), user, r.PathValue("id"))
	if err != nil {
		return err
	}
	deleted, err := s.q.SoftDeleteSubject(r.Context(), subject.ID)
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, subjectOf(deleted))
	return nil
}
