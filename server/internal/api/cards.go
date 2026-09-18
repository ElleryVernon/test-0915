package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/jsonx"
	"memoryz/server/internal/srs"
	"memoryz/server/internal/store"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/cards", httpx.Methods{http.MethodPost: s.withUser(s.createCard, store.RoleSTUDENT)})
		mux.Handle("/api/cards/review", httpx.Methods{http.MethodPost: s.withUser(s.reviewCard, store.RoleSTUDENT)})
		mux.Handle("/api/cards/{id}", httpx.Methods{http.MethodPatch: s.withUser(s.patchCard, store.RoleSTUDENT)})
		mux.Handle("/api/wrong-notes/cards", httpx.Methods{http.MethodPost: s.withUser(s.wrongNoteCards, store.RoleSTUDENT)})
	})
}

var (
	errCardNotFound    = apierr.New(404, "카드를 찾을 수 없어요.")
	errImageFormat     = apierr.New(400, "허용되지 않는 이미지 형식이에요.")
	errImageNotFound   = apierr.New(404, "업로드한 이미지를 찾을 수 없어요.")
	errBlindNeedsMasks = apierr.New(400, "이미지와 가림막을 추가해 주세요.")
	errReviewReused    = apierr.New(409, "이미 다른 복습에 사용된 요청이에요.")
	errReviewTime      = apierr.New(400, "복습 시간이 유효하지 않아요. 30일 이내 기록만 동기화할 수 있어요.")
	errReviewOrder     = apierr.New(409, "이미 동기화된 복습보다 이전 기록이에요. 최신 카드를 확인해 주세요.")
	errWrongNotes      = apierr.New(404, "복습할 오답을 찾을 수 없어요.")
	dataImage          = regexp.MustCompile(`^data:image/(png|jpeg|webp);base64,`)
)

type mask struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

func (s *Server) createCard(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		SubjectID string  `json:"subjectId"`
		Front     string  `json:"front"`
		Back      string  `json:"back"`
		Type      string  `json:"type"`
		Image     *string `json:"image"`
		Masks     *[]mask `json:"masks"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	v.id(in.SubjectID)
	in.Front = v.text(in.Front, 2000)
	in.Back = v.text(in.Back, 4000)
	v.enum(in.Type, "CONCEPT", "RELATION", "COMPARISON", "BLIND")
	if in.Image != nil {
		v.check(length(*in.Image) <= 2_000_000, msgInput)
	}
	if in.Masks != nil {
		v.check(len(*in.Masks) <= 100, msgInput)
		for _, m := range *in.Masks {
			v.check(m.X >= 0 && m.X <= 100 && m.Y >= 0 && m.Y <= 100 && m.Width > 0 && m.Width <= 100 && m.Height > 0 && m.Height <= 100 && m.X+m.Width <= 100.1 && m.Y+m.Height <= 100.1, msgInput)
		}
	}
	if err := v.result(); err != nil {
		return err
	}
	ctx := r.Context()
	if _, err := s.ownedSubject(ctx, user, in.SubjectID); err != nil {
		return err
	}
	if in.Image != nil && !dataImage.MatchString(*in.Image) && !strings.HasPrefix(*in.Image, "/api/uploads/") {
		return errImageFormat
	}
	if in.Image != nil && strings.HasPrefix(*in.Image, "/api/uploads/") {
		parts := strings.Split(*in.Image, "/")
		if _, err := s.q.GetOwnedImageUpload(ctx, store.GetOwnedImageUploadParams{ID: parts[len(parts)-1], UserID: user.ID}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errImageNotFound
			}
			return err
		}
	}
	if in.Type == "BLIND" && (in.Image == nil || in.Masks == nil || len(*in.Masks) == 0) {
		return errBlindNeedsMasks
	}
	masks := []byte("[]")
	if in.Masks != nil {
		masks, _ = json.Marshal(*in.Masks)
	}
	card, err := s.q.CreateCard(ctx, store.CreateCardParams{ID: ids.New(), UserID: user.ID, SubjectID: in.SubjectID, Front: in.Front, Back: in.Back, Type: store.CardType(in.Type), Image: in.Image, Masks: masks})
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusCreated, cardOf(card, nil))
	return nil
}

func (s *Server) patchCard(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		Deleted *bool   `json:"deleted"`
		Front   *string `json:"front"`
		Back    *string `json:"back"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	in.Front = v.optText(in.Front, 2000)
	in.Back = v.optText(in.Back, 4000)
	if err := v.result(); err != nil {
		return err
	}
	card, err := s.q.GetOwnedCard(r.Context(), store.GetOwnedCardParams{ID: r.PathValue("id"), UserID: user.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return errCardNotFound
	}
	if err != nil {
		return err
	}
	updated, err := s.q.UpdateCardFields(r.Context(), store.UpdateCardFieldsParams{ID: card.ID, Deleted: in.Deleted, Front: in.Front, Back: in.Back})
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, cardOf(updated, nil))
	return nil
}

// reviewCard records one review idempotently (reviewId) and reschedules the card with the same
// deterministic scheduler the browser runs offline.
func (s *Server) reviewCard(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		CardID     string   `json:"cardId"`
		Rating     string   `json:"rating"`
		ReviewID   string   `json:"reviewId"`
		ReviewedAt *float64 `json:"reviewedAt"`
		Mode       *string  `json:"mode"`
		Retention  *float64 `json:"retention"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	v.id(in.CardID)
	v.enum(in.Rating, "EASY", "GOOD", "HARD", "AGAIN")
	v.uuid(in.ReviewID)
	if in.ReviewedAt != nil {
		v.check(*in.ReviewedAt > 0 && *in.ReviewedAt == float64(int64(*in.ReviewedAt)), msgInput)
	}
	if in.Mode != nil {
		v.enum(*in.Mode, "FIXED", "FSRS")
	}
	if in.Retention != nil {
		v.floatRange(*in.Retention, srs.MinRetention, srs.MaxRetention)
	}
	if err := v.result(); err != nil {
		return err
	}
	ctx := r.Context()
	var result json.RawMessage
	err := s.locked(ctx, user.ID, func(tx pgx.Tx, q *store.Queries) error {
		previous, err := q.GetCardReview(ctx, in.ReviewID)
		if err == nil {
			if previous.UserID != user.ID || previous.CardID != in.CardID || previous.Rating != in.Rating {
				return errReviewReused
			}
			result = previous.Result
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		card, err := q.GetOwnedLiveCard(ctx, store.GetOwnedLiveCardParams{ID: in.CardID, UserID: user.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			return errCardNotFound
		}
		if err != nil {
			return err
		}
		now := s.now()
		reviewedAt := now
		if in.ReviewedAt != nil {
			reviewedAt = time.UnixMilli(int64(*in.ReviewedAt)).UTC()
		}
		// jitter: none — one device's queue; the client treats 400/404/409 as permanent and stops, so no loop [site server/internal/api/cards.go:195]
		if reviewedAt.After(now.Add(5*time.Minute)) || reviewedAt.Before(now.Add(-30*24*time.Hour)) {
			return errReviewTime
		}
		var stored *srs.Serialized
		if len(card.Fsrs) > 0 && string(card.Fsrs) != "null" {
			stored = &srs.Serialized{}
			if err := json.Unmarshal(card.Fsrs, stored); err != nil {
				return err
			}
			if stored.LastReview != "" {
				if last, err := srs.ParseISO(stored.LastReview); err == nil && reviewedAt.Before(last) {
					return errReviewOrder
				}
			}
		}
		lastEvent, err := q.LastCardReviewAt(ctx, store.LastCardReviewAtParams{CardID: card.ID, UserID: user.ID})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err == nil && reviewedAt.Before(lastEvent) {
			return errReviewOrder
		}
		prefs, err := q.GetUserPrefs(ctx, user.ID)
		if err != nil {
			return err
		}
		mode := "FIXED"
		if prefs.SrsMode == "FSRS" {
			mode = "FSRS"
		}
		if in.Mode != nil {
			mode = *in.Mode
		}
		retention := prefs.DesiredRetention
		if in.Retention != nil {
			retention = *in.Retention
		}
		scheduled, err := srs.Schedule(srs.Input{ConsecutiveEasy: int(card.ConsecutiveEasy), Bucket: string(card.Bucket), NextReviewAt: card.NextReviewAt, Fsrs: stored}, in.Rating, mode, retention, reviewedAt)
		if err != nil {
			return err
		}
		var fsrsJSON []byte
		if scheduled.Fsrs != nil {
			if fsrsJSON, err = json.Marshal(scheduled.Fsrs); err != nil {
				return err
			}
		}
		next, err := q.UpdateCardSchedule(ctx, store.UpdateCardScheduleParams{ID: card.ID, Bucket: store.Bucket(scheduled.Bucket), ConsecutiveEasy: int32(scheduled.ConsecutiveEasy), NextReviewAt: scheduled.NextReviewAt, Fsrs: fsrsJSON})
		if err != nil {
			return err
		}
		view, err := json.Marshal(cardOf(next, nil))
		if err != nil {
			return err
		}
		if err := q.CreateCardReview(ctx, store.CreateCardReviewParams{ID: in.ReviewID, UserID: user.ID, CardID: card.ID, Rating: in.Rating, Result: view, CreatedAt: reviewedAt}); err != nil {
			return err
		}
		result = view
		return nil
	})
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, result)
	return nil
}

// wrongNoteCards turns wrongly answered questions into cards, once per question.
func (s *Server) wrongNoteCards(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		QuestionIDs []string `json:"questionIds"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	v.check(len(in.QuestionIDs) >= 1 && len(in.QuestionIDs) <= 100, msgInput)
	for _, id := range in.QuestionIDs {
		v.id(id)
	}
	if err := v.result(); err != nil {
		return err
	}
	unique := []string{}
	seen := map[string]bool{}
	for _, id := range in.QuestionIDs {
		if !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	ctx := r.Context()
	rows, err := s.q.ListWrongQuestions(ctx, store.ListWrongQuestionsParams{Ids: unique, UserID: user.ID})
	if err != nil {
		return err
	}
	if len(rows) != len(unique) {
		return errWrongNotes
	}
	byID := map[string]store.Question{}
	for _, q := range rows {
		byID[q.ID] = q
	}
	created := []cardRow{}
	err = s.locked(ctx, user.ID, func(tx pgx.Tx, q *store.Queries) error {
		for _, id := range unique {
			question := byID[id]
			card, err := queueReviewQuestionCard(ctx, q, user.ID, question, time.Now())
			if err != nil {
				return err
			}
			created = append(created, cardRowOf(card))
		}
		return nil
	})
	if err != nil {
		return err
	}
	httpx.OK(w, http.StatusOK, created)
	return nil
}

// cardJSON is reused by bootstrap and generation.
var _ = jsonx.Format
