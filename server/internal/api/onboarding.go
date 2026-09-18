package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/db"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/schools"
	"memoryz/server/internal/store"
)

type onboardingDraft struct {
	Step     int    `json:"step"`
	Role     string `json:"role"`
	Nickname string `json:"nickname"`
	Grade    string `json:"grade"`
	School   string `json:"school"`
	SchoolID string `json:"schoolId"`
}

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/onboarding", httpx.Methods{http.MethodGet: s.withUser(s.getOnboarding), http.MethodPatch: s.withUser(s.saveOnboarding)})
	})
}

func (s *Server) getOnboarding(w http.ResponseWriter, r *http.Request, user store.User) error {
	var raw []byte
	var complete bool
	err := s.pool.QueryRow(r.Context(), `SELECT "draft", "completedAt" IS NOT NULL FROM "AccountOnboarding" WHERE "userId"=$1`, user.ID).Scan(&raw, &complete)
	if errors.Is(err, pgx.ErrNoRows) {
		complete = true
	} else if err != nil {
		return err
	}
	draft := onboardingDraft{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &draft); err != nil {
			return err
		}
	}
	httpx.OK(w, http.StatusOK, map[string]any{"draft": draft, "complete": complete})
	return nil
}

// Draft steps are durable. Completion updates role/profile and the completion
// marker atomically; replaying it cannot change a finished account's role.
func (s *Server) saveOnboarding(w http.ResponseWriter, r *http.Request, user store.User) error {
	var input struct {
		onboardingDraft
		Complete bool `json:"complete"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	d := input.onboardingDraft
	d.Nickname = strings.TrimSpace(d.Nickname)
	d.School = strings.TrimSpace(d.School)
	v := &validator{}
	v.check(d.Step >= 0 && d.Step <= 2, msgInput)
	v.enum(d.Role, "STUDENT", "PARENT")
	v.bounded(d.Nickname, 20)
	v.bounded(d.School, 200)
	v.enum(d.Grade, grades...)
	if d.Step >= 2 || input.Complete {
		v.check(len([]rune(d.Nickname)) >= 2, "닉네임을 2자 이상 입력해 주세요.")
	}
	if input.Complete && d.Role == "STUDENT" {
		v.check(d.Grade != "", "학년을 선택해 주세요.")
		if d.School != "" || d.SchoolID != "" {
			school, exists := schools.Find(d.SchoolID)
			v.check(exists, "검색 결과에서 학교를 선택해 주세요.")
			if exists {
				d.School = school.Identity()
			}
		}
	}
	if err := v.result(); err != nil {
		return err
	}
	raw, err := json.Marshal(d)
	if err != nil {
		return err
	}
	err = db.Tx(r.Context(), s.pool, func(tx pgx.Tx) error {
		var complete bool
		err := tx.QueryRow(r.Context(), `SELECT "completedAt" IS NOT NULL FROM "AccountOnboarding" WHERE "userId"=$1 FOR UPDATE`, user.ID).Scan(&complete)
		if errors.Is(err, pgx.ErrNoRows) {
			return apierr.New(409, "이미 가입 설정을 마친 계정이에요.")
		}
		if err != nil {
			return err
		}
		if complete {
			return nil
		}
		if d.Nickname != "" {
			var taken bool
			if err := tx.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM "User" WHERE "nickname"=$1 AND "id"<>$2)`, d.Nickname, user.ID).Scan(&taken); err != nil {
				return err
			}
			if taken {
				return apierr.New(409, "이미 사용 중인 닉네임이에요. 다른 이름을 입력해 주세요.")
			}
		}
		if input.Complete {
			if d.Role == "PARENT" {
				d.Grade, d.School = "", ""
			}
			_, err = tx.Exec(r.Context(), `UPDATE "User" SET "role"=$2, "nickname"=$3, "grade"=$4, "school"=$5 WHERE "id"=$1`, user.ID, d.Role, d.Nickname, d.Grade, d.School)
			if err != nil {
				return err
			}
		}
		_, err = tx.Exec(r.Context(), `UPDATE "AccountOnboarding" SET "draft"=$2, "updatedAt"=CURRENT_TIMESTAMP, "completedAt"=CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE NULL END WHERE "userId"=$1`, user.ID, raw, input.Complete)
		return err
	})
	if err != nil {
		return err
	}
	s.auth.Invalidate(r.Context(), user.ID)
	httpx.OK(w, http.StatusOK, map[string]bool{"saved": true})
	return nil
}
