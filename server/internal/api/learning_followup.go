package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/store"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/quiz/review-card", httpx.Methods{http.MethodPost: s.withUser(s.queueQuestionReview, store.RoleSTUDENT)})
	})
}

// queueQuestionReview queues deliberate practice, without fabricating an answer or a review.
// The existing source-question uniqueness and per-user transaction lock make retries safe.
func (s *Server) queueQuestionReview(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		QuestionID string `json:"questionId"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	v.id(in.QuestionID)
	if err := v.result(); err != nil {
		return err
	}
	var saved store.Card
	err := s.locked(r.Context(), user.ID, func(tx pgx.Tx, q *store.Queries) error {
		question, err := q.GetOwnedQuestion(r.Context(), store.GetOwnedQuestionParams{ID: in.QuestionID, UserID: user.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			return errQuestionNotFound
		}
		if err != nil {
			return err
		}
		saved, err = queueReviewQuestionCard(r.Context(), q, user.ID, question, time.Now())
		return err
	})
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, cardRowOf(saved))
	return nil
}

func queueReviewQuestionCard(ctx context.Context, q *store.Queries, userID string, question store.Question, now time.Time) (store.Card, error) {
	answer := ""
	if question.Answer >= 0 && int(question.Answer) < len(question.Options) {
		answer = question.Options[question.Answer]
	}
	card, err := q.UpsertWrongNoteCard(ctx, store.UpsertWrongNoteCardParams{ID: ids.New(), UserID: userID, SubjectID: question.SubjectID, Front: question.Prompt, Back: answer + "\n\n" + question.Explanation, SourceQuestionID: &question.ID})
	if err != nil {
		return card, err
	}
	due := card.NextReviewAt
	if due.After(now) {
		due = now.UTC()
	}
	// FSRS history is retained; only the requested practice queue is brought forward.
	return q.UpdateCardSchedule(ctx, store.UpdateCardScheduleParams{ID: card.ID, Bucket: store.BucketAGAIN, ConsecutiveEasy: 0, NextReviewAt: due, Fsrs: card.Fsrs})
}
