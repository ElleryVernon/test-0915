package ai

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/font/basicfont"
	"golang.org/x/image/math/fixed"

	"memoryz/server/internal/planner"
	"memoryz/server/internal/textmatch"
)

// VerificationSource is the passage the previous server's provider check generated from; it is
// kept so the two records compare like for like.
const VerificationSource = "메모리즈 실험에서는 식물에 빛을 비추면 광합성이 일어난다. 광합성은 빛 에너지를 이용하여 이산화탄소와 물로부터 포도당과 산소를 만드는 과정이다. 빛은 엽록체에서 흡수된다. 생성된 포도당은 식물의 에너지원으로 사용된다."

// VerificationReport is the JSON written by `server verify-provider` (.data/openrouter-verification.json),
// a superset of the record the Next.js `backend-check --provider-only` wrote.
type VerificationReport struct {
	VerifiedAt string            `json:"verifiedAt"`
	Server     string            `json:"server"`
	Model      string            `json:"model"`
	Reasoning  string            `json:"reasoning"`
	Order      []string          `json:"providerOrder"`
	Checks     map[string]any    `json:"checks"`
	Samples    map[string]any    `json:"samples"`
	Requests   []Usage           `json:"requests"`
	Retries    []Retry           `json:"retries"`
	ByKind     map[string]int64  `json:"durationMsByKind"`
	Totals     VerificationTotal `json:"totals"`
}

// VerificationTotal sums the usage of all requests.
type VerificationTotal struct {
	PromptTokens     int      `json:"promptTokens"`
	CompletionTokens int      `json:"completionTokens"`
	ReasoningTokens  int      `json:"reasoningTokens"`
	Cost             *float64 `json:"cost"`
}

var ocrPattern = regexp.MustCompile(`(?i)MEMORYZ\s+TEST\s+42`)

// VerifyProvider spends six model calls (one per skill) against the configured provider and
// checks every answer with the same validators the API uses. It is the Go form of the previous
// server's provider-only check and is only run on purpose: it is billable.
func VerifyProvider(ctx context.Context, p *Provider, effort string, order []string) (VerificationReport, error) {
	if !p.Available() {
		return VerificationReport{}, errors.New("OPENROUTER_API_KEY and OPENROUTER_MODEL are required for this explicitly billable check")
	}
	report := VerificationReport{VerifiedAt: time.Now().UTC().Format(time.RFC3339Nano), Server: "go", Model: p.Model(), Reasoning: effort, Order: order,
		Checks: map[string]any{}, Samples: map[string]any{}, ByKind: map[string]int64{}}
	source := VerificationSource
	date := "2026-09-15"
	existing := []PlanExisting{{Date: date, Start: "08:00", End: "16:00", Title: "학교 수업"}, {Date: date, Start: "18:00", End: "19:00", Title: "학원"}}
	subjects := []planner.PlanSubject{{ID: "synthetic-biology", Name: "생명과학", DueCards: 12}, {ID: "synthetic-math", Name: "수학", DueCards: 0}}
	grade := GradeInput{Prompt: "광합성의 과정을 설명하세요.", Keywords: []string{"빛", "엽록체", "광합성", "포도당"},
		ModelAnswer: "빛이 엽록체에서 흡수되면 광합성이 일어나 이산화탄소와 물로부터 포도당과 산소가 만들어진다.",
		Citation:    "광합성은 빛 에너지를 이용하여 이산화탄소와 물로부터 포도당과 산소를 만드는 과정이다.",
		Answer:      "빛이 엽록체에서 흡수되면 광합성을 통해 이산화탄소와 물이 포도당과 산소로 바뀝니다."}
	pngBytes, err := renderOCRImage("MEMORYZ TEST 42")
	if err != nil {
		return report, err
	}

	type outcome struct {
		kind    Kind
		value   any
		err     error
		elapsed time.Duration
	}
	run := func(kind Kind, work func(ctx context.Context) (any, error)) outcome {
		started := time.Now()
		value, err := work(ctx)
		return outcome{kind: kind, value: value, err: err, elapsed: time.Since(started)}
	}
	ctx, usage := CaptureUsage(ctx)
	jobs := []func() outcome{
		func() outcome {
			return run(KindQuiz, func(ctx context.Context) (any, error) { return GenerateItems(ctx, p, source, KindQuiz, 1) })
		},
		func() outcome {
			return run(KindEssay, func(ctx context.Context) (any, error) { return GenerateItems(ctx, p, source, KindEssay, 1) })
		},
		func() outcome {
			return run(KindCards, func(ctx context.Context) (any, error) { return GenerateItems(ctx, p, source, KindCards, 1) })
		},
		func() outcome {
			return run(KindGrade, func(ctx context.Context) (any, error) { return GradeWithAI(ctx, p, grade) })
		},
		func() outcome {
			return run(KindPlanner, func(ctx context.Context) (any, error) { return PlanWithAI(ctx, p, date, existing, subjects, nil) })
		},
		func() outcome {
			return run(KindOCR, func(ctx context.Context) (any, error) { return ExtractImageText(ctx, p, pngBytes, "image/png") })
		},
	}
	outcomes := make([]outcome, len(jobs))
	var wg sync.WaitGroup
	for i, job := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			outcomes[i] = job()
		}()
	}
	wg.Wait()
	report.Requests = usage.Requests()
	report.Retries = usage.Retries()
	for _, u := range report.Requests {
		report.Totals.PromptTokens += u.PromptTokens
		report.Totals.CompletionTokens += u.CompletionTokens
		report.Totals.ReasoningTokens += u.ReasoningTokens
	}
	cost := 0.0
	priced := true
	for _, u := range report.Requests {
		if u.Cost == nil {
			priced = false
			break
		}
		cost += *u.Cost
	}
	if priced && len(report.Requests) > 0 {
		report.Totals.Cost = &cost
	}
	var failures []string
	for _, o := range outcomes {
		report.ByKind[string(o.kind)] = o.elapsed.Milliseconds()
		if o.err != nil {
			failures = append(failures, string(o.kind)+": "+o.err.Error())
			continue
		}
		if err := judge(o.kind, o.value, source, &report); err != nil {
			failures = append(failures, string(o.kind)+": "+err.Error())
		}
	}
	if len(failures) > 0 {
		return report, fmt.Errorf("provider validation failures: %s", strings.Join(failures, "; "))
	}
	if len(report.Requests) < 6 || len(report.Requests) > 6+len(report.Retries) {
		return report, fmt.Errorf("expected 6 model calls plus %d retries, recorded %d", len(report.Retries), len(report.Requests))
	}
	for _, u := range report.Requests {
		if u.PromptTokens <= 0 {
			return report, fmt.Errorf("request %s reported no usage", u.RequestID)
		}
		if u.Provider != "Amazon Bedrock" && u.Provider != "OpenAI" {
			return report, fmt.Errorf("only Bedrock us-east-1 or the openai/fast fallback may serve Luna: %s", u.Provider)
		}
	}
	return report, nil
}

// judge applies the checks the previous provider-only test made, plus the card-quality rule this
// leaf added (an answer, not a quiz).
func judge(kind Kind, value any, source string, report *VerificationReport) error {
	switch kind {
	case KindQuiz, KindEssay, KindCards:
		items := value.(Items)
		citations := items.citations()
		if len(citations) != 1 || !textmatch.HasCitation(source, citations[0]) {
			return errors.New("one grounded item expected")
		}
		report.Checks[string(kind)] = 1
		switch kind {
		case KindQuiz:
			q := items.Questions[0]
			report.Samples["quiz"] = q
		case KindEssay:
			report.Samples["essay"] = items.Essays[0]
		case KindCards:
			c := items.Cards[0]
			report.Samples["cards"] = c
			if leaked(c.Back) || hasEnumeratedList(c.Back) || strings.Count(strings.TrimSpace(c.Back), "\n") > 2 {
				return errors.New("card back must be an answer, not another item format")
			}
		}
	case KindGrade:
		g := value.(planner.GradeResult)
		report.Checks["gradeScore"] = g.Score
		report.Samples["grade"] = g
		if g.Method != "AI" || g.Score < 60 || len(g.Matched) < 3 {
			return fmt.Errorf("grade %d/%s matched %d", g.Score, g.Method, len(g.Matched))
		}
	case KindPlanner:
		r := value.(planner.PlansResult)
		report.Checks["plans"] = len(r.Plans)
		report.Checks["planMethod"] = r.Method
		report.Checks["planDropped"] = r.Dropped
		report.Samples["planner"] = r
		if (r.Method != "AI" && r.Method != "AI+규칙") || len(r.Plans) != 2 {
			return fmt.Errorf("planner used %s with %d plans", r.Method, len(r.Plans))
		}
		for _, plan := range r.Plans {
			if len(plan.Blocks) == 0 {
				return errors.New("a plan has no blocks")
			}
		}
	case KindOCR:
		text := value.(string)
		report.Checks["ocr"] = text
		if !ocrPattern.MatchString(text) {
			return fmt.Errorf("ocr read %q", text)
		}
	}
	return nil
}

// renderOCRImage draws text in a bitmap font and scales it up so the model reads it as printed text.
func renderOCRImage(text string) ([]byte, error) {
	face := basicfont.Face7x13
	width := font.MeasureString(face, text).Ceil() + 24
	small := image.NewRGBA(image.Rect(0, 0, width, 32))
	draw.Draw(small, small.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	(&font.Drawer{Dst: small, Src: image.NewUniform(color.Black), Face: face, Dot: fixed.P(12, 21)}).DrawString(text)
	big := image.NewRGBA(image.Rect(0, 0, width*5, 160))
	draw.NearestNeighbor.Scale(big, big.Bounds(), small, small.Bounds(), draw.Src, nil)
	var buf bytes.Buffer
	if err := png.Encode(&buf, big); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
