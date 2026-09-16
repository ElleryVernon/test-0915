package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/learning"
	"memoryz/server/internal/store"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/quiz/explanation", httpx.Methods{http.MethodGet: s.withUser(s.getExplanation, store.RoleSTUDENT)})
		mux.Handle("/api/quiz/reflection", httpx.Methods{http.MethodPost: s.withUser(s.saveReflection, store.RoleSTUDENT)})
		mux.Handle("/api/quiz/explanation-card", httpx.Methods{http.MethodPost: s.withUser(s.createExplanationCard, store.RoleSTUDENT)})
		mux.Handle("/api/quiz/explanation/report", httpx.Methods{http.MethodPost: s.withUser(s.reportExplanation, store.RoleSTUDENT)})
	})
}

func (s *Server) explanationFor(ctx context.Context, userID, questionID string) (store.Question, learning.Explanation, error) {
	q, err := s.q.GetOwnedQuestion(ctx, store.GetOwnedQuestionParams{ID: questionID, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return q, learning.Explanation{}, errQuestionNotFound
	}
	if err != nil {
		return q, learning.Explanation{}, err
	}
	m, err := s.q.GetMaterialContent(ctx, store.GetMaterialContentParams{ID: q.MaterialID, UserID: userID})
	if err != nil {
		return q, learning.Explanation{}, err
	}
	return q, learning.Resolve(q.ID, q.Citation, m.Content, q.Options, int(q.Answer), q.LearningExplanation), nil
}
func (s *Server) getExplanation(w http.ResponseWriter, r *http.Request, user store.User) error {
	_, e, err := s.explanationFor(r.Context(), user.ID, r.URL.Query().Get("questionId"))
	if err != nil {
		return err
	}
	httpx.OK(w, 200, e)
	return nil
}
func (s *Server) saveReflection(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		AttemptID    string `json:"attemptId"`
		QuestionID   string `json:"questionId"`
		Stage        string `json:"stage"`
		MicroCheckID string `json:"microCheckId"`
		Answer       *int   `json:"answer"`
		Skipped      bool   `json:"skipped"`
		Depth        string `json:"depth"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	v.id(in.AttemptID)
	v.id(in.QuestionID)
	v.enum(in.Stage, "VERDICT", "EXPLANATION", "CHECK")
	v.enum(in.Depth, "SHORT", "FULL")
	if in.Answer != nil {
		v.check(*in.Answer >= 0 && *in.Answer <= 1, msgInput)
	}
	v.check(!(in.Skipped && in.Answer != nil), msgInput)
	if err := v.result(); err != nil {
		return err
	}
	ctx := r.Context()
	_, err := s.q.GetOwnedAttempt(ctx, store.GetOwnedAttemptParams{ID: in.AttemptID, UserID: user.ID, QuestionID: &in.QuestionID})
	if errors.Is(err, pgx.ErrNoRows) {
		return errQuestionNotFound
	}
	if err != nil {
		return err
	}
	_, e, err := s.explanationFor(ctx, user.ID, in.QuestionID)
	if err != nil {
		return err
	}
	var result, nodeID *string
	beats := int32(1)
	if in.Stage == "EXPLANATION" {
		beats = 2
	}
	if in.Stage == "CHECK" {
		beats = 3
		if in.Skipped {
			val := "SKIP"
			result = &val
		} else if in.Answer != nil {
			for _, c := range e.MicroChecks {
				if c.ID == in.MicroCheckID {
					val := "FAIL"
					if c.Answer == *in.Answer {
						val = "PASS"
					}
					result = &val
					n := c.NodeID
					nodeID = &n
					break
				}
			}
			if result == nil {
				return apierr.New(400, "확인 문제를 다시 열어 주세요.")
			}
		}
	} else if in.Answer != nil || in.Skipped || in.MicroCheckID != "" {
		return apierr.New(400, "확인 단계에서만 답을 저장할 수 있어요.")
	}
	updated, err := s.q.UpdateReflection(ctx, store.UpdateReflectionParams{ID: in.AttemptID, UserID: user.ID, QuestionID: &in.QuestionID, BeatsSeen: beats, Depth: &in.Depth, MicroResult: result, NodeID: nodeID})
	if err != nil {
		return err
	}
	httpx.OK(w, 200, map[string]any{"microResult": updated.MicroResult})
	return nil
}
func (s *Server) createExplanationCard(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		QuestionID  string   `json:"questionId"`
		NodeIDs     []string `json:"nodeIds"`
		MicroResult *string  `json:"microResult"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	v.id(in.QuestionID)
	v.check(len(in.NodeIDs) > 0 && len(in.NodeIDs) <= 12, msgInput)
	if in.MicroResult != nil {
		v.enum(*in.MicroResult, "PASS", "FAIL", "SKIP")
	}
	if err := v.result(); err != nil {
		return err
	}
	ctx := r.Context()
	q, e, err := s.explanationFor(ctx, user.ID, in.QuestionID)
	if err != nil {
		return err
	}
	if e.Diagram == nil {
		return apierr.New(409, "이 문제는 글 해설을 확인해 주세요.")
	}
	allowed := map[string]string{}
	for _, n := range e.Diagram.Nodes {
		allowed[n.ID] = n.Label
	}
	seen := map[string]bool{}
	back := []string{}
	for _, id := range in.NodeIDs {
		if allowed[id] == "" || seen[id] {
			return apierr.New(400, "가릴 부분을 다시 선택해 주세요.")
		}
		seen[id] = true
		back = append(back, allowed[id])
	}
	raw, _ := json.Marshal(e.Diagram)
	diagramID := e.Diagram.ID
	card, err := s.q.UpsertExplanationCard(ctx, store.UpsertExplanationCardParams{ID: ids.New(), UserID: user.ID, SubjectID: q.SubjectID, Front: q.Prompt, Back: strings.Join(back, "\n") + "\n\n근거: " + e.Citation, SourceQuestionID: &q.ID, MaterialID: &q.MaterialID, Diagram: raw, MaskedNodeIds: in.NodeIDs, SourceDiagramId: &diagramID})
	if err != nil {
		return err
	}
	// Diagram and text source cards have separate uniqueness keys. Retried diagram creates
	// preserve the existing mask, content and review schedule.
	httpx.OK(w, 201, cardOf(card, nil))
	return nil
}
func (s *Server) reportExplanation(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		QuestionID string `json:"questionId"`
		NodeID     string `json:"nodeId"`
		Reason     string `json:"reason"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	v.id(in.QuestionID)
	v.enum(in.Reason, "source-mismatch")
	if err := v.result(); err != nil {
		return err
	}
	_, e, err := s.explanationFor(r.Context(), user.ID, in.QuestionID)
	if err != nil {
		return err
	}
	if in.NodeID != "" {
		found := false
		if e.Diagram != nil {
			for _, n := range e.Diagram.Nodes {
				if n.ID == in.NodeID {
					found = true
				}
			}
		}
		if !found {
			return apierr.New(400, "신고할 부분을 다시 선택해 주세요.")
		}
	}
	if err := s.q.CreateExplanationReport(r.Context(), store.CreateExplanationReportParams{ID: ids.New(), UserID: user.ID, QuestionID: in.QuestionID, NodeId: in.NodeID, Reason: in.Reason}); err != nil {
		return err
	}
	httpx.OK(w, 200, map[string]bool{"reported": true})
	return nil
}
