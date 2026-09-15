package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"memoryz/server/internal/ai"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/db"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/jsonx"
	"memoryz/server/internal/store"
)

// runLease is how long a RUNNING record may go without progress before it is declared interrupted.
// jitter: none — checked only when that user starts or reads a run; a stale run expires by query, not a timer
const runLease = 5 * time.Minute

var (
	errRunNotFound   = apierr.New(404, "AI 작업을 찾을 수 없어요.")
	errRunMismatch   = apierr.New(409, "같은 요청 번호에 다른 내용이 담겼어요. 새 작업으로 시작해 주세요.")
	errRunInProgress = apierr.New(409, "이미 처리 중인 AI 작업이에요. 작업 상태를 확인해 주세요.")
	errRunFinished   = apierr.New(409, "이미 종료된 AI 작업이에요. 작업 상태를 확인해 주세요.")
	errRunClosed     = apierr.New(409, "이미 종료된 AI 작업은 저장할 수 없어요.")
	errRunUnsaved    = apierr.New(500, "AI 작업 결과가 저장되지 않았어요.")
	errRunFailed     = apierr.New(500, "AI 작업을 완료하지 못했어요. 새 작업으로 다시 시도해 주세요.")
	msgRunEnded      = "이 작업은 종료됐어요. 새 작업으로 다시 시작해 주세요."
	msgInterrupted   = "실행이 중단됐어요. 자동으로 다시 요청하지 않았어요. 내용을 확인하고 새로 시작해 주세요."
	// errInterrupted answers a run this instance cut short at shutdown. Up to 25 learners hear it
	// in the same second; the hint spreads their paid re-taps over 10 s behind the admission queue.
	// jitter: retry-after 10 s + U[0,10 s) for the runs one shutdown interrupts together
	errInterrupted = apierr.New(503, msgInterrupted).Retry(retryMin, retrySpread)
	// errDraining is the cancel cause Drain gives the runs it interrupts.
	errDraining = errors.New("server draining")
)

// A recorded run that was interrupted, or failed with 429 or 504 (transient), tells a device that
// lost the POST response when to retry: max(0, finishedAt + 10 s − now) + U[0, 10 s), at least 1 s.
const retryMin, retrySpread = 10 * time.Second, 10 * time.Second

// recordBound bounds the writes that record a run's end on a context detached from the request, so
// a stalled database cannot hold the handler (or a shutdown) open.
const recordBound = 2 * time.Second

// runRetry is the hint a stored failure carries, if any.
func (s *Server) runRetry(run store.AiRun) (*apierr.Error, bool) {
	transientFailure := run.Status == "FAILED" && run.ErrorStatus != nil && (*run.ErrorStatus == 429 || *run.ErrorStatus == 504)
	hinted := run.Status == "INTERRUPTED" || transientFailure
	if !hinted || run.FinishedAt == nil {
		return nil, false
	}
	status, message := 409, msgRunEnded
	if run.ErrorStatus != nil {
		status = int(*run.ErrorStatus)
	}
	if run.Error != nil {
		message = *run.Error
	}
	// jitter: retry-after max(0, finishedAt + 10 s − now) + U[0,10 s) for a stored failure, on replay or read
	return apierr.New(status, message).Retry(max(0, run.FinishedAt.Add(retryMin).Sub(s.now())), retrySpread), true
}

// Drain interrupts every AI run this instance is executing (at SIGTERM + httpx.DrainAfter) and any
// that starts afterwards. Each records INTERRUPTED itself and answers errInterrupted.
func (s *Server) Drain() {
	s.draining.Store(true)
	s.runs.Range(func(_, cancel any) bool {
		cancel.(context.CancelCauseFunc)(errDraining)
		return true
	})
}

// inputHash identifies a request's content the way the previous server did: sha256 of
// JSON.stringify({kind, input}) with the input's keys sorted recursively.
func inputHash(kind ai.Kind, input any) string {
	canonical := canonicalJSON(input)
	sum := sha256.Sum256([]byte(`{"kind":"` + string(kind) + `","input":` + canonical + `}`))
	return hex.EncodeToString(sum[:])
}

func canonicalJSON(v any) string {
	raw, _ := json.Marshal(v)
	var decoded any
	_ = json.Unmarshal(raw, &decoded)
	var b strings.Builder
	writeCanonical(&b, decoded)
	return b.String()
}

func writeCanonical(b *strings.Builder, v any) {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			key, _ := json.Marshal(k)
			b.Write(key)
			b.WriteByte(':')
			writeCanonical(b, t[k])
		}
		b.WriteByte('}')
	case []any:
		b.WriteByte('[')
		for i, item := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			writeCanonical(b, item)
		}
		b.WriteByte(']')
	default:
		var buf strings.Builder
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(t)
		b.WriteString(strings.TrimSuffix(buf.String(), "\n"))
	}
}

// runOutcome is what a finished (or replayed) run gives back.
type runOutcome struct {
	result    json.RawMessage
	requestID string
	replayed  bool
}

// execution is handed to the work function: the staged runtime and the commit step.
type execution struct {
	s     *Server
	rt    *ai.Runtime
	runID string
	done  bool
}

// commit is the COMMIT stage: persist runs inside a transaction that holds the run row, and the
// result is stored with the record so the same request id replays it.
func (ex *execution) commit(ctx context.Context, persist func(ctx context.Context, tx pgx.Tx, q *store.Queries) (any, error)) (any, error) {
	return ai.Tool(ctx, ex.rt, "COMMIT", func(ctx context.Context) (any, error) {
		var value any
		err := db.Tx(ctx, ex.s.pool, func(tx pgx.Tx) error {
			q := ex.s.q.WithTx(tx)
			current, err := q.LockAiRun(ctx, ex.runID)
			if err != nil {
				return err
			}
			if current.Status != "RUNNING" {
				return errRunClosed
			}
			value, err = persist(ctx, tx, q)
			if err != nil {
				return err
			}
			finished := ex.s.now()
			steps := make([]ai.Step, len(ex.rt.Steps))
			copy(steps, ex.rt.Steps)
			for i := range steps {
				if steps[i].Stage == "COMMIT" {
					started, _ := time.Parse(time.RFC3339Nano, steps[i].StartedAt)
					finishedAt := jsonx.Format(finished)
					duration := finished.UnixMilli() - started.UnixMilli()
					steps[i].Status = "COMPLETED"
					steps[i].FinishedAt = &finishedAt
					steps[i].DurationMs = &duration
				}
			}
			resultJSON, err := json.Marshal(value)
			if err != nil {
				return err
			}
			stepsJSON, err := json.Marshal(steps)
			if err != nil {
				return err
			}
			return q.CompleteAiRun(ctx, store.CompleteAiRunParams{ID: ex.runID, Result: resultJSON, Steps: stepsJSON, FinishedAt: &finished})
		})
		if err != nil {
			return nil, err
		}
		ex.done = true
		return value, nil
	})
}

// executeRun claims the request id, runs work through the staged runtime and records the outcome;
// a repeated request id replays the stored result or the stored failure.
func (s *Server) executeRun(ctx context.Context, userID string, requestID string, kind ai.Kind, input any, work func(ctx context.Context, ex *execution) (any, error)) (runOutcome, error) {
	if requestID == "" {
		requestID = ids.New()
	}
	hash := inputHash(kind, input)
	now := s.now()
	if err := s.q.ExpireStaleRuns(ctx, store.ExpireStaleRunsParams{Error: ptr(msgInterrupted), Now: &now, UserID: userID, StaleBefore: now.Add(-runLease)}); err != nil {
		return runOutcome{}, err
	}
	model := "unconfigured"
	if s.ai.Available() {
		model = s.ai.Model()
	} else if kind == ai.KindGrade || kind == ai.KindPlanner {
		model = "local-rules"
	}
	// Only a request id this account has never used spends budget: a replay, a repeat of a failed
	// run or a check on one in progress costs nothing. A refusal leaves no AiRun row, so the client
	// may send the same request id again once the wait is over and it still runs at most once.
	claimed := false
	run, err := s.q.GetAiRun(ctx, store.GetAiRunParams{UserID: userID, RequestID: requestID})
	if errors.Is(err, pgx.ErrNoRows) {
		// The claim runs under a lock on this request id: concurrent requests with the same new id
		// (a double tap, a retried send) wait here and then find the claim, so only the first one
		// spends budget. A refusal rolls back and leaves no row.
		err = db.Tx(ctx, s.pool, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "airun:"+userID+":"+requestID); err != nil {
				return err
			}
			q := s.q.WithTx(tx)
			if _, err := q.GetAiRun(ctx, store.GetAiRunParams{UserID: userID, RequestID: requestID}); !errors.Is(err, pgx.ErrNoRows) {
				return err // claimed while this request waited (nil), or a real error
			}
			if err := s.aiBudget(ctx, userID); err != nil {
				return err
			}
			err := q.CreateAiRun(ctx, store.CreateAiRunParams{ID: ids.New(), UserID: userID, RequestID: requestID, Kind: string(kind), InputHash: hash, SkillVersion: ai.Skills[kind].Version, Model: model, StartedAt: now})
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return nil // claimed without the lock (never by this code); treat as not ours
			}
			claimed = err == nil
			return err
		})
		if err != nil {
			return runOutcome{}, err
		}
		run, err = s.q.GetAiRun(ctx, store.GetAiRunParams{UserID: userID, RequestID: requestID})
	}
	if err != nil {
		return runOutcome{}, err
	}
	if !claimed {
		if run.Kind != string(kind) || run.InputHash != hash {
			return runOutcome{}, errRunMismatch
		}
		switch run.Status {
		case "COMPLETED":
			return runOutcome{result: run.Result, requestID: requestID, replayed: true}, nil
		case "RUNNING":
			return runOutcome{}, errRunInProgress
		}
		if hinted, ok := s.runRetry(run); ok {
			return runOutcome{}, hinted
		}
		status, message := 409, msgRunEnded
		if run.ErrorStatus != nil {
			status = int(*run.ErrorStatus)
		}
		if run.Error != nil {
			message = *run.Error
		}
		return runOutcome{}, apierr.New(status, message)
	}
	rt := ai.NewRuntime(kind, func(ctx context.Context, steps []ai.Step) error {
		if last := steps[len(steps)-1]; last.Stage == "COMMIT" && last.Status == "COMPLETED" {
			return nil
		}
		raw, err := json.Marshal(steps)
		if err != nil {
			return err
		}
		changed, err := s.q.UpdateAiRunSteps(ctx, store.UpdateAiRunStepsParams{ID: run.ID, Steps: raw, UpdatedAt: s.now()})
		if err != nil {
			return err
		}
		if changed == 0 {
			return errRunFinished
		}
		return nil
	})
	// The work runs on a context Drain can cancel with its own cause.
	workCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	s.runs.Store(run.ID, cancel)
	defer s.runs.Delete(run.ID)
	if s.draining.Load() {
		cancel(errDraining)
	}
	ex := &execution{s: s, rt: rt, runID: run.ID}
	_, workErr := work(ai.WithRuntime(workCtx, rt), ex)
	if errors.Is(context.Cause(workCtx), errDraining) && !ex.done {
		// Interrupted by this instance's shutdown: record it and answer with the spread hint.
		record, stop := context.WithTimeout(context.WithoutCancel(ctx), recordBound)
		defer stop()
		finished := s.now()
		_, _ = s.q.InterruptAiRun(record, store.InterruptAiRunParams{ID: run.ID, Error: ptr(msgInterrupted), FinishedAt: &finished})
		return runOutcome{}, errInterrupted
	}
	if workErr == nil && !ex.done {
		workErr = errRunUnsaved
	}
	if workErr != nil {
		safe := httpx.Translate(workErr)
		if safe == apierr.ErrInternal {
			safe = errRunFailed
		}
		finished := s.now()
		status := int32(safe.Status)
		// jitter: none — an unbounded wait, not a herd; now bounded at 2 s on a detached context [site server/internal/api/airuns.go:238]
		record, stop := context.WithTimeout(context.WithoutCancel(ctx), recordBound)
		defer stop()
		_, _ = s.q.FailAiRun(record, store.FailAiRunParams{ID: run.ID, Error: ptr(safe.Message), ErrorStatus: &status, FinishedAt: &finished})
		return runOutcome{}, safe
	}
	saved, err := s.q.GetAiRun(ctx, store.GetAiRunParams{UserID: userID, RequestID: requestID})
	if err != nil {
		return runOutcome{}, err
	}
	return runOutcome{result: saved.Result, requestID: requestID}, nil
}

type aiRunView struct {
	RequestID    string          `json:"requestId"`
	Kind         string          `json:"kind"`
	Model        string          `json:"model"`
	SkillVersion string          `json:"skillVersion"`
	Status       string          `json:"status"`
	Result       json.RawMessage `json:"result"`
	Error        *string         `json:"error"`
	ErrorStatus  *int32          `json:"errorStatus"`
	Steps        json.RawMessage `json:"steps"`
	StartedAt    jsonx.Time      `json:"startedAt"`
	FinishedAt   *jsonx.Time     `json:"finishedAt"`
	UpdatedAt    jsonx.Time      `json:"updatedAt"`
	// RetryAfterMs is when an interrupted run or one the provider refused may be retried by hand.
	RetryAfterMs *int64 `json:"retryAfterMs,omitempty"`
}

func rawOrNull(raw []byte) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("null")
	}
	return json.RawMessage(raw)
}

func (s *Server) readAiRun(w http.ResponseWriter, r *http.Request, user store.User) error {
	requestID := r.PathValue("id")
	if !uuidShape.MatchString(requestID) {
		return errRunNotFound
	}
	ctx := r.Context()
	now := s.now()
	if err := s.q.ExpireStaleRuns(ctx, store.ExpireStaleRunsParams{Error: ptr(msgInterrupted), Now: &now, UserID: user.ID, StaleBefore: now.Add(-runLease)}); err != nil {
		return err
	}
	run, err := s.q.GetAiRun(ctx, store.GetAiRunParams{UserID: user.ID, RequestID: requestID})
	if errors.Is(err, pgx.ErrNoRows) {
		return errRunNotFound
	}
	if err != nil {
		return err
	}
	steps := rawOrNull(run.Steps)
	if string(steps) == "null" {
		steps = json.RawMessage("[]")
	}
	view := aiRunView{
		RequestID: run.RequestID, Kind: run.Kind, Model: run.Model, SkillVersion: run.SkillVersion, Status: run.Status,
		Result: rawOrNull(run.Result), Error: run.Error, ErrorStatus: run.ErrorStatus, Steps: steps,
		StartedAt: jsonx.Time(run.StartedAt), FinishedAt: jsonx.TimePtr(run.FinishedAt), UpdatedAt: jsonx.Time(run.UpdatedAt),
	}
	if hinted, ok := s.runRetry(run); ok {
		// Drawn per read with the one hint formula (httpx.RetryAfter): devices polling the same
		// failure do not line up on one instant.
		wait, _ := httpx.RetryAfter(hinted, s.rand)
		ms := wait.Milliseconds()
		view.RetryAfterMs = &ms
	}
	httpx.OK(w, http.StatusOK, view)
	return nil
}
