package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"memoryz/server/internal/ai"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/auth"
	"memoryz/server/internal/blob"
	"memoryz/server/internal/cache"
	"memoryz/server/internal/config"
	"memoryz/server/internal/db"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/ratelimit"
	"memoryz/server/internal/testenv"
)

const jitterSource = "나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다. 칼륨 이온이 세포 밖으로 나가면 재분극이 일어난다."

// fakeModel answers every model call with one valid quiz item (or holds, or refuses with 429).
type fakeModel struct {
	calls    atomic.Int32
	inFlight atomic.Int32
	mode     atomic.Value // "ok" | "hold" | "429"
	release  chan struct{}
}

func (f *fakeModel) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ToolChoice struct {
			Function struct {
				Name string `json:"name"`
			} `json:"function"`
		} `json:"tool_choice"`
	}
	raw, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(raw, &body)
	f.calls.Add(1)
	f.inFlight.Add(1)
	defer f.inFlight.Add(-1)
	switch f.mode.Load() {
	case "hold":
		select {
		case <-f.release:
		case <-r.Context().Done():
			return
		}
	case "429":
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	item := map[string]any{"prompt": "탈분극을 일으키는 이온의 이동은?", "options": []string{"나트륨 유입", "나트륨 유출", "칼륨 유입", "칼륨 유출", "이동 없음"}, "answer": 0,
		"explanation": "나트륨 이온이 세포 안으로 유입되어 탈분극이 발생해요.", "citation": "나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.", "past": "세포막", "future": "막전위"}
	args, _ := json.Marshal(map[string]any{"items": []any{item}, "text": "스캔한 쪽의 본문입니다. 광합성은 빛에너지를 화학 에너지로 바꾼다."})
	out, _ := json.Marshal(map[string]any{"id": "gen-1", "model": "openai/gpt-5.6-luna", "provider": "Amazon Bedrock",
		"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"tool_calls": []any{map[string]any{"function": map[string]any{"name": body.ToolChoice.Function.Name, "arguments": string(args)}}}}}},
		"usage":   map[string]any{"prompt_tokens": 10, "completion_tokens": 5}})
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(out)
}

type aiHarness struct {
	t        *testing.T
	s        *Server
	pool     *pgxpool.Pool
	mem      *cache.Memory
	model    *fakeModel
	handler  http.Handler
	student  string
	material string
	cookie   string
}

// slowBudget makes the AI budget's counter step take 100 ms, so concurrent requests overlap inside
// the claim instead of finishing it one after another.
type slowBudget struct{ cache.Cache }

func (c slowBudget) Incr(ctx context.Context, key string, ttl time.Duration) (int64, time.Duration, error) {
	if strings.HasPrefix(key, "rl:ai:m:") {
		time.Sleep(100 * time.Millisecond)
	}
	return c.Cache.Incr(ctx, key, ttl)
}

func newAIHarness(t *testing.T, tune func(*config.Config), wrap ...func(cache.Cache) cache.Cache) *aiHarness {
	t.Helper()
	ctx := context.Background()
	scratch := testenv.Scratch(t, testenv.DatabaseURL(t))
	pool, err := pgxpool.New(ctx, scratch)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := db.Migrate(ctx, pool, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	model := &fakeModel{release: make(chan struct{})}
	model.mode.Store("ok")
	upstream := httptest.NewServer(model)
	t.Cleanup(upstream.Close)
	conf := &config.Config{Env: config.Development, AppURL: "http://127.0.0.1:8080", AuthSecret: strings.Repeat("s", 40), PDFWorkers: 1,
		OpenRouterAPIKey: "synthetic", OpenRouterModel: "openai/gpt-5.6-luna", OpenRouterEffort: "high", OpenRouterProviderOrder: []string{"openai/fast"},
		OpenRouterBaseURL: upstream.URL, AIRatePerMinute: 10, AIRatePerDay: 200, AIConcurrency: 16}
	if tune != nil {
		tune(conf)
	}
	mem := cache.NewMemory()
	t.Cleanup(func() { _ = mem.Close() })
	var c cache.Cache = mem
	for _, w := range wrap {
		c = w(c)
	}
	a := auth.New(conf, pool, c)
	s := New(conf, pool, c, a, blob.NewPG(pool), slog.New(slog.NewTextHandler(io.Discard, nil)))
	mux := http.NewServeMux()
	s.Mount(mux)
	h := &aiHarness{t: t, s: s, pool: pool, mem: mem, model: model, handler: httpx.Chain(mux, httpx.Timeout(15*time.Second))}
	h.student = "qa-jitter-" + ids.Token(3)
	subject, material := ids.New(), ids.New()
	for _, stmt := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO "User" ("id", "name", "nickname", "role") VALUES ($1, $1, $1, 'STUDENT')`, []any{h.student}},
		{`INSERT INTO "Subject" ("id", "userId", "name") VALUES ($1, $2, '생명과학')`, []any{subject, h.student}},
		{`INSERT INTO "Material" ("id", "userId", "subjectId", "title", "content") VALUES ($1, $2, $3, '막전위', $4)`, []any{material, h.student, subject, jitterSource}},
	} {
		if _, err := pool.Exec(ctx, stmt.sql, stmt.args...); err != nil {
			t.Fatal(err)
		}
	}
	h.material = material
	session, _, err := a.Create(ctx, h.student)
	if err != nil {
		t.Fatal(err)
	}
	h.cookie = strings.Split(session, ";")[0]
	return h
}

func (h *aiHarness) do(method, path string, body any) *httptest.ResponseRecorder {
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", h.cookie+"; "+auth.SignedInCookie+"=1")
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	return rec
}

func (h *aiHarness) generate(requestID string) *httptest.ResponseRecorder {
	return h.do(http.MethodPost, "/api/generate", map[string]any{"materialId": h.material, "count": 1, "mode": "quiz", "requestId": requestID})
}

func (h *aiHarness) runs(requestID string) int {
	var n int
	if err := h.pool.QueryRow(context.Background(), `SELECT count(*) FROM "AiRun" WHERE "requestId" = $1`, requestID).Scan(&n); err != nil {
		h.t.Fatal(err)
	}
	return n
}

func bodyOf(rec *httptest.ResponseRecorder) map[string]any {
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out
}

// hinted checks a response's Retry-After header and body against [lo, hi] (hints are whole
// milliseconds rounded up, so a draw at the very end of the spread reports hi itself).
func hinted(t *testing.T, rec *httptest.ResponseRecorder, lo, hi time.Duration) {
	t.Helper()
	secs, err := strconv.Atoi(rec.Header().Get("Retry-After"))
	ms, _ := bodyOf(rec)["retryAfterMs"].(float64)
	wait := time.Duration(ms) * time.Millisecond
	if err != nil || wait < lo || wait > hi || int64((wait+time.Second-1)/time.Second) != int64(secs) {
		t.Fatalf("hint %q / %v, want [%v, %v): %s", rec.Header().Get("Retry-After"), wait, lo, hi, rec.Body.String())
	}
}

// TestBudgetOnlyForNewRuns: replays, repeats and checks on a request id already claimed spend no
// budget; a refusal leaves no AiRun row, so the same id runs exactly once after the wait.
func TestBudgetOnlyForNewRuns(t *testing.T) {
	h := newAIHarness(t, func(c *config.Config) { c.AIRatePerMinute = 2 })
	x := ids.New()
	if rec := h.generate(x); rec.Code != http.StatusCreated {
		t.Fatalf("first run: %d %s", rec.Code, rec.Body.String())
	}
	for i := range 11 {
		if rec := h.generate(x); rec.Code != http.StatusCreated {
			t.Fatalf("replay %d: %d %s", i, rec.Code, rec.Body.String())
		}
	}
	if h.model.calls.Load() != 1 {
		t.Fatalf("replays make no model call: %d", h.model.calls.Load())
	}
	// Eleven replays spent nothing: a second new run still fits the limit of two.
	if rec := h.generate(ids.New()); rec.Code != http.StatusCreated {
		t.Fatalf("second new run within the budget: %d %s", rec.Code, rec.Body.String())
	}
	z := ids.New()
	rec := h.generate(z)
	if rec.Code != http.StatusTooManyRequests || h.runs(z) != 0 {
		t.Fatalf("a refused new run is not claimed: %d rows=%d", rec.Code, h.runs(z))
	}
	hinted(t, rec, 0, 76*time.Second)
	before := h.model.calls.Load()
	if err := h.mem.Del(context.Background(), "rl:ai:m:"+h.student); err != nil { // the minute passes
		t.Fatal(err)
	}
	if rec := h.generate(z); rec.Code != http.StatusCreated || h.model.calls.Load() != before+1 || h.runs(z) != 1 {
		t.Fatalf("the same id after the wait runs once: %d calls=%d rows=%d", rec.Code, h.model.calls.Load()-before, h.runs(z))
	}
}

// TestBudgetOnceForConcurrentSameID: five sends of one new request id at the same moment (a double
// tap, a retried send) spend the budget once: the others wait for the claim and see it.
func TestBudgetOnceForConcurrentSameID(t *testing.T) {
	h := newAIHarness(t, func(c *config.Config) { c.AIRatePerMinute = 2 }, func(c cache.Cache) cache.Cache { return slowBudget{c} })
	h.model.mode.Store("hold")
	y := ids.New()
	answers := make([]*httptest.ResponseRecorder, 5)
	var wg sync.WaitGroup
	for i := range answers {
		wg.Add(1)
		go func() { defer wg.Done(); answers[i] = h.generate(y) }()
	}
	deadline := time.Now().Add(10 * time.Second)
	for h.model.inFlight.Load() < 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(200 * time.Millisecond) // the other four have met the claim by now
	close(h.model.release)
	wg.Wait()
	created, inProgress := 0, 0
	for _, rec := range answers {
		switch rec.Code {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
			inProgress++
		default:
			t.Fatalf("unexpected answer: %d %s", rec.Code, rec.Body.String())
		}
	}
	if created < 1 || created+inProgress != 5 || h.runs(y) != 1 || h.model.calls.Load() != 1 {
		t.Fatalf("one claim, one model call: created=%d inProgress=%d rows=%d calls=%d", created, inProgress, h.runs(y), h.model.calls.Load())
	}
	// The budget of 2 was spent once: one more new run fits, the next is refused.
	h.model.mode.Store("ok")
	if rec := h.generate(ids.New()); rec.Code != http.StatusCreated {
		t.Fatalf("the second new run fits the budget: %d %s", rec.Code, rec.Body.String())
	}
	if rec := h.generate(ids.New()); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("the third new run is refused: %d", rec.Code)
	}
}

// TestDrainInterruptsRuns: at shutdown the runs waiting on the model are recorded INTERRUPTED and
// answer 503 with a [10 s, 20 s) hint within 2 s; a run that starts afterwards is interrupted too;
// the stored runs carry retryAfterMs for devices that lost the answer.
func TestDrainInterruptsRuns(t *testing.T) {
	h := newAIHarness(t, nil)
	h.model.mode.Store("hold")
	requestIDs := []string{ids.New(), ids.New(), ids.New()}
	answers := make([]*httptest.ResponseRecorder, len(requestIDs))
	var wg sync.WaitGroup
	for i, id := range requestIDs {
		wg.Add(1)
		go func() { defer wg.Done(); answers[i] = h.generate(id) }()
	}
	deadline := time.Now().Add(10 * time.Second)
	for h.model.inFlight.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if h.model.inFlight.Load() != 3 {
		t.Fatalf("three runs wait on the model: %d", h.model.inFlight.Load())
	}
	started := time.Now()
	h.s.Drain()
	answered := make(chan struct{})
	go func() { wg.Wait(); close(answered) }()
	select {
	case <-answered:
	case <-time.After(5 * time.Second):
		close(h.model.release) // let the held runs end so the test does not hang
		t.Fatal("Drain did not interrupt the runs waiting on the model")
	}
	if took := time.Since(started); took > 2*time.Second {
		t.Fatalf("interrupted within 2 s: %v", took)
	}
	close(h.model.release)
	for i, rec := range answers {
		if rec.Code != http.StatusServiceUnavailable || bodyOf(rec)["error"] != msgInterrupted {
			t.Fatalf("run %d: %d %s", i, rec.Code, rec.Body.String())
		}
		hinted(t, rec, 10*time.Second, 20*time.Second)
		var status string
		var errorStatus int
		if err := h.pool.QueryRow(context.Background(), `SELECT "status", "errorStatus" FROM "AiRun" WHERE "requestId" = $1`, requestIDs[i]).Scan(&status, &errorStatus); err != nil || status != "INTERRUPTED" || errorStatus != 503 {
			t.Fatalf("run %d recorded: %s %d %v", i, status, errorStatus, err)
		}
		view := h.do(http.MethodGet, "/api/ai-runs/"+requestIDs[i], nil)
		ms, ok := bodyOf(view)["data"].(map[string]any)["retryAfterMs"].(float64)
		if view.Code != http.StatusOK || !ok || ms < 0 || ms > 20000 {
			t.Fatalf("stored run %d carries retryAfterMs: %d %s", i, view.Code, view.Body.String())
		}
	}
	late := h.generate(ids.New())
	if late.Code != http.StatusServiceUnavailable {
		t.Fatalf("a run that starts after the drain is interrupted: %d %s", late.Code, late.Body.String())
	}
}

// TestStoredFailureHints: a FAILED 429 run that just finished carries [10 s, 20 s), one that
// finished 30 s ago [0, 10 s), and a COMPLETED run none; a replay of the 429 answers with the hint.
func TestStoredFailureHints(t *testing.T) {
	h := newAIHarness(t, nil)
	h.model.mode.Store("429")
	fresh := ids.New()
	rec := h.generate(fresh)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("upstream 429: %d %s", rec.Code, rec.Body.String())
	}
	hinted(t, rec, 10*time.Second, 20*time.Second)
	read := func(id string) (float64, bool) {
		view := h.do(http.MethodGet, "/api/ai-runs/"+id, nil)
		ms, ok := bodyOf(view)["data"].(map[string]any)["retryAfterMs"].(float64)
		return ms, ok
	}
	// max(0, finishedAt + 10 s − now) + U[0, 10 s): a few ms have passed since it finished.
	if ms, ok := read(fresh); !ok || ms < 9000 || ms >= 20000 {
		t.Fatalf("a 429 that just finished: %v %v", ms, ok)
	}
	replay := h.generate(fresh)
	if replay.Code != http.StatusTooManyRequests {
		t.Fatalf("replay of the failure: %d", replay.Code)
	}
	hinted(t, replay, 10*time.Second-time.Second, 20*time.Second)
	if _, err := h.pool.Exec(context.Background(), `UPDATE "AiRun" SET "finishedAt" = "finishedAt" - interval '30 seconds' WHERE "requestId" = $1`, fresh); err != nil {
		t.Fatal(err)
	}
	if ms, ok := read(fresh); !ok || ms < 1000 || ms >= 10000 {
		t.Fatalf("a 429 that finished 30 s ago: at least the 1 s floor, under 10 s: %v %v", ms, ok)
	}
	// A run the provider left unfinished (504) is transient too: hinted on read and on replay.
	timedOut := ids.New()
	if _, err := h.pool.Exec(context.Background(), `INSERT INTO "AiRun" ("id", "userId", "requestId", "kind", "inputHash", "skillVersion", "model", "status", "steps", "startedAt", "updatedAt", "finishedAt", "error", "errorStatus") VALUES ($1, $2, $3, 'quiz', 'h', 'v', 'm', 'FAILED', '[]', now(), now(), $4, 'AI 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.', 504)`, ids.New(), h.student, timedOut, h.s.now()); err != nil {
		t.Fatal(err)
	}
	if ms, ok := read(timedOut); !ok || ms < 9000 || ms >= 20000 {
		t.Fatalf("a 504 that just finished: %v %v", ms, ok)
	}
	h.model.mode.Store("ok")
	done := ids.New()
	if rec := h.generate(done); rec.Code != http.StatusCreated {
		t.Fatalf("completed run: %d", rec.Code)
	}
	if _, ok := read(done); ok {
		t.Fatal("a completed run has no retryAfterMs")
	}
}

// TestPDFQueue: the second concurrent PDF waits exactly 30 s, then gets 429 with a [30 s, 60 s)
// hint; a waiter whose client has gone leaves at once and takes no slot.
func TestPDFQueue(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := &Server{pdfSlots: make(chan struct{}, 1)}
		release, err := s.pdfSlot(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		started := time.Now()
		_, err = s.pdfSlot(context.Background())
		if waited := time.Since(started); waited != pdfWait {
			t.Fatalf("waits exactly %v: %v", pdfWait, waited)
		}
		e, ok := apierr.From(err)
		if !ok || e.Status != 429 {
			t.Fatalf("queue timeout: %v", err)
		}
		if lo, _ := httpx.RetryAfter(e, func() float64 { return 0 }); lo != 30*time.Second {
			t.Fatalf("hint floor: %v", lo)
		}
		// Hints are whole milliseconds rounded up, so the ceiling is the window's end itself.
		if hi, _ := httpx.RetryAfter(e, func() float64 { return 1 - 1.0/(1<<53) }); hi > 60*time.Second || hi < 59*time.Second {
			t.Fatalf("hint ceiling: %v", hi)
		}
		client, leave := context.WithCancel(context.Background())
		gone := make(chan error, 1)
		go func() {
			_, err := s.pdfSlot(httpx.WithClient(context.Background(), client))
			gone <- err
		}()
		synctest.Wait()
		leave()
		if err := <-gone; !errors.Is(err, context.Canceled) || time.Since(started) != pdfWait {
			t.Fatalf("a waiter whose client left gives up at once: %v", err)
		}
		if len(s.pdfSlots) != 1 {
			t.Fatal("the leaver took no slot")
		}
		release()
	})
}

// TestScannedPDFRefusedByAdmission: a scanned page's OCR refused by the provider is a 429 with a
// hint, not an unreadable PDF (422).
func TestScannedPDFRefusedByAdmission(t *testing.T) {
	h := newAIHarness(t, nil)
	h.model.mode.Store("429")
	pdf, err := os.ReadFile("../../../tests/fixtures/pdf/scanned.pdf")
	if err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, _ := form.CreateFormFile("file", "scan.pdf")
	_, _ = part.Write(pdf)
	_ = form.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/upload", &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("Cookie", h.cookie)
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("OCR refusal reaches the client: %d %s", rec.Code, rec.Body.String())
	}
	hinted(t, rec, 10*time.Second, 20*time.Second)
}

// TestRetryHints (api): every 429 and transient 504 this package produces carries a hint with the
// designed (min, spread); permanent refusals carry a code and none.
func TestRetryHints(t *testing.T) {
	mem := cache.NewMemory()
	defer mem.Close()
	err := ratelimit.Check(context.Background(), mem, "k", 0, time.Minute)
	if e, ok := apierr.From(err); !ok || e.RetryMin <= 0 || e.RetryMin > time.Minute || e.RetrySpread != 15*time.Second {
		t.Fatalf("rate limit: %+v", e)
	}
	s := &Server{cfg: &config.Config{AIRatePerMinute: 100, AIRatePerDay: 1, OpenRouterAPIKey: "k", OpenRouterModel: "m"}, cache: mem}
	s.ai = ai.NewProvider(s.cfg, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := s.aiBudget(context.Background(), "u"); err != nil {
		t.Fatal(err)
	}
	err = s.aiBudget(context.Background(), "u")
	if e, ok := apierr.From(err); !ok || e.Code != "AI_DAILY_LIMIT" || e.Status != 429 || e.RetrySpread != 0 || e.RetryMin < 23*time.Hour || e.RetryMin > 24*time.Hour {
		t.Fatalf("daily limit: exact time left, own code: %+v", e)
	}
	for name, c := range map[string]struct {
		err       *apierr.Error
		min, span time.Duration
	}{
		"timeout":     {apierr.ErrTimeout, 2 * time.Second, 4 * time.Second},
		"interrupted": {errInterrupted, 10 * time.Second, 10 * time.Second},
		"pdf queue":   {errUploadsBusy, 30 * time.Second, 30 * time.Second},
		"link lock":   {errLinkLocked.Retry(17*time.Minute, 0), 17 * time.Minute, 0},
	} {
		if c.err.RetryMin != c.min || c.err.RetrySpread != c.span {
			t.Fatalf("%s: (%v, %v), want (%v, %v)", name, c.err.RetryMin, c.err.RetrySpread, c.min, c.span)
		}
	}
	// The parent link lock, on both branches: the fifth wrong code locks for exactly 30 min, and a
	// later attempt hears exactly the time left.
	h := newAIHarness(t, nil)
	parent := "qa-jitter-parent-" + ids.Token(3)
	if _, err := h.pool.Exec(context.Background(), `INSERT INTO "User" ("id", "name", "nickname", "role") VALUES ($1, $1, $1, 'PARENT')`, parent); err != nil {
		t.Fatal(err)
	}
	session, _, err := h.s.auth.Create(context.Background(), parent)
	if err != nil {
		t.Fatal(err)
	}
	h.cookie = strings.Split(session, ";")[0]
	var last *httptest.ResponseRecorder
	for range 5 {
		last = h.do(http.MethodPost, "/api/link", map[string]string{"code": "000000"})
	}
	if last.Code != http.StatusTooManyRequests || last.Header().Get("Retry-After") != "1800" || bodyOf(last)["retryAfterMs"].(float64) != 1800000 {
		t.Fatalf("the fifth failure locks for exactly 30 min: %d %s %s", last.Code, last.Header().Get("Retry-After"), last.Body.String())
	}
	// The lock is set from the server's clock (the database's may run a second apart in a VM).
	if _, err := h.pool.Exec(context.Background(), `UPDATE "User" SET "linkLockedUntil" = $2 WHERE "id" = $1`, parent, h.s.now().Add(17*time.Minute)); err != nil {
		t.Fatal(err)
	}
	h.s.auth.Invalidate(context.Background(), parent)
	locked := h.do(http.MethodPost, "/api/link", map[string]string{"code": "000000"})
	if secs, _ := strconv.Atoi(locked.Header().Get("Retry-After")); locked.Code != http.StatusTooManyRequests || secs < 17*60-2 || secs > 17*60 {
		t.Fatalf("a locked parent hears the exact time left: %d %s", locked.Code, locked.Header().Get("Retry-After"))
	}
	if httpx.Translate(context.Canceled).Status != 499 {
		t.Fatal("a client that left is a 499, not a 5xx")
	}
	if auth.ErrProviderOff.Code != "PROVIDER_OFF" || auth.ErrProviderOff.RetryMin != 0 || auth.ErrProviderOff.RetrySpread != 0 {
		t.Fatalf("provider off: %+v", auth.ErrProviderOff)
	}
}
