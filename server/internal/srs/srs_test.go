package srs

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"testing"
	"time"

	fsrs "github.com/open-spaced-repetition/go-fsrs/v4"
)

// The golden file is written by testdata/gen.ts with the real browser scheduler (ts-fsrs 5.4.2).

type goldenSnapshot struct {
	ConsecutiveEasy int             `json:"consecutiveEasy"`
	Bucket          string          `json:"bucket"`
	NextReviewAt    string          `json:"nextReviewAt"`
	Fsrs            json.RawMessage `json:"fsrs"`
}

type goldenStep struct {
	Rating    string   `json:"rating"`
	At        string   `json:"at"`
	Mode      string   `json:"mode"`      // overrides the case mode for this step
	Retention *float64 `json:"retention"` // overrides the case retention for this step
}

type goldenCase struct {
	Name      string           `json:"name"`
	Mode      string           `json:"mode"`
	Retention float64          `json:"retention"`
	Initial   goldenSnapshot   `json:"initial"`
	Steps     []goldenStep     `json:"steps"`
	Results   []goldenSnapshot `json:"results"`
}

type goldenPreview struct {
	Name      string         `json:"name"`
	Mode      string         `json:"mode"`
	Retention float64        `json:"retention"`
	Initial   goldenSnapshot `json:"initial"`
	At        string         `json:"at"`
	Intervals []Preview      `json:"intervals"`
}

type goldenDue struct {
	Name         string          `json:"name"`
	Deleted      bool            `json:"deleted"`
	Bucket       string          `json:"bucket"`
	Fsrs         json.RawMessage `json:"fsrs"`
	NextReviewAt string          `json:"nextReviewAt"`
	At           string          `json:"at"`
	Due          bool            `json:"due"`
}

type golden struct {
	Engine        string          `json:"engine"`
	GeneratedWith string          `json:"generatedWith"`
	Cases         []goldenCase    `json:"cases"`
	Previews      []goldenPreview `json:"previews"`
	DueChecks     []goldenDue     `json:"dueChecks"`
}

func loadGolden(t *testing.T) golden {
	t.Helper()
	raw, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatalf("golden missing (run `npx tsx server/internal/srs/testdata/gen.ts`): %v", err)
	}
	var g golden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if g.Engine != "ts-fsrs@5.4.2" || g.GeneratedWith != "scheduleCard" {
		t.Fatalf("golden from %q via %q; expected ts-fsrs@5.4.2 via scheduleCard", g.Engine, g.GeneratedWith)
	}
	return g
}

func parseFsrs(t *testing.T, raw json.RawMessage) *Serialized {
	t.Helper()
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var s Serialized
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	return &s
}

func mustTime(t *testing.T, s string) time.Time {
	t.Helper()
	tm, err := ParseISO(s)
	if err != nil {
		t.Fatal(err)
	}
	return tm
}

func inputFrom(t *testing.T, snap goldenSnapshot) Input {
	t.Helper()
	return Input{
		ConsecutiveEasy: snap.ConsecutiveEasy,
		Bucket:          snap.Bucket,
		NextReviewAt:    mustTime(t, snap.NextReviewAt),
		Fsrs:            parseFsrs(t, snap.Fsrs),
	}
}

// relTol is the parity budget for stability and difficulty (gate R2); timestamps and counters
// must match exactly.
const relTol = 1e-9

func relErr(a, b float64) float64 {
	if a == b {
		return 0
	}
	return math.Abs(a-b) / math.Max(math.Abs(a), math.Abs(b))
}

type parity struct {
	steps     int // reviews replayed
	fsrsSteps int // reviews that produced FSRS state
	exact     int // FSRS steps whose stability and difficulty matched bit for bit
	failures  int
	maxRel    float64
}

func (p *parity) compare(t *testing.T, name string, i int, got Result, want goldenSnapshot) {
	t.Helper()
	fail := func(format string, args ...any) {
		t.Helper()
		p.failures++
		t.Errorf("%s step %d: "+format, append([]any{name, i}, args...)...)
	}
	p.steps++
	if got.ConsecutiveEasy != want.ConsecutiveEasy {
		fail("consecutiveEasy %d, want %d", got.ConsecutiveEasy, want.ConsecutiveEasy)
	}
	if got.Bucket != want.Bucket {
		fail("bucket %s, want %s", got.Bucket, want.Bucket)
	}
	if s := FormatISO(got.NextReviewAt); s != want.NextReviewAt {
		fail("nextReviewAt %s, want %s", s, want.NextReviewAt)
	}
	wantFsrs := parseFsrs(t, want.Fsrs)
	if (got.Fsrs == nil) != (wantFsrs == nil) {
		fail("fsrs nil=%v, want nil=%v", got.Fsrs == nil, wantFsrs == nil)
		return
	}
	if got.Fsrs == nil {
		return
	}
	p.fsrsSteps++
	g, w := *got.Fsrs, *wantFsrs
	if g.Due != w.Due {
		fail("fsrs.due %s, want %s", g.Due, w.Due)
	}
	if g.LastReview != w.LastReview {
		fail("fsrs.last_review %s, want %s", g.LastReview, w.LastReview)
	}
	ints := [][3]any{
		{"elapsed_days", g.ElapsedDays, w.ElapsedDays},
		{"scheduled_days", g.ScheduledDays, w.ScheduledDays},
		{"learning_steps", g.LearningSteps, w.LearningSteps},
		{"reps", g.Reps, w.Reps},
		{"lapses", g.Lapses, w.Lapses},
		{"state", g.State, w.State},
	}
	for _, f := range ints {
		if f[1] != f[2] {
			fail("fsrs.%s %v, want %v", f[0], f[1], f[2])
		}
	}
	for _, f := range [][3]any{{"stability", g.Stability, w.Stability}, {"difficulty", g.Difficulty, w.Difficulty}} {
		e := relErr(f[1].(float64), f[2].(float64))
		p.maxRel = math.Max(p.maxRel, e)
		if e > relTol {
			fail("fsrs.%s %.12g, want %.12g (rel err %.3g)", f[0], f[1], f[2], e)
		}
	}
	if g.Stability == w.Stability && g.Difficulty == w.Difficulty {
		p.exact++
	}
	// The JSON keys are the wire contract: compare the marshalled object with the golden's object.
	raw, err := json.Marshal(got.Fsrs)
	if err != nil {
		t.Fatal(err)
	}
	var gotObj, wantObj map[string]any
	if err := json.Unmarshal(raw, &gotObj); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want.Fsrs, &wantObj); err != nil {
		t.Fatal(err)
	}
	if len(gotObj) != len(wantObj) {
		fail("fsrs JSON keys %d, want %d (%s)", len(gotObj), len(wantObj), raw)
	}
	for k, wv := range wantObj {
		gv, ok := gotObj[k]
		if !ok {
			fail("fsrs JSON lacks key %q", k)
			continue
		}
		switch wv := wv.(type) {
		case float64:
			if gf, ok := gv.(float64); !ok || relErr(gf, wv) > relTol {
				fail("fsrs JSON %q = %v, want %v", k, gv, wv)
			}
		default:
			if gv != wv {
				fail("fsrs JSON %q = %v, want %v", k, gv, wv)
			}
		}
	}
}

// roundTrip carries a result forward the way the app does: through JSON.
func roundTrip(t *testing.T, res Result) Input {
	t.Helper()
	in := Input{ConsecutiveEasy: res.ConsecutiveEasy, Bucket: res.Bucket, NextReviewAt: res.NextReviewAt}
	if res.Fsrs != nil {
		raw, err := json.Marshal(res.Fsrs)
		if err != nil {
			t.Fatal(err)
		}
		in.Fsrs = new(Serialized)
		if err := json.Unmarshal(raw, in.Fsrs); err != nil {
			t.Fatal(err)
		}
	}
	return in
}

func TestParity(t *testing.T) {
	g := loadGolden(t)
	if len(g.Cases) < 200 {
		t.Fatalf("golden has %d cases; the gate needs at least 200", len(g.Cases))
	}
	var p parity
	for _, c := range g.Cases {
		if len(c.Steps) != len(c.Results) {
			t.Fatalf("%s: %d steps but %d results", c.Name, len(c.Steps), len(c.Results))
		}
		in := inputFrom(t, c.Initial)
		for i, step := range c.Steps {
			mode := c.Mode
			if step.Mode != "" {
				mode = step.Mode
			}
			retention := c.Retention
			if step.Retention != nil {
				retention = *step.Retention
			}
			res, err := Schedule(in, step.Rating, mode, retention, mustTime(t, step.At))
			if err != nil {
				t.Fatalf("%s step %d: %v", c.Name, i, err)
			}
			p.compare(t, c.Name, i, res, c.Results[i])
			if p.failures > 25 {
				t.Fatalf("too many mismatches; stopping")
			}
			in = roundTrip(t, res)
		}
	}
	if t.Failed() {
		t.Fatal("parity failed; see the mismatches above")
	}
	t.Logf("SRS_PARITY_OK cases=%d steps=%d fsrsSteps=%d bitExact=%d maxRelErr=%.3g", len(g.Cases), p.steps, p.fsrsSteps, p.exact, p.maxRel)
}

func TestFixed(t *testing.T) {
	now := mustTime(t, "2026-09-15T10:00:00.000Z")
	stored := &Serialized{Due: "2026-09-15T00:10:00.000Z", Stability: 2.3065, Difficulty: 2.11810397, LearningSteps: 1, Reps: 1, State: 1, LastReview: "2026-09-15T00:00:00.000Z"}
	offsets := map[string]time.Duration{
		RatingAgain: 10 * time.Minute,
		RatingHard:  24 * time.Hour,
		RatingGood:  72 * time.Hour,
		RatingEasy:  7 * 24 * time.Hour,
	}
	for rating, offset := range offsets {
		res, err := Schedule(Input{Bucket: BucketAgain, Fsrs: stored}, rating, ModeFixed, 0.9, now)
		if err != nil {
			t.Fatalf("%s: %v", rating, err)
		}
		wantEasy := 0
		if rating == RatingEasy {
			wantEasy = 1
		}
		if !res.NextReviewAt.Equal(now.Add(offset)) || res.Fsrs != nil || res.Bucket != rating || res.ConsecutiveEasy != wantEasy {
			t.Fatalf("%s: got %+v", rating, res)
		}
	}
	// Two EASY in a row master the card; anything else resets the streak.
	one, _ := Schedule(Input{}, RatingEasy, ModeFixed, 0.9, now)
	two, _ := Schedule(Input{ConsecutiveEasy: one.ConsecutiveEasy}, RatingEasy, ModeFixed, 0.9, now)
	three, _ := Schedule(Input{ConsecutiveEasy: two.ConsecutiveEasy}, RatingEasy, ModeFixed, 0.9, now)
	reset, _ := Schedule(Input{ConsecutiveEasy: three.ConsecutiveEasy, Bucket: BucketMastered}, RatingGood, ModeFixed, 0.9, now)
	if one.Bucket != BucketEasy || two.Bucket != BucketMastered || two.ConsecutiveEasy != 2 || three.Bucket != BucketMastered || three.ConsecutiveEasy != 3 || reset.Bucket != BucketGood || reset.ConsecutiveEasy != 0 {
		t.Fatalf("mastery chain: %+v %+v %+v %+v", one, two, three, reset)
	}
	// FIXED neither validates retention nor reads the stored FSRS state.
	for _, retention := range []float64{math.NaN(), 0.5, 2} {
		if _, err := Schedule(Input{}, RatingGood, ModeFixed, retention, now); err != nil {
			t.Fatalf("retention %v rejected in FIXED mode: %v", retention, err)
		}
	}
	if _, err := Schedule(Input{Fsrs: &Serialized{Due: "garbage", Stability: math.NaN(), State: 9}}, RatingGood, ModeFixed, 0.9, now); err != nil {
		t.Fatalf("stored state inspected in FIXED mode: %v", err)
	}
	// Validation shared by both modes.
	if _, err := Schedule(Input{}, RatingGood, "fixed", 0.9, now); !errors.Is(err, ErrInvalidMode) {
		t.Fatalf("mode: %v", err)
	}
	if _, err := Schedule(Input{}, "OK", ModeFixed, 0.9, now); !errors.Is(err, ErrInvalidRating) {
		t.Fatalf("rating: %v", err)
	}
	if _, err := Schedule(Input{}, RatingGood, ModeFixed, 0.9, time.Time{}); !errors.Is(err, ErrInvalidTime) {
		t.Fatalf("time: %v", err)
	}
	// Times are read at millisecond precision, like JavaScript Dates.
	precise, _ := Schedule(Input{}, RatingAgain, ModeFixed, 0.9, now.Add(700*time.Microsecond))
	if s := FormatISO(precise.NextReviewAt); s != "2026-09-15T10:10:00.000Z" {
		t.Fatalf("sub-millisecond time leaked: %s", s)
	}
}

func TestIsDue(t *testing.T) {
	g := loadGolden(t)
	if len(g.DueChecks) == 0 {
		t.Fatal("golden has no due checks")
	}
	for _, d := range g.DueChecks {
		got := IsDue(d.Deleted, d.Bucket, parseFsrs(t, d.Fsrs), mustTime(t, d.NextReviewAt), mustTime(t, d.At))
		if got != d.Due {
			t.Errorf("%s: IsDue=%v, want %v", d.Name, got, d.Due)
		}
	}
	next := mustTime(t, "2026-09-15T10:00:00.000Z")
	if IsDue(false, BucketGood, nil, time.Time{}, next) {
		t.Fatal("a zero due time is never due")
	}
	if !IsDue(false, BucketGood, nil, next, next.Add(999*time.Microsecond)) || IsDue(false, BucketGood, nil, next, next.Add(-time.Microsecond)) {
		t.Fatal("IsDue must compare whole milliseconds")
	}
	if IsDue(false, BucketMastered, nil, next, next) || !IsDue(false, BucketMastered, &Serialized{}, next, next) || IsDue(true, BucketGood, nil, next, next) {
		t.Fatal("MASTERED without FSRS state and deleted cards are never due")
	}
}

func TestPreview(t *testing.T) {
	g := loadGolden(t)
	if len(g.Previews) == 0 {
		t.Fatal("golden has no previews")
	}
	for _, p := range g.Previews {
		got, err := PreviewIntervals(inputFrom(t, p.Initial), p.Mode, p.Retention, mustTime(t, p.At))
		if err != nil {
			t.Fatalf("%s: %v", p.Name, err)
		}
		if len(got) != len(p.Intervals) {
			t.Fatalf("%s: %d previews, want %d", p.Name, len(got), len(p.Intervals))
		}
		for i := range got {
			if got[i] != p.Intervals[i] {
				t.Errorf("%s[%d]: %+v, want %+v", p.Name, i, got[i], p.Intervals[i])
			}
		}
	}
	now := mustTime(t, "2026-09-15T10:00:00.000Z")
	got, err := PreviewIntervals(Input{}, ModeFixed, 0.9, now)
	if err != nil {
		t.Fatal(err)
	}
	want := []Preview{
		{RatingAgain, "2026-09-15T10:10:00.000Z"},
		{RatingHard, "2026-09-16T10:00:00.000Z"},
		{RatingGood, "2026-09-18T10:00:00.000Z"},
		{RatingEasy, "2026-09-22T10:00:00.000Z"},
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("FIXED preview %d: %+v, want %+v", i, got[i], want[i])
		}
	}
	if _, err := PreviewIntervals(Input{}, "bogus", 0.9, now); !errors.Is(err, ErrInvalidMode) {
		t.Fatalf("mode error not propagated: %v", err)
	}
	if _, err := PreviewIntervals(Input{}, ModeFSRS, 0.5, now); !errors.Is(err, ErrRetention) {
		t.Fatalf("retention error not propagated: %v", err)
	}
	if _, err := PreviewIntervals(Input{Fsrs: &Serialized{Due: "nope"}}, ModeFSRS, 0.9, now); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("state error not propagated: %v", err)
	}
}

var validReview = Serialized{
	Due: "2026-09-17T00:10:00.000Z", Stability: 2.3065, Difficulty: 2.11121424,
	ScheduledDays: 2, Reps: 2, State: 2, LastReview: "2026-09-15T00:10:00.000Z",
}

func with(f func(s *Serialized)) *Serialized {
	s := validReview
	f(&s)
	return &s
}

func TestRestore(t *testing.T) {
	now := mustTime(t, "2026-09-17T00:10:00.000Z")
	bad := []struct {
		name string
		s    *Serialized
	}{
		{"NaN stability", with(func(s *Serialized) { s.Stability = math.NaN() })},
		{"+Inf stability", with(func(s *Serialized) { s.Stability = math.Inf(1) })},
		{"NaN difficulty", with(func(s *Serialized) { s.Difficulty = math.NaN() })},
		{"-Inf difficulty", with(func(s *Serialized) { s.Difficulty = math.Inf(-1) })},
		{"state 4", with(func(s *Serialized) { s.State = 4 })},
		{"state -1", with(func(s *Serialized) { s.State = -1 })},
		{"unparsable due", with(func(s *Serialized) { s.Due = "not a date" })},
		{"empty due", with(func(s *Serialized) { s.Due = "" })},
		{"unparsable last_review", with(func(s *Serialized) { s.LastReview = "yesterday" })},
		{"stability below S_MIN", with(func(s *Serialized) { s.Stability = 0.0005 })},
		{"difficulty below 1", with(func(s *Serialized) { s.Difficulty = 0.5 })},
	}
	for _, c := range bad {
		if _, err := Schedule(Input{Fsrs: c.s}, RatingGood, ModeFSRS, 0.9, now); !errors.Is(err, ErrInvalidState) {
			t.Errorf("%s: err=%v, want ErrInvalidState", c.name, err)
		}
	}
	good := []struct {
		name string
		s    *Serialized
	}{
		{"as stored", with(func(*Serialized) {})},
		{"date-only due", with(func(s *Serialized) { s.Due = "2026-09-17" })},
		{"due with offset", with(func(s *Serialized) { s.Due = "2026-09-17T09:10:00.000+09:00" })},
		{"no last_review", with(func(s *Serialized) { s.LastReview = "" })},
		{"nil state", nil},
	}
	for _, c := range good {
		if _, err := Schedule(Input{Fsrs: c.s}, RatingGood, ModeFSRS, 0.9, now); err != nil {
			t.Errorf("%s: unexpected %v", c.name, err)
		}
	}
	// Retention is validated before the stored state, as in scheduleCard.
	for _, r := range []float64{0.79, 0.971, math.NaN(), math.Inf(1), 0} {
		if _, err := Schedule(Input{Fsrs: bad[0].s}, RatingGood, ModeFSRS, r, now); !errors.Is(err, ErrRetention) {
			t.Errorf("retention %v: err=%v, want ErrRetention", r, err)
		}
	}
	for _, r := range []float64{MinRetention, MaxRetention, 0.9} {
		if _, err := Schedule(Input{}, RatingGood, ModeFSRS, r, now); err != nil {
			t.Errorf("retention %v rejected: %v", r, err)
		}
	}
	// No stored state is an empty card created at the review time.
	res, err := Schedule(Input{}, RatingGood, ModeFSRS, 0.9, now)
	if err != nil {
		t.Fatal(err)
	}
	want := Serialized{Due: "2026-09-17T00:20:00.000Z", Stability: 2.3065, Difficulty: 2.11810397, LearningSteps: 1, Reps: 1, State: 1, LastReview: "2026-09-17T00:10:00.000Z"}
	if *res.Fsrs != want || !res.NextReviewAt.Equal(mustTime(t, want.Due)) {
		t.Fatalf("first GOOD: %+v", *res.Fsrs)
	}
}

func TestOrder(t *testing.T) {
	last := mustTime(t, validReview.LastReview)
	stored := with(func(*Serialized) {})
	if _, err := Schedule(Input{Fsrs: stored}, RatingGood, ModeFSRS, 0.9, last.Add(-time.Millisecond)); !errors.Is(err, ErrReviewOrder) {
		t.Fatalf("review before last review: %v", err)
	}
	for _, at := range []time.Time{last, last.Add(time.Millisecond), last.Add(400 * 24 * time.Hour)} {
		if _, err := Schedule(Input{Fsrs: stored}, RatingGood, ModeFSRS, 0.9, at); err != nil {
			t.Fatalf("review at %s: %v", FormatISO(at), err)
		}
	}
	// Retention and the stored state are checked first; FIXED never checks the order.
	if _, err := Schedule(Input{Fsrs: stored}, RatingGood, ModeFSRS, 0.5, last.Add(-time.Hour)); !errors.Is(err, ErrRetention) {
		t.Fatalf("retention should be validated first: %v", err)
	}
	if _, err := Schedule(Input{Fsrs: stored}, RatingGood, ModeFixed, 0.9, last.Add(-time.Hour)); err != nil {
		t.Fatalf("FIXED mode must ignore the last review: %v", err)
	}
}

func TestDefaultsMatchTsFsrs(t *testing.T) {
	// default_w of ts-fsrs 5.4.2 (node_modules/ts-fsrs/dist/index.mjs).
	tsDefaultW := fsrs.Weights{
		0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 1e-3, 1.8722, 0.1666, 0.796,
		1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
	}
	if fsrs.DefaultWeights() != tsDefaultW {
		t.Fatalf("go-fsrs default weights differ from ts-fsrs 5.4.2: %v", fsrs.DefaultWeights())
	}
	d := fsrs.DefaultParam()
	if d.RequestRetention != 0.9 || d.MaximumInterval != 36500 || !d.EnableShortTerm || d.EnableFuzz ||
		len(d.LearningSteps) != 2 || d.LearningSteps[0] != 1 || d.LearningSteps[1] != 10 ||
		len(d.RelearningSteps) != 1 || d.RelearningSteps[0] != 10 {
		t.Fatalf("go-fsrs DefaultParam differs from the ts-fsrs options: %+v", d)
	}
	p := engineParameters(0.85)
	if p.RequestRetention != 0.85 || p.W != tsDefaultW || p.MaximumInterval != 36500 || !p.EnableShortTerm || p.EnableFuzz {
		t.Fatalf("engine parameters: %+v", p)
	}
	if Version != "go-fsrs@v4.0.0 / FSRS-6" {
		t.Fatalf("Version = %q", Version)
	}
	// JavaScript rounding semantics the port depends on.
	for _, c := range []struct{ in, want float64 }{{2.5, 3}, {-2.5, -2}, {0.49999999999999994, 0}, {-0.3, 0}, {1.5, 2}, {-1.5, -1}} {
		if got := jsRound(c.in); got != c.want {
			t.Errorf("jsRound(%v) = %v, want %v", c.in, got, c.want)
		}
	}
	if got := roundTo(2.675, 2); got != 2.68 { // what Math.round(2.675 * 100) / 100 gives in V8
		t.Errorf("roundTo(2.675, 2) = %v, want 2.68", got)
	}
	// computeDecayFactor(default_w) and fsrs({request_retention}).interval_modifier in ts-fsrs 5.4.2.
	modifiers := map[float64]float64{0.8: 3.3159598, 0.85: 1.90642614, 0.9: 1, 0.95: 0.40255869, 0.97: 0.22276844}
	for retention, want := range modifiers {
		e := newEngine(retention)
		if e.decay != -0.1542 || e.factor != 0.98034649 || e.intervalModifier != want {
			t.Errorf("retention %v: decay/factor/modifier = %v %v %v, want -0.1542 0.98034649 %v", retention, e.decay, e.factor, e.intervalModifier, want)
		}
	}
}
