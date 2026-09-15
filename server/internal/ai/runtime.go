package ai

import (
	"context"
	"time"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/jsonx"
)

// Step is one recorded stage of a run (AiRun.steps).
type Step struct {
	Stage      string  `json:"stage"`
	Status     string  `json:"status"`
	StartedAt  string  `json:"startedAt"`
	FinishedAt *string `json:"finishedAt,omitempty"`
	DurationMs *int64  `json:"durationMs,omitempty"`
}

var (
	errStage      = apierr.New(500, "허용되지 않은 AI 실행 단계예요.")
	errSkillMatch = apierr.New(500, "AI 작업 유형과 실행 스킬이 달라요.")
)

// Runtime walks the stages in order and persists the record after every change.
type Runtime struct {
	Kind    Kind
	Steps   []Step
	persist func(ctx context.Context, steps []Step) error
	now     func() time.Time
}

// NewRuntime returns a runtime; persist may be nil for runs that leave no record (OCR on upload).
func NewRuntime(kind Kind, persist func(ctx context.Context, steps []Step) error) *Runtime {
	return &Runtime{Kind: kind, Steps: []Step{}, persist: persist, now: time.Now}
}

func (rt *Runtime) save(ctx context.Context) error {
	if rt.persist == nil {
		return nil
	}
	return rt.persist(ctx, rt.Steps)
}

func (rt *Runtime) finish(step *Step, status string) {
	end := rt.now()
	started, _ := time.Parse(time.RFC3339Nano, step.StartedAt)
	finished := jsonx.Format(end)
	duration := end.UnixMilli() - started.UnixMilli()
	step.Status = status
	step.FinishedAt = &finished
	step.DurationMs = &duration
}

// Tool runs one stage; the stage must be the next one in order.
func Tool[T any](ctx context.Context, rt *Runtime, stage string, execute func(ctx context.Context) (T, error)) (T, error) {
	var zero T
	if len(rt.Steps) >= len(Stages) || stage != Stages[len(rt.Steps)] {
		return zero, errStage
	}
	rt.Steps = append(rt.Steps, Step{Stage: stage, Status: "RUNNING", StartedAt: jsonx.Format(rt.now())})
	if err := rt.save(ctx); err != nil {
		return zero, err
	}
	out, err := execute(ctx)
	step := &rt.Steps[len(rt.Steps)-1]
	if err != nil {
		rt.finish(step, "FAILED")
		_ = rt.save(ctx)
		return zero, err
	}
	rt.finish(step, "COMPLETED")
	if err := rt.save(ctx); err != nil {
		return zero, err
	}
	return out, nil
}

type runtimeKey struct{}

// WithRuntime attaches the active run's runtime to ctx.
func WithRuntime(ctx context.Context, rt *Runtime) context.Context {
	return context.WithValue(ctx, runtimeKey{}, rt)
}

// RuntimeFrom returns the active runtime, if any.
func RuntimeFrom(ctx context.Context) *Runtime {
	rt, _ := ctx.Value(runtimeKey{}).(*Runtime)
	return rt
}

// Rule runs a rule-based substitute for a model call through the same stages, so the record of a
// run looks the same whether or not a model was involved.
func Rule[T any](ctx context.Context, kind Kind, produce func() (T, error)) (T, error) {
	return runTyped(ctx, kind,
		func(context.Context) (any, error) { return produce() },
		func(raw any) (T, error) {
			value, ok := raw.(T)
			if !ok {
				var zero T
				return zero, errStage
			}
			return value, nil
		})
}

// runTyped is the previous server's runTypedSkill: generate, then validate, inside the active
// runtime (or a throwaway one), recording GENERATE and VALIDATE (and LOAD_CONTEXT when the runtime
// is fresh).
func runTyped[T any](ctx context.Context, kind Kind, generate func(ctx context.Context) (any, error), validate func(raw any) (T, error)) (T, error) {
	var zero T
	rt := RuntimeFrom(ctx)
	if rt != nil && rt.Kind != kind {
		return zero, errSkillMatch
	}
	if rt == nil {
		rt = NewRuntime(kind, nil)
	}
	if len(rt.Steps) == 0 {
		if _, err := Tool(ctx, rt, "LOAD_CONTEXT", func(context.Context) (struct{}, error) { return struct{}{}, nil }); err != nil {
			return zero, err
		}
	}
	raw, err := Tool(ctx, rt, "GENERATE", generate)
	if err != nil {
		return zero, err
	}
	return Tool(ctx, rt, "VALIDATE", func(context.Context) (T, error) { return validate(raw) })
}
