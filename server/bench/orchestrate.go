package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"reflect"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	"memoryz/bench/internal/app"
	"memoryz/bench/internal/candidates"
	"memoryz/bench/internal/oha"
	"memoryz/bench/internal/pgbench"
)

type logFunc func(format string, args ...any)

// endpoint is one of the four measured routes.
type endpoint struct {
	Name string
	Desc string
	spec func(base string) oha.Spec
}

func endpoints(bodyFile string) []endpoint {
	return []endpoint{
		{"/json", "GET /json — small JSON object {message, ts}", func(b string) oha.Spec {
			return oha.Spec{URL: b + "/json"}
		}},
		{"/users/{id}", "GET /users/12345 — path parameter echoed in a small JSON object", func(b string) oha.Spec {
			return oha.Spec{URL: b + "/users/12345"}
		}},
		{"/echo", "POST /echo — decode the 1002-byte JSON body and re-encode it", func(b string) oha.Spec {
			return oha.Spec{URL: b + "/echo", Method: http.MethodPost, ContentType: "application/json", BodyFile: bodyFile}
		}},
		{"/db", "GET /db?id=N — one pgxpool query, N random in 1..9999 per request (oha --rand-regex-url)", func(b string) oha.Spec {
			return oha.Spec{URL: b + `/db\?id=[1-9][0-9]{0,3}`, RandRegexURL: true}
		}},
	}
}

func runOrchestrator(cfg config) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logf := func(format string, a ...any) { fmt.Fprintf(os.Stderr, "bench: "+format+"\n", a...) }

	res, err := orchestrate(ctx, cfg, logf)
	if err != nil {
		logf("FAILED: %v", err)
		return 1
	}
	fmt.Printf("FRAMEWORK_BENCH_OK candidates=%d runs=%d\n", len(res.Candidates), len(res.Runs))
	fmt.Printf("BENCH_DECISION=%s\n", res.Decision.Chosen)
	return 0
}

func orchestrate(ctx context.Context, cfg config, logf logFunc) (*Results, error) {
	started := time.Now().UTC()
	res := &Results{
		GeneratedAt: started.Format(time.RFC3339),
		Command:     "go run . " + strings.Join(cfg.args, " "),
	}

	ohaVersion, err := oha.Version(ctx)
	if err != nil {
		return nil, err
	}
	res.Machine = machineInfo(ohaVersion, cfg.gomaxprocs)

	cands, err := selectCandidates(cfg.only)
	if err != nil {
		return nil, err
	}
	infos, err := describeCandidates(ctx, cands, started)
	if err != nil {
		return nil, err
	}
	for _, in := range infos {
		logf("%s %s released %s (within 6 months: %v)", in.Name, in.Version, in.ReleaseDate, in.LastReleaseWithin6Months)
	}

	bodyFile, cleanupBody, err := echoBodyFile()
	if err != nil {
		return nil, err
	}
	defer cleanupBody()
	exe, cleanupExe, err := stableExecutable()
	if err != nil {
		return nil, err
	}
	defer cleanupExe()
	sum := sha256.Sum256(app.SampleEchoJSON)
	eps := endpoints(bodyFile)

	db, err := pgbench.Start(ctx, pgbench.Options{Mode: cfg.pgMode, Port: cfg.pgPort, EnvFile: cfg.envFile, Logf: logf})
	if err != nil {
		return nil, fmt.Errorf("database: %w", err)
	}
	cleanupDB := func() {
		if err := db.Cleanup(context.Background()); err != nil {
			logf("database cleanup FAILED: %v", err)
		}
	}
	defer cleanupDB()
	logf("database ready: %s", db.Display)
	res.Machine.Postgres = db.ServerVersion
	res.Machine.Database = db.Display

	if !cfg.skipMicro {
		logf("router micro-benchmark (go test -bench) ...")
		out, err := runMicrobench(ctx)
		if err != nil {
			return nil, fmt.Errorf("router micro-benchmark: %w\n%s", err, out)
		}
		res.Microbench = out
		// Let the compile burst of go test subside before the first candidate.
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		// jitter: none — development tooling: one fixed 3 s pause on the operator's machine [site server/bench/orchestrate.go:135]
		case <-time.After(3 * time.Second):
		}
	}

	for i, c := range cands {
		if err := measureCandidate(ctx, cfg, exe, c, &infos[i], eps, db.DSN, res, logf); err != nil {
			return nil, err
		}
	}
	res.Candidates = infos
	res.Decision = decide(infos, res.Runs, started)

	res.Config = RunConfig{
		Duration:    cfg.duration.String(),
		Warmup:      cfg.warmup.String(),
		Concurrency: cfg.concurrency,
		GOMAXPROCS:  cfg.gomaxprocs,
		PoolMaxConns: app.PoolMaxConns,
		LookupSQL:   app.LookupSQL,
		SeedRows:    app.SeedRows,
		DBMode:      string(db.Mode),
		DBCommands:  db.Commands,
		EchoBody:    EchoBodyInfo{Path: bodyFile, Bytes: len(app.SampleEchoJSON), SHA256: hex.EncodeToString(sum[:])},
	}
	for _, ep := range eps {
		s := ep.spec("http://127.0.0.1:<port>")
		s.Concurrency = cfg.concurrency[0]
		s.Duration = cfg.duration
		s.RequestTimeout = requestTimeout
		res.Config.OhaTemplates = append(res.Config.OhaTemplates, ep.Name+": "+s.Command())
	}
	res.Endpoints = make([]string, 0, len(eps))
	for _, ep := range eps {
		res.Endpoints = append(res.Endpoints, ep.Desc)
	}
	res.Notes = notes(res, cfg)

	// Drop the database before reporting success so the "nothing left behind"
	// gate sees the final state.
	cleanupDB()
	logf("database removed (%s)", db.Mode)

	if err := writeJSON(cfg.resultsPath, res); err != nil {
		return nil, err
	}
	if err := writeMarkdown(cfg.mdPath, res); err != nil {
		return nil, err
	}
	logf("wrote %s and %s in %s", cfg.resultsPath, cfg.mdPath, time.Since(started).Round(time.Second))
	return res, nil
}

const requestTimeout = 30 * time.Second

func selectCandidates(only []string) ([]candidates.Candidate, error) {
	all := candidates.All()
	if len(only) == 0 {
		return all, nil
	}
	var out []candidates.Candidate
	for _, name := range only {
		c, ok := candidates.Find(name)
		if !ok {
			return nil, fmt.Errorf("unknown candidate %q", name)
		}
		out = append(out, c)
	}
	return out, nil
}

// describeCandidates verifies the pinned versions against the binary's build
// info and records each module's release time from `go list -m -json`.
func describeCandidates(ctx context.Context, cands []candidates.Candidate, now time.Time) ([]CandidateInfo, error) {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return nil, fmt.Errorf("no build info in the binary")
	}
	cutoff := now.AddDate(0, -6, 0)
	infos := make([]CandidateInfo, 0, len(cands))
	for _, c := range cands {
		info := CandidateInfo{
			Name:              c.Name,
			Module:            c.Module,
			NetHTTPCompatible: c.NetHTTPCompatible,
			NetHTTPNote:       c.Compat,
			JSONPath:          c.JSONPath,
		}
		modPath, modVer := c.Module, ""
		if c.Module == "" {
			info.Module = "standard library"
			info.Version = runtime.Version()
			modPath = "golang.org/toolchain"
			modVer = "v0.0.1-" + runtime.Version() + "." + runtime.GOOS + "-" + runtime.GOARCH
		} else {
			v := buildVersion(bi, c.Module)
			if v == "" {
				return nil, fmt.Errorf("%s: module %s is not in the build info", c.Name, c.Module)
			}
			if v != c.Pinned {
				return nil, fmt.Errorf("%s: ledger pins %s %s but the binary was built with %s", c.Name, c.Module, c.Pinned, v)
			}
			info.Version, modVer = v, v
		}
		t, err := moduleTime(ctx, modPath, modVer)
		if err != nil {
			return nil, fmt.Errorf("%s: release date: %w", c.Name, err)
		}
		info.ReleaseDate = t.UTC().Format("2006-01-02")
		info.ReleaseSource = fmt.Sprintf("go list -m -json %s@%s → .Time %s", modPath, modVer, t.UTC().Format(time.RFC3339))
		info.LastReleaseWithin6Months = !t.Before(cutoff)
		infos = append(infos, info)
	}
	return infos, nil
}

func buildVersion(bi *debug.BuildInfo, module string) string {
	for _, d := range bi.Deps {
		if d.Path == module {
			if d.Replace != nil {
				return d.Replace.Version
			}
			return d.Version
		}
	}
	return ""
}

func moduleTime(ctx context.Context, path, version string) (time.Time, error) {
	cmd := exec.CommandContext(ctx, "go", "list", "-m", "-json", path+"@"+version)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return time.Time{}, fmt.Errorf("go list -m -json %s@%s: %w: %s", path, version, err, strings.TrimSpace(stderr.String()))
	}
	var m struct{ Time time.Time }
	if err := json.Unmarshal(out, &m); err != nil {
		return time.Time{}, err
	}
	if m.Time.IsZero() {
		return time.Time{}, fmt.Errorf("go list -m -json %s@%s: no Time field", path, version)
	}
	return m.Time, nil
}

// echoBodyFile returns the path oha reads the /echo body from: the embedded
// fixture inside the module when the working directory is the module root,
// otherwise a temporary copy.
func echoBodyFile() (string, func(), error) {
	const rel = "internal/app/echo-body.json"
	if b, err := os.ReadFile(rel); err == nil && bytes.Equal(b, app.SampleEchoJSON) {
		return rel, func() {}, nil
	}
	dir, err := os.MkdirTemp("", "memoryz-bench-")
	if err != nil {
		return "", nil, err
	}
	p := filepath.Join(dir, "echo-body.json")
	if err := os.WriteFile(p, app.SampleEchoJSON, 0o644); err != nil {
		_ = os.RemoveAll(dir)
		return "", nil, err
	}
	return p, func() { _ = os.RemoveAll(dir) }, nil
}

func runMicrobench(ctx context.Context) (string, error) {
	out, err := exec.CommandContext(ctx, "go", "env", "GOMOD").Output()
	if err != nil {
		return "", err
	}
	gomod := strings.TrimSpace(string(out))
	if gomod == "" || gomod == os.DevNull {
		return "", fmt.Errorf("not inside the memoryz/bench module (go env GOMOD is empty); run from server/bench")
	}
	args := []string{"test", "-run", "^$", "-bench", "^BenchmarkRoute$", "-benchmem", "-count", "1", "./internal/candidates/"}
	cmd := exec.CommandContext(ctx, "go", args...)
	cmd.Dir = filepath.Dir(gomod)
	b, err := cmd.CombinedOutput()
	return "$ go " + strings.Join(args, " ") + "\n" + string(b), err
}

func measureCandidate(ctx context.Context, cfg config, exe string, c candidates.Candidate, info *CandidateInfo, eps []endpoint, dsn string, res *Results, logf logFunc) error {
	port, err := freePort()
	if err != nil {
		return err
	}
	ch, err := startChild(exe, c.Name, port, cfg.gomaxprocs, dsn)
	if err != nil {
		return fmt.Errorf("%s: start: %w", c.Name, err)
	}
	defer func() { _ = ch.stop() }()
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	if err := waitReady(ctx, base+"/json", 30*time.Second, ch); err != nil {
		return fmt.Errorf("%s: %w", c.Name, err)
	}
	if err := verifySemantics(base); err != nil {
		return fmt.Errorf("%s: semantics check failed: %w", c.Name, err)
	}
	info.H2C, info.H2CProbe = probeH2C(base)
	info.Eligible = info.NetHTTPCompatible && info.H2C && info.LastReleaseWithin6Months
	logf("%s ready on %s (pid %d); semantics OK; h2c=%v (%s)", c.Name, base, ch.cmd.Process.Pid, info.H2C, info.H2CProbe)

	for _, ep := range eps {
		spec := ep.spec(base)
		spec.RequestTimeout = requestTimeout
		if cfg.warmup > 0 {
			w := spec
			w.Concurrency, w.Duration = cfg.concurrency[0], cfg.warmup
			if _, err := oha.Run(ctx, w); err != nil {
				return fmt.Errorf("%s %s warm-up: %w", c.Name, ep.Name, err)
			}
		}
		for _, cc := range cfg.concurrency {
			if ch.exited() {
				return fmt.Errorf("%s: server exited during measurement: %v", c.Name, ch.exitErr)
			}
			s := spec
			s.Concurrency, s.Duration = cc, cfg.duration
			r, err := oha.Run(ctx, s)
			if err != nil {
				return fmt.Errorf("%s %s c=%d: %w", c.Name, ep.Name, cc, err)
			}
			res.Runs = append(res.Runs, Run{
				Candidate: c.Name, Endpoint: ep.Name, Concurrency: cc,
				RPS: r.RPS, P50: r.P50ms, P99: r.P99ms, Errors: r.Errors,
				Requests: r.Requests, Status: r.Status, ErrorDist: r.ErrorDist, Command: r.Command,
			})
			logf("%-8s %-12s c=%-3d rps=%9.0f p50=%7.2fms p99=%8.2fms errors=%d", c.Name, ep.Name, cc, r.RPS, r.P50ms, r.P99ms, r.Errors)
		}
	}
	if err := ch.stop(); err != nil {
		res.Oddities = append(res.Oddities, fmt.Sprintf("%s: server process ended with %v after its runs", c.Name, err))
		logf("%s: server exit: %v", c.Name, err)
	}
	return nil
}

// child is one candidate server process.
type child struct {
	cmd     *exec.Cmd
	pipe    *os.File // write end of the child's stdin; closing it asks for a graceful shutdown
	exitCh  chan struct{}
	exitErr error
	stopped bool
}

// stableExecutable copies this binary to a private temporary directory and
// returns that path: `go run` executes the binary straight from the build
// cache, and a concurrent go command (or go clean) can remove that entry in
// the middle of a ten-minute run.
func stableExecutable() (string, func(), error) {
	exe, err := os.Executable()
	if err != nil {
		return "", nil, err
	}
	src, err := os.Open(exe)
	if err != nil {
		return "", nil, err
	}
	defer src.Close()
	dir, err := os.MkdirTemp("", "memoryz-bench-bin-")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	dst := filepath.Join(dir, "bench")
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		cleanup()
		return "", nil, err
	}
	if _, err := io.Copy(out, src); err != nil {
		_ = out.Close()
		cleanup()
		return "", nil, err
	}
	if err := out.Close(); err != nil {
		cleanup()
		return "", nil, err
	}
	return dst, cleanup, nil
}

func startChild(exe, name string, port, gomaxprocs int, dsn string) (*child, error) {
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(exe, "-serve", name, "-port", strconv.Itoa(port), "-watch-stdin")
	cmd.Stdin = pr
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	env := make([]string, 0, len(os.Environ())+2)
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "GOMAXPROCS=") || strings.HasPrefix(kv, "BENCH_DSN=") {
			continue
		}
		env = append(env, kv)
	}
	env = append(env, "BENCH_DSN="+dsn)
	if gomaxprocs > 0 {
		env = append(env, "GOMAXPROCS="+strconv.Itoa(gomaxprocs))
	}
	cmd.Env = env
	if err := cmd.Start(); err != nil {
		_ = pr.Close()
		_ = pw.Close()
		return nil, err
	}
	_ = pr.Close()
	ch := &child{cmd: cmd, pipe: pw, exitCh: make(chan struct{})}
	go func() {
		ch.exitErr = cmd.Wait()
		close(ch.exitCh)
	}()
	return ch, nil
}

func (c *child) exited() bool {
	select {
	case <-c.exitCh:
		return true
	default:
		return false
	}
}

// stop closes the child's stdin (graceful shutdown), then escalates to
// SIGTERM and SIGKILL if it lingers.
func (c *child) stop() error {
	if c.stopped {
		return c.exitErr
	}
	c.stopped = true
	_ = c.pipe.Close()
	// jitter: none — development tooling: stdin close, 15 s, SIGTERM, 5 s, SIGKILL for one local child [site server/bench/orchestrate.go:473]
	select {
	case <-c.exitCh:
	case <-time.After(15 * time.Second):
		_ = c.cmd.Process.Signal(syscall.SIGTERM)
		// jitter: none — the SIGKILL step of the same local escalation
		select {
		case <-c.exitCh:
		case <-time.After(5 * time.Second):
			_ = c.cmd.Process.Kill()
			<-c.exitCh
		}
	}
	return c.exitErr
}

func freePort() (int, error) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	return port, ln.Close()
}

func waitReady(ctx context.Context, url string, max time.Duration, ch *child) error {
	client := &http.Client{Timeout: 2 * time.Second}
	defer client.CloseIdleConnections()
	deadline := time.Now().Add(max)
	var last error
	for {
		if ch.exited() {
			return fmt.Errorf("server exited before becoming ready: %v", ch.exitErr)
		}
		resp, err := client.Get(url)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
			err = fmt.Errorf("status %d", resp.StatusCode)
		}
		last = err
		if time.Now().After(deadline) {
			return fmt.Errorf("not ready after %s: %v", max, last)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		// jitter: none — development tooling: one harness polls its own child every 100 ms [site server/bench/orchestrate.go:519]
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// verifySemantics checks, against the live server, that the four endpoints
// behave identically to the specification before anything is measured.
func verifySemantics(base string) error {
	client := &http.Client{Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	do := func(method, path string, body []byte) (int, string, []byte, error) {
		var r io.Reader
		if body != nil {
			r = bytes.NewReader(body)
		}
		req, err := http.NewRequest(method, base+path, r)
		if err != nil {
			return 0, "", nil, err
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := client.Do(req)
		if err != nil {
			return 0, "", nil, err
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(resp.Body)
		return resp.StatusCode, resp.Header.Get("Content-Type"), raw, err
	}

	status, ct, raw, err := do(http.MethodGet, "/json", nil)
	if err != nil {
		return err
	}
	var h app.Hello
	if status != 200 || !strings.HasPrefix(ct, "application/json") || json.Unmarshal(raw, &h) != nil || h.Message != "hello" || h.TS <= 0 {
		return fmt.Errorf("GET /json: status=%d content-type=%q body=%s", status, ct, raw)
	}

	status, ct, raw, err = do(http.MethodGet, "/users/abc-123", nil)
	if err != nil {
		return err
	}
	var u app.User
	if status != 200 || !strings.HasPrefix(ct, "application/json") || json.Unmarshal(raw, &u) != nil || u != app.NewUser("abc-123") {
		return fmt.Errorf("GET /users/abc-123: status=%d content-type=%q body=%s", status, ct, raw)
	}

	want, err := app.SampleEchoBody()
	if err != nil {
		return err
	}
	status, ct, raw, err = do(http.MethodPost, "/echo", app.SampleEchoJSON)
	if err != nil {
		return err
	}
	var e app.EchoBody
	if status != 200 || !strings.HasPrefix(ct, "application/json") || json.Unmarshal(raw, &e) != nil || !reflect.DeepEqual(e, want) {
		return fmt.Errorf("POST /echo: status=%d content-type=%q body=%s", status, ct, raw)
	}
	if n := len(bytes.TrimSpace(raw)); n < 900 || n > 1300 {
		return fmt.Errorf("POST /echo: response is %d bytes, expected about 1KB", n)
	}

	status, ct, raw, err = do(http.MethodGet, "/db?id=7", nil)
	if err != nil {
		return err
	}
	var row app.Row
	if status != 200 || !strings.HasPrefix(ct, "application/json") || json.Unmarshal(raw, &row) != nil ||
		row != (app.Row{ID: 7, Name: app.SeedName(7), Score: app.SeedScore(7)}) {
		return fmt.Errorf("GET /db?id=7: status=%d content-type=%q body=%s", status, ct, raw)
	}
	for path, wantStatus := range map[string]int{"/db?id=0": 400, "/db?id=x": 400, "/db": 400, "/db?id=99999999": 404} {
		status, _, raw, err = do(http.MethodGet, path, nil)
		if err != nil {
			return err
		}
		if status != wantStatus {
			return fmt.Errorf("GET %s: status=%d want %d body=%s", path, status, wantStatus, raw)
		}
	}
	return nil
}

// probeH2C sends one prior-knowledge HTTP/2 request over plaintext TCP using
// net/http's own Transport.Protocols (Go 1.24+), which is exactly how an h2c
// client (or a Cloud Run ingress configured for HTTP/2) would talk to it.
func probeH2C(base string) (bool, string) {
	tr := &http.Transport{Protocols: new(http.Protocols)}
	tr.Protocols.SetUnencryptedHTTP2(true)
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: 5 * time.Second}
	resp, err := client.Get(base + "/json")
	if err != nil {
		return false, "prior-knowledge HTTP/2 GET /json failed: " + err.Error()
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	ok := resp.ProtoMajor == 2 && resp.StatusCode == http.StatusOK
	return ok, fmt.Sprintf("prior-knowledge HTTP/2 GET /json → %s %d", resp.Proto, resp.StatusCode)
}

func machineInfo(ohaVersion string, gomaxprocs int) Machine {
	m := Machine{
		Cores:            runtime.NumCPU(),
		GoVersion:        runtime.Version(),
		OhaVersion:       ohaVersion,
		ServerGOMAXPROCS: gomaxprocs,
		OS:               runtime.GOOS + "/" + runtime.GOARCH,
		CPU:              "unknown",
	}
	switch runtime.GOOS {
	case "darwin":
		m.CPU = cmdOut("sysctl", "-n", "machdep.cpu.brand_string")
		m.OS = fmt.Sprintf("macOS %s (Darwin %s, %s/%s)", cmdOut("sw_vers", "-productVersion"), cmdOut("uname", "-r"), runtime.GOOS, runtime.GOARCH)
		m.LoadAvg = strings.Trim(cmdOut("sysctl", "-n", "vm.loadavg"), "{} ")
	case "linux":
		if b, err := os.ReadFile("/proc/cpuinfo"); err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				if strings.HasPrefix(line, "model name") {
					if _, v, ok := strings.Cut(line, ":"); ok {
						m.CPU = strings.TrimSpace(v)
					}
					break
				}
			}
		}
		m.OS = fmt.Sprintf("%s (%s/%s)", cmdOut("uname", "-sr"), runtime.GOOS, runtime.GOARCH)
		if b, err := os.ReadFile("/proc/loadavg"); err == nil {
			m.LoadAvg = strings.TrimSpace(string(b))
		}
	}
	return m
}

func cmdOut(name string, args ...string) string {
	out, err := exec.Command(name, args...).Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(out))
}
