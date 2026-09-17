package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/jsonx"
	"memoryz/server/internal/planner"
	"memoryz/server/internal/store"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/schedules/batch", httpx.Methods{http.MethodPost: s.withUser(s.saveScheduleBatch, store.RoleSTUDENT)})
		mux.Handle("/api/schedules", httpx.Methods{http.MethodPost: s.withUser(s.saveSchedule, store.RoleSTUDENT)})
		mux.Handle("/api/schedules/{id}", httpx.Methods{
			http.MethodPatch:  s.withUser(s.saveSchedule, store.RoleSTUDENT),
			http.MethodDelete: s.withUser(s.deleteSchedule, store.RoleSTUDENT),
		})
	})
}

var (
	errScheduleNotFound   = apierr.New(404, "일정을 찾을 수 없어요.")
	errScheduleIncomplete = apierr.New(400, "일정 정보를 모두 입력해 주세요.")
	errScheduleOrder      = apierr.New(400, "종료 시간은 시작 시간 이후여야 해요.")
	errScheduleConflict   = apierr.New(409, "기존 일정과 시간이 겹쳐요. 다른 시간을 골라 주세요.")
)

type scheduleInput struct {
	Title     jsonx.Opt[string] `json:"title"`
	Date      jsonx.Opt[string] `json:"date"`
	Start     jsonx.Opt[string] `json:"start"`
	End       jsonx.Opt[string] `json:"end"`
	Kind      jsonx.Opt[string] `json:"kind"`
	SubjectID jsonx.Opt[string] `json:"subjectId"`
	Done      jsonx.Opt[bool]   `json:"done"`
}

func (s *Server) deleteSchedule(w http.ResponseWriter, r *http.Request, user store.User) error {
	n, err := s.q.DeleteSchedule(r.Context(), store.DeleteScheduleParams{ID: r.PathValue("id"), UserID: user.ID})
	if err != nil {
		return err
	}
	if n == 0 {
		return errScheduleNotFound
	}
	httpx.OK(w, http.StatusOK, map[string]bool{"deleted": true})
	return nil
}

// saveSchedule creates (POST) or patches (PATCH /{id}) a schedule; both hold the user row so two
// overlapping saves cannot both pass the conflict check.
func (s *Server) saveSchedule(w http.ResponseWriter, r *http.Request, user store.User) error {
	patch := r.Method == http.MethodPatch
	id := r.PathValue("id")
	var in scheduleInput
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	require := func(o *jsonx.Opt[string]) bool {
		if !o.Set || o.Null {
			if !patch {
				v.fail(msgInput)
			}
			return false
		}
		return true
	}
	if require(&in.Title) {
		in.Title.Value = v.text(in.Title.Value, 100)
	}
	if require(&in.Date) {
		v.date(in.Date.Value)
	}
	if require(&in.Start) {
		v.clock(in.Start.Value)
	}
	if require(&in.End) {
		v.clock(in.End.Value)
	}
	if require(&in.Kind) {
		v.enum(in.Kind.Value, "FIXED", "FLEXIBLE")
	}
	if in.SubjectID.Present() {
		v.id(in.SubjectID.Value)
	}
	if err := v.result(); err != nil {
		return err
	}
	if in.SubjectID.Present() {
		if _, err := s.ownedSubject(r.Context(), user, in.SubjectID.Value); err != nil {
			return err
		}
	}
	var saved store.Schedule
	err := s.locked(r.Context(), user.ID, func(tx pgx.Tx, q *store.Queries) error {
		var existing *store.Schedule
		if patch {
			row, err := q.GetOwnedSchedule(r.Context(), store.GetOwnedScheduleParams{ID: id, UserID: user.ID})
			if errors.Is(err, pgx.ErrNoRows) {
				return errScheduleNotFound
			}
			if err != nil {
				return err
			}
			existing = &row
		}
		merged := store.Schedule{}
		if existing != nil {
			merged = *existing
		}
		if in.Title.Present() {
			merged.Title = in.Title.Value
		}
		if in.Date.Present() {
			merged.Date = in.Date.Value
		}
		if in.Start.Present() {
			merged.Start = in.Start.Value
		}
		if in.End.Present() {
			merged.End = in.End.Value
		}
		if in.Kind.Present() {
			merged.Kind = store.ScheduleKind(in.Kind.Value)
		}
		if in.SubjectID.Set {
			if in.SubjectID.Null {
				merged.SubjectID = nil
			} else {
				value := in.SubjectID.Value
				merged.SubjectID = &value
			}
		}
		if in.Done.Present() {
			merged.Done = in.Done.Value
		}
		if merged.Title == "" || merged.Date == "" || merged.Start == "" || merged.End == "" || merged.Kind == "" {
			return errScheduleIncomplete
		}
		if merged.Start >= merged.End {
			return errScheduleOrder
		}
		others, err := q.ListSchedulesOnDate(r.Context(), store.ListSchedulesOnDateParams{UserID: user.ID, Date: merged.Date, ID: id})
		if err != nil {
			return err
		}
		mine := planner.Dated{Date: merged.Date, Start: merged.Start, End: merged.End}
		for _, other := range others {
			if planner.Conflict(mine, planner.Dated{Date: other.Date, Start: other.Start, End: other.End}) {
				return errScheduleConflict
			}
		}
		if existing != nil {
			saved, err = q.UpdateSchedule(r.Context(), store.UpdateScheduleParams{ID: existing.ID, Title: merged.Title, Date: merged.Date, Start: merged.Start, End: merged.End, Kind: merged.Kind, SubjectID: merged.SubjectID, Done: merged.Done})
			return err
		}
		saved, err = q.CreateSchedule(r.Context(), store.CreateScheduleParams{ID: ids.New(), UserID: user.ID, Title: merged.Title, Date: merged.Date, Start: merged.Start, End: merged.End, Kind: merged.Kind, SubjectID: merged.SubjectID, Done: merged.Done})
		return err
	})
	if err != nil {
		return err
	}
	status := http.StatusOK
	if !patch {
		status = http.StatusCreated
	}
	httpx.OK(w, status, scheduleRow{ID: saved.ID, UserID: saved.UserID, Title: saved.Title, Date: saved.Date, Start: saved.Start, End: saved.End, Kind: string(saved.Kind), SubjectID: saved.SubjectID, Done: saved.Done, CreatedAt: jsonx.Time(saved.CreatedAt)})
	return nil
}

// saveScheduleBatch is atomic and additive. Retrying an identical batch skips exact
// existing events; a new conflict rejects the entire batch, never a partial save.
func (s *Server) saveScheduleBatch(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		Blocks []planner.BatchBlock `json:"blocks"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	if err := planner.ValidateBatch(in.Blocks); err != nil {
		return apierr.New(400, err.Error())
	}
	for i := range in.Blocks {
		in.Blocks[i].Title = strings.TrimSpace(in.Blocks[i].Title)
		if in.Blocks[i].SubjectID != nil && *in.Blocks[i].SubjectID != "" {
			if _, err := s.ownedSubject(r.Context(), user, *in.Blocks[i].SubjectID); err != nil {
				return err
			}
		} else {
			in.Blocks[i].SubjectID = nil
		}
	}
	added, existing := 0, 0
	err := s.locked(r.Context(), user.ID, func(tx pgx.Tx, q *store.Queries) error {
		pending := []planner.BatchBlock{}
		for _, block := range in.Blocks {
			others, err := q.ListSchedulesOnDate(r.Context(), store.ListSchedulesOnDateParams{UserID: user.ID, Date: block.Date, ID: ""})
			if err != nil {
				return err
			}
			matched := false
			for _, other := range others {
				row := planner.BatchBlock{Title: other.Title, Date: other.Date, Start: other.Start, End: other.End, Kind: string(other.Kind), SubjectID: other.SubjectID}
				if planner.SameBatchBlock(block, row) {
					matched = true
					continue
				}
				if planner.Conflict(planner.Dated{Date: block.Date, Start: block.Start, End: block.End}, planner.Dated{Date: row.Date, Start: row.Start, End: row.End}) {
					return apierr.New(409, fmt.Sprintf("%s %s에 %s 일정이 생겼어요. 아직 아무 일정도 추가하지 않았어요. 다시 배치해 주세요.", block.Date, block.Start, row.Title))
				}
			}
			if matched {
				existing++
			} else {
				pending = append(pending, block)
			}
		}
		for _, block := range pending {
			if _, err := q.CreateSchedule(r.Context(), store.CreateScheduleParams{ID: ids.New(), UserID: user.ID, Title: block.Title, Date: block.Date, Start: block.Start, End: block.End, Kind: store.ScheduleKind(block.Kind), SubjectID: block.SubjectID}); err != nil {
				return err
			}
			added++
		}
		return nil
	})
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, map[string]int{"added": added, "existing": existing})
	return nil
}
