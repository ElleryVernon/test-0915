package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"memoryz/server/internal/config"
	"memoryz/server/internal/jitter"
)

// DefaultJevBaseURL is TypeSafe's API origin; tests point the client at a fake.
const DefaultJevBaseURL = "https://api.typesafe.ai"

// jevTimeout bounds one judgment call. The generator's call runs beside it and never waits longer.
const jevTimeout = 6 * time.Second

// jevPricePerMillionInput is the documented rate (docs.typesafe.ai/models); output tokens are free.
const jevPricePerMillionInput = 0.042

// jevStateLimit is the longest state (in runes) sent to the judge; the model's state budget is
// 32k tokens and a longer source falls back to the model-only path.
const jevStateLimit = 40_000

var (
	errJevUnavailable = errors.New("jev: judge not configured")
	errJevTooLong     = errors.New("jev: state too long for one judgment")
)

// JevQuestion is one typed question: noul (probability of yes), choice (one option with a
// distribution over the criteria) or score (ordered levels). Criteria describe the options.
type JevQuestion struct {
	Type         string `json:"type"`
	Instructions string `json:"instructions"`
	Criteria     any    `json:"criteria,omitempty"`
}

// JevAnswer is the model's answer to one question.
type JevAnswer struct {
	Type          string             `json:"type"`
	Noul          float64            `json:"noul"`
	Choice        string             `json:"choice"`
	Probabilities map[string]float64 `json:"probabilities"`
	Score         float64            `json:"score"`
	Confidence    float64            `json:"confidence"`
}

// JevResult is one judgment request's answers and accounting.
type JevResult struct {
	Answers     map[string]JevAnswer
	Model       string
	InputTokens int
	Duration    time.Duration
}

// Jev asks TypeSafe's System One model for judgments: probabilities and choices, never text. It
// runs beside the generator (the generator writes, Jev checks) and a failure is never fatal: the
// caller falls back to the model-only path. AI_JUDGE=off keeps it out entirely, shadow records its
// verdicts without acting on them, on lets agreement replace the separate review call.
type Jev struct {
	cfg     *config.Config
	baseURL string
	client  *http.Client
	log     *slog.Logger
}

// NewJev returns the judge for cfg; it is inert until TYPESAFE_API_KEY and AI_JUDGE are set.
func NewJev(cfg *config.Config, baseURL string, log *slog.Logger) *Jev {
	if baseURL == "" {
		baseURL = DefaultJevBaseURL
	}
	if log == nil {
		log = slog.Default()
	}
	return &Jev{cfg: cfg, baseURL: baseURL, client: &http.Client{Timeout: jevTimeout}, log: log}
}

// Available reports whether judgments run at all (a key and AI_JUDGE=shadow or on).
func (j *Jev) Available() bool { return j != nil && j.cfg != nil && j.cfg.JudgeAvailable() }

// Active reports whether a judgment may change behaviour (AI_JUDGE=on).
func (j *Jev) Active() bool { return j.Available() && j.cfg.AIJudge == "on" }

// Mode is the configured AI_JUDGE value, off when there is no judge.
func (j *Jev) Mode() string {
	if j == nil || j.cfg == nil {
		return "off"
	}
	return j.cfg.AIJudge
}

// Model is the requested model name.
func (j *Jev) Model() string {
	if j == nil || j.cfg == nil {
		return ""
	}
	return j.cfg.TypeSafeModel
}

// Ask sends one batch of questions over state. The model scores every question on its own, so
// batching changes cost and latency only. 429 and 529 are retried once after a short pause; any
// other failure returns at once. Like every paid model call it is recorded in the request's usage.
func (j *Jev) Ask(ctx context.Context, task string, state any, questions map[string]JevQuestion) (JevResult, error) {
	if !j.Available() {
		return JevResult{}, errJevUnavailable
	}
	if len(questions) == 0 {
		return JevResult{}, errors.New("jev: no questions")
	}
	body, err := json.Marshal(map[string]any{"state": state, "model": j.cfg.TypeSafeModel, "questions": questions})
	if err != nil {
		return JevResult{}, err
	}
	if len(body) > 4*jevStateLimit {
		return JevResult{}, errJevTooLong
	}
	ctx, cancel := context.WithTimeout(ctx, jevTimeout)
	defer cancel()
	started := time.Now()
	var res *http.Response
	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, j.baseURL+"/v1/systemone", bytes.NewReader(body))
		if err != nil {
			return JevResult{}, err
		}
		req.Header.Set("Authorization", "Bearer "+j.cfg.TypeSafeAPIKey)
		req.Header.Set("Content-Type", "application/json")
		res, err = j.client.Do(req)
		if err != nil {
			j.record(ctx, Usage{RequestedModel: j.cfg.TypeSafeModel, Task: task, Provider: "typesafe", TransportFailure: true})
			return JevResult{}, fmt.Errorf("jev: %w", err)
		}
		if (res.StatusCode == http.StatusTooManyRequests || res.StatusCode == 529) && attempt == 0 {
			_, _ = io.Copy(io.Discard, res.Body)
			_ = res.Body.Close()
			select {
			case <-ctx.Done():
				return JevResult{}, ctx.Err()
			// jitter: window judge 429/529: one re-send after U[300 ms, 600 ms); a refused judgment was never billed [site server/internal/ai/jev.go:429-window]
			case <-time.After(jitter.Between(jitter.Std, 300*time.Millisecond, 600*time.Millisecond)):
			}
			continue
		}
		break
	}
	defer res.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return JevResult{}, fmt.Errorf("jev: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		j.record(ctx, Usage{RequestedModel: j.cfg.TypeSafeModel, Task: task, Provider: "typesafe", HTTPStatus: res.StatusCode})
		return JevResult{}, fmt.Errorf("jev: HTTP %d", res.StatusCode)
	}
	var decoded struct {
		Model   string               `json:"model"`
		Answers map[string]JevAnswer `json:"answers"`
		Usage   struct {
			InputTokens int `json:"input_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return JevResult{}, fmt.Errorf("jev: %w", err)
	}
	if len(decoded.Answers) != len(questions) {
		return JevResult{}, fmt.Errorf("jev: %d answers for %d questions", len(decoded.Answers), len(questions))
	}
	for id := range questions {
		if _, ok := decoded.Answers[id]; !ok {
			return JevResult{}, fmt.Errorf("jev: no answer for %s", id)
		}
	}
	cost := float64(decoded.Usage.InputTokens) / 1e6 * jevPricePerMillionInput
	j.record(ctx, Usage{
		RequestedModel: j.cfg.TypeSafeModel, Model: decoded.Model, ModelReported: decoded.Model != "", ProviderReported: true,
		HTTPStatus: res.StatusCode, Task: task, Provider: "typesafe", PromptTokens: decoded.Usage.InputTokens, Cost: &cost,
		DurationMs: time.Since(started).Milliseconds(),
	})
	return JevResult{Answers: decoded.Answers, Model: decoded.Model, InputTokens: decoded.Usage.InputTokens, Duration: time.Since(started)}, nil
}

func (j *Jev) record(ctx context.Context, u Usage) {
	if c, ok := ctx.Value(usageKey{}).(*UsageCollector); ok {
		c.add(u)
	}
}

// noteJudgment leaves a one-line event in the request's record: the verdict, never the answer.
func noteJudgment(ctx context.Context, reason string) {
	if c, ok := ctx.Value(usageKey{}).(*UsageCollector); ok {
		c.note(Retry{Kind: "judge", Reason: reason})
	}
}
