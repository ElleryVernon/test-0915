package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"memoryz/server/internal/ai"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/learning"
	"memoryz/server/internal/planner"
	"memoryz/server/internal/ratelimit"
	"memoryz/server/internal/srs"
	"memoryz/server/internal/store"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/generate", httpx.Methods{http.MethodPost: httpx.Deadline(aiTimeout, s.withUser(s.generate, store.RoleSTUDENT))})
		mux.Handle("/api/quiz/answer", httpx.Methods{http.MethodPost: s.withUser(s.answerQuiz, store.RoleSTUDENT)})
		mux.Handle("/api/essay/submit", httpx.Methods{http.MethodPost: httpx.Deadline(aiTimeout, s.withUser(s.submitEssay, store.RoleSTUDENT))})
		mux.Handle("/api/planner/suggest", httpx.Methods{http.MethodPost: httpx.Deadline(aiTimeout, s.withUser(s.suggestPlans, store.RoleSTUDENT))})
		mux.Handle("/api/ai-runs/{id}", httpx.Methods{http.MethodGet: s.withUser(s.readAiRun)})
	})
}

// aiTimeout bounds one model-backed request end to end (the provider itself waits up to 120s).
const aiTimeout = 180 * time.Second

var (
	errQuestionNotFound = apierr.New(404, "문제를 찾을 수 없어요.")
	errMaterialTooShort = apierr.New(400, "학습 자료에 본문을 20자 이상 추가해 주세요.")
	errMaterialChanged  = apierr.New(409, "생성 중 학습 자료가 변경됐어요. 최신 자료를 확인하고 다시 시도해 주세요.")
	ruleGradeMethod     = "키워드·순서 기반 연습 채점"
)

// errAIDaily is the daily budget's refusal: its own code and the exact time it frees up.
var errAIDaily = apierr.WithCode(429, "오늘 사용할 수 있는 AI 요청을 모두 썼어요. 내일 다시 시도해 주세요.", "AI_DAILY_LIMIT")

// aiBudget applies the per-student model budget. Only paid requests count, and executeRun charges
// it only for a request id this account has never used.
func (s *Server) aiBudget(ctx context.Context, userID string) error {
	if !s.ai.Available() {
		return nil
	}
	// Under DEMO_MODE every trying student is demo-student, so 25 generations at the bell refuse 15;
	// the refusal's spread turns their single release edge into about one request a second.
	// jitter: retry-after rest of the minute + U[0,15 s) from ratelimit.Check [site server/internal/api/study.go:49]
	if err := ratelimit.Check(ctx, s.cache, "ai:m:"+userID, int64(s.cfg.AIRatePerMinute), time.Minute); err != nil {
		return err
	}
	// jitter: retry-after exact rest of the day (spread 0): one student's own release edge [site server/internal/api/study.go:52]
	if ok, left := ratelimit.Allow(ctx, s.cache, "ai:d:"+userID, int64(s.cfg.AIRatePerDay), 24*time.Hour); !ok {
		return errAIDaily.Retry(left, 0)
	}
	return nil
}

func (s *Server) generate(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		MaterialID string   `json:"materialId"`
		Count      *float64 `json:"count"`
		Mode       string   `json:"mode"`
		RequestID  *string  `json:"requestId"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	v.id(in.MaterialID)
	count := 0
	if in.Count == nil {
		v.fail(msgInput)
	} else {
		count = v.intRange(*in.Count, 1, 10)
	}
	v.enum(in.Mode, "quiz", "essay", "cards")
	requestID := ""
	if in.RequestID != nil {
		requestID = v.uuid(*in.RequestID)
	}
	if err := v.result(); err != nil {
		return err
	}
	kind := ai.Kind(in.Mode)
	hashInput := map[string]any{"materialId": in.MaterialID, "count": count, "mode": in.Mode}
	type loaded struct {
		content   string
		subjectID string
	}
	outcome, err := s.executeRun(r.Context(), user.ID, requestID, kind, hashInput, func(ctx context.Context, ex *execution) (any, error) {
		material, err := ai.Tool(ctx, ex.rt, "LOAD_CONTEXT", func(ctx context.Context) (loaded, error) {
			row, err := s.q.GetMaterialContent(ctx, store.GetMaterialContentParams{ID: in.MaterialID, UserID: user.ID})
			if errors.Is(err, pgx.ErrNoRows) {
				return loaded{}, errMaterialNotFound
			}
			if err != nil {
				return loaded{}, err
			}
			if length(strings.TrimSpace(row.Content)) < 20 {
				return loaded{}, errMaterialTooShort
			}
			return loaded{content: row.Content, subjectID: row.SubjectID}, nil
		})
		if err != nil {
			return nil, err
		}
		items, err := ai.GenerateItems(ctx, s.ai, material.content, kind, count)
		if err != nil {
			return nil, err
		}
		return ex.commit(ctx, func(ctx context.Context, tx pgx.Tx, q *store.Queries) (any, error) {
			current, err := q.GetMaterialContent(ctx, store.GetMaterialContentParams{ID: in.MaterialID, UserID: user.ID})
			if errors.Is(err, pgx.ErrNoRows) || (err == nil && (current.Content != material.content || current.SubjectID != material.subjectID)) {
				return nil, errMaterialChanged
			}
			if err != nil {
				return nil, err
			}
			created := []any{}
			for _, item := range items.Questions {
				row, err := q.CreateQuestion(ctx, store.CreateQuestionParams{ID: ids.New(), UserID: user.ID, SubjectID: material.subjectID, MaterialID: in.MaterialID, Prompt: item.Prompt, Options: item.Options, Answer: int32(item.Answer), Explanation: item.Explanation, Citation: item.Citation, Past: item.Past, Future: item.Future})
				if err != nil {
					return nil, err
				}
				// Attach deterministic, validated metadata without another paid model request.
				var generated []byte
				if item.LearningExplanation != nil {
					item.LearningExplanation.QuestionID = row.ID
					generated, _ = json.Marshal(item.LearningExplanation)
				}
				explanation := learning.Resolve(row.ID, row.Citation, material.content, row.Options, int(row.Answer), generated)
				if explanation.Status == "READY" {
					raw, _ := json.Marshal(explanation)
					if err := q.SetQuestionExplanation(ctx, store.SetQuestionExplanationParams{ID: row.ID, LearningExplanation: raw}); err != nil {
						return nil, err
					}
				}
				created = append(created, questionOf(row))
			}
			for _, item := range items.Essays {
				row, err := q.CreateEssay(ctx, store.CreateEssayParams{ID: ids.New(), UserID: user.ID, SubjectID: material.subjectID, MaterialID: in.MaterialID, Prompt: item.Prompt, Keywords: item.Keywords, Distractors: item.Distractors, ModelAnswer: item.ModelAnswer, Citation: item.Citation})
				if err != nil {
					return nil, err
				}
				created = append(created, essayOf(row))
			}
			for _, item := range items.Cards {
				row, err := q.CreateGeneratedCard(ctx, store.CreateGeneratedCardParams{ID: ids.New(), UserID: user.ID, SubjectID: material.subjectID, Front: item.Front, Back: item.Back + "\n\n근거: " + item.Citation, Type: store.CardType(item.Type), MaterialID: &in.MaterialID})
				if err != nil {
					return nil, err
				}
				created = append(created, cardRowOf(row))
			}
			return created, nil
		})
	})
	if err != nil {
		return err
	}
	w.Header().Set("X-AI-Request-Id", outcome.requestID)
	httpx.OK(w, http.StatusCreated, json.RawMessage(outcome.result))
	return nil
}

func (s *Server) answerQuiz(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		QuestionID string   `json:"questionId"`
		Answer     *float64 `json:"answer"`
		ResponseMs *float64 `json:"responseMs"`
		RequestID  *string  `json:"requestId"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	v.id(in.QuestionID)
	answer := 0
	if in.Answer == nil {
		v.fail(msgInput)
	} else {
		answer = v.intRange(*in.Answer, -1, 4)
	}
	var responseMs *int32
	if in.ResponseMs != nil {
		ms := int32(v.intRange(*in.ResponseMs, 0, 86400000))
		responseMs = &ms
	}
	if in.RequestID != nil {
		v.uuid(*in.RequestID)
	}
	if err := v.result(); err != nil {
		return err
	}
	ctx := r.Context()
	question, err := s.q.GetOwnedQuestion(ctx, store.GetOwnedQuestionParams{ID: in.QuestionID, UserID: user.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return errQuestionNotFound
	}
	if err != nil {
		return err
	}
	if answer >= len(question.Options) {
		return apierr.New(400, "문제에 있는 선택지를 골라 주세요.")
	}
	correct := int32(answer) == question.Answer
	score := int32(0)
	if correct {
		score = 100
	}
	attemptID := ""
	err = s.locked(ctx, user.ID, func(tx pgx.Tx, q *store.Queries) error {
		if in.RequestID != nil {
			previous, e := q.GetAttemptByRequest(ctx, store.GetAttemptByRequestParams{UserID: user.ID, RequestID: in.RequestID})
			if e == nil {
				if previous.QuestionID == nil || *previous.QuestionID != question.ID || previous.Answer != strconv.Itoa(answer) {
					return apierr.New(409, "이미 다른 답에 사용된 요청이에요.")
				}
				attemptID = previous.ID
				return nil
			}
			if !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
		}
		attemptID = ids.New()
		if _, e := q.CreateAttempt(ctx, store.CreateAttemptParams{ID: attemptID, UserID: user.ID, QuestionID: &question.ID, Answer: strconv.Itoa(answer), Correct: correct, Score: score}); e != nil {
			return e
		}
		return q.SetAttemptMetadata(ctx, store.SetAttemptMetadataParams{ID: attemptID, ResponseMs: responseMs, RequestID: in.RequestID})
	})
	if err != nil {
		return err
	}
	httpx.OK(w, 200, map[string]any{"correct": correct, "explanation": question.Explanation, "citation": question.Citation, "attemptId": attemptID})
	return nil
}

// ruleGrade is the rule-based grading result (no model): the same fields plus the method label.
type ruleGrade struct {
	Score    int      `json:"score"`
	Matched  []string `json:"matched"`
	Missing  []string `json:"missing"`
	Feedback string   `json:"feedback"`
	Method   string   `json:"method"`
}

func (s *Server) submitEssay(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		EssayID   string  `json:"essayId"`
		Answer    string  `json:"answer"`
		RequestID *string `json:"requestId"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	v.id(in.EssayID)
	in.Answer = v.text(in.Answer, 10_000)
	requestID := ""
	if in.RequestID != nil {
		requestID = v.uuid(*in.RequestID)
	}
	if err := v.result(); err != nil {
		return err
	}
	hashInput := map[string]any{"essayId": in.EssayID, "answer": in.Answer}
	outcome, err := s.executeRun(r.Context(), user.ID, requestID, ai.KindGrade, hashInput, func(ctx context.Context, ex *execution) (any, error) {
		essay, err := ai.Tool(ctx, ex.rt, "LOAD_CONTEXT", func(ctx context.Context) (store.Essay, error) {
			row, err := s.q.GetOwnedEssay(ctx, store.GetOwnedEssayParams{ID: in.EssayID, UserID: user.ID})
			if errors.Is(err, pgx.ErrNoRows) {
				return store.Essay{}, errQuestionNotFound
			}
			return row, err
		})
		if err != nil {
			return nil, err
		}
		var result any
		var score int
		if s.ai.Available() {
			graded, err := ai.GradeWithAI(ctx, s.ai, ai.GradeInput{Prompt: essay.Prompt, Keywords: essay.Keywords, ModelAnswer: essay.ModelAnswer, Citation: essay.Citation, Answer: in.Answer})
			if err != nil {
				return nil, err
			}
			result, score = graded, graded.Score
		} else {
			graded, err := ai.Rule(ctx, ai.KindGrade, func() (ruleGrade, error) {
				g := planner.GradeEssay(in.Answer, essay.Keywords, essay.ModelAnswer)
				return ruleGrade{Score: g.Score, Matched: g.Matched, Missing: g.Missing, Feedback: g.Feedback, Method: ruleGradeMethod}, nil
			})
			if err != nil {
				return nil, err
			}
			result, score = graded, graded.Score
		}
		return ex.commit(ctx, func(ctx context.Context, tx pgx.Tx, q *store.Queries) (any, error) {
			if _, err := q.CreateAttempt(ctx, store.CreateAttemptParams{ID: ids.New(), UserID: user.ID, EssayID: &essay.ID, Answer: in.Answer, Correct: score == 100, Score: int32(score)}); err != nil {
				return nil, err
			}
			return result, nil
		})
	})
	if err != nil {
		return err
	}
	w.Header().Set("X-AI-Request-Id", outcome.requestID)
	httpx.OK(w, http.StatusOK, json.RawMessage(outcome.result))
	return nil
}

// rulePlans is the rule-based planner result: plans and the method label, no drop count.
type rulePlans struct {
	Plans  []planner.Plan `json:"plans"`
	Method string         `json:"method"`
}

func (s *Server) suggestPlans(w http.ResponseWriter, r *http.Request, user store.User) error {
	var in struct {
		Date      string  `json:"date"`
		After     *string `json:"after"`
		RequestID *string `json:"requestId"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	v := &validator{}
	v.date(in.Date)
	if in.After != nil {
		v.clock(*in.After)
	}
	requestID := ""
	if in.RequestID != nil {
		requestID = v.uuid(*in.RequestID)
	}
	if err := v.result(); err != nil {
		return err
	}
	hashInput := map[string]any{"date": in.Date}
	if in.After != nil {
		hashInput["after"] = *in.After
	}
	type loaded struct {
		schedules []store.Schedule
		subjects  []planner.PlanSubject
	}
	outcome, err := s.executeRun(r.Context(), user.ID, requestID, ai.KindPlanner, hashInput, func(ctx context.Context, ex *execution) (any, error) {
		data, err := ai.Tool(ctx, ex.rt, "LOAD_CONTEXT", func(ctx context.Context) (loaded, error) {
			schedules, err := s.q.ListSchedulesOnDate(ctx, store.ListSchedulesOnDateParams{UserID: user.ID, Date: in.Date, ID: ""})
			if err != nil {
				return loaded{}, err
			}
			subjects, err := s.q.ListLiveSubjects(ctx, user.ID)
			if err != nil {
				return loaded{}, err
			}
			cards, err := s.q.ListLiveCardsForPlanner(ctx, user.ID)
			if err != nil {
				return loaded{}, err
			}
			now := s.now()
			due := map[string]int{}
			for _, card := range cards {
				var fsrs *srs.Serialized
				if len(card.Fsrs) > 0 && string(card.Fsrs) != "null" {
					fsrs = &srs.Serialized{}
					if json.Unmarshal(card.Fsrs, fsrs) != nil {
						fsrs = nil
					}
				}
				if srs.IsDue(card.Deleted, string(card.Bucket), fsrs, card.NextReviewAt, now) {
					due[card.SubjectID]++
				}
			}
			plan := make([]planner.PlanSubject, 0, len(subjects))
			for _, subject := range subjects {
				plan = append(plan, planner.PlanSubject{ID: subject.ID, Name: subject.Name, DueCards: due[subject.ID]})
			}
			return loaded{schedules: schedules, subjects: plan}, nil
		})
		if err != nil {
			return nil, err
		}
		dated := make([]planner.Dated, 0, len(data.schedules))
		existing := make([]ai.PlanExisting, 0, len(data.schedules))
		for _, sch := range data.schedules {
			dated = append(dated, planner.Dated{Date: sch.Date, Start: sch.Start, End: sch.End})
			existing = append(existing, ai.PlanExisting{Date: sch.Date, Start: sch.Start, End: sch.End, Title: sch.Title})
		}
		var result any
		if s.ai.Available() {
			result, err = ai.PlanWithAI(ctx, s.ai, in.Date, existing, data.subjects, in.After)
		} else {
			result, err = ai.Rule(ctx, ai.KindPlanner, func() (rulePlans, error) {
				plans := planner.ProposePlans(in.Date, dated, data.subjects, in.After)
				return rulePlans{Plans: plans.Plans, Method: planner.RuleMethod}, nil
			})
		}
		if err != nil {
			return nil, err
		}
		return ex.commit(ctx, func(context.Context, pgx.Tx, *store.Queries) (any, error) { return result, nil })
	})
	if err != nil {
		return err
	}
	w.Header().Set("X-AI-Request-Id", outcome.requestID)
	httpx.OK(w, http.StatusOK, json.RawMessage(outcome.result))
	return nil
}
