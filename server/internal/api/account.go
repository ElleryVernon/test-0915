package api

import (
	"encoding/json"
	"net/http"

	"memoryz/server/internal/httpx"
	"memoryz/server/internal/jsonx"
	"memoryz/server/internal/store"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/profile", httpx.Methods{http.MethodPatch: s.withUser(s.patchProfile)})
		mux.Handle("/api/notifications", httpx.Methods{http.MethodPatch: s.withUser(s.readNotifications)})
	})
}

// grades are the school years a profile accepts; the empty string clears the field.
var grades = []string{"고1", "고2", "고3", "N수/기타", "기타", ""}

// privacyInput is the privacy object as sent: every flag is required once the object is present.
type privacyInput struct {
	Accuracy   *bool `json:"accuracy"`
	Time       *bool `json:"time"`
	WrongNotes *bool `json:"wrongNotes"`
}

type profileInput struct {
	Name              jsonx.Opt[string]       `json:"name"`
	Nickname          jsonx.Opt[string]       `json:"nickname"`
	School            jsonx.Opt[string]       `json:"school"`
	Grade             jsonx.Opt[string]       `json:"grade"`
	Privacy           jsonx.Opt[privacyInput] `json:"privacy"`
	CompletedSubjects jsonx.Opt[[]string]     `json:"completedSubjects"`
	SrsMode           jsonx.Opt[string]       `json:"srsMode"`
	DesiredRetention  jsonx.Opt[float64]      `json:"desiredRetention"`
}

// given reports whether an optional field carries a value; an explicit null is a validation
// failure, as it was for the previous server's `.optional()` fields.
func given[T any](v *validator, o jsonx.Opt[T]) bool {
	if o.Null {
		v.fail(msgInput)
	}
	return o.Present()
}

// patchProfile changes only the fields the body carries and answers the whole profile.
func (s *Server) patchProfile(w http.ResponseWriter, r *http.Request, user store.User) error {
	var input profileInput
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	v := &validator{}
	params := store.UpdateProfileParams{ID: user.ID}
	if given(v, input.Name) {
		name := v.text(input.Name.Value, 50)
		params.Name = &name
	}
	if given(v, input.Nickname) {
		nickname := v.text(input.Nickname.Value, 30)
		params.Nickname = &nickname
	}
	if given(v, input.School) {
		school := v.bounded(input.School.Value, 100)
		params.School = &school
	}
	if given(v, input.Grade) {
		grade := v.enum(input.Grade.Value, grades...)
		params.Grade = &grade
	}
	if given(v, input.Privacy) {
		p := input.Privacy.Value
		if p.Accuracy != nil && p.Time != nil && p.WrongNotes != nil {
			raw, err := json.Marshal(Privacy{Accuracy: *p.Accuracy, Time: *p.Time, WrongNotes: *p.WrongNotes})
			if err != nil {
				return err
			}
			params.Privacy = raw
		} else {
			v.fail(msgInput)
		}
	}
	if given(v, input.CompletedSubjects) {
		list := input.CompletedSubjects.Value
		v.check(len(list) <= 100, msgInput)
		cleaned := make([]string, 0, len(list))
		for _, item := range list {
			cleaned = append(cleaned, v.text(item, 60))
		}
		params.CompletedSubjects = cleaned
	}
	if given(v, input.SrsMode) {
		mode := v.enum(input.SrsMode.Value, "FIXED", "FSRS")
		params.SrsMode = &mode
	}
	if given(v, input.DesiredRetention) {
		retention := v.floatRange(input.DesiredRetention.Value, 0.8, 0.97)
		params.DesiredRetention = &retention
	}
	if err := v.result(); err != nil {
		return err
	}
	// A taken nickname surfaces as the unique-index violation, answered as the 409 of before.
	updated, err := s.q.UpdateProfile(r.Context(), params)
	if err != nil {
		return err
	}
	s.auth.Invalidate(r.Context(), user.ID)
	profile := profileOf(updated)
	profile.AvatarURL, err = s.ownProfilePhotoURL(r.Context(), user.ID)
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, profile)
	return nil
}

// readNotifications marks one owned notification read, or all when no id is supplied.
func (s *Server) readNotifications(w http.ResponseWriter, r *http.Request, user store.User) error {
	var input struct {
		Read *bool  `json:"read"`
		ID   string `json:"id"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	if input.Read == nil || !*input.Read {
		return errInput
	}
	if input.ID != "" {
		if _, err := s.pool.Exec(r.Context(), `UPDATE "Notification" SET "read"=true WHERE "id"=$1 AND "userId"=$2`, input.ID, user.ID); err != nil {
			return err
		}
	} else {
		if err := s.q.MarkNotificationsRead(r.Context(), user.ID); err != nil {
			return err
		}
	}
	httpx.OK(w, http.StatusOK, map[string]bool{"read": true})
	return nil
}
