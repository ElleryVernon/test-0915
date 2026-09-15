package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"memoryz/bench/internal/candidates"
)

// Results is RESULTS.json.
type Results struct {
	GeneratedAt string          `json:"generatedAt"`
	Command     string          `json:"command"`
	Machine     Machine         `json:"machine"`
	Candidates  []CandidateInfo `json:"candidates"`
	Runs        []Run           `json:"runs"`
	Decision    Decision        `json:"decision"`
	Config      RunConfig       `json:"config"`
	Endpoints   []string        `json:"endpoints"`
	Microbench  string          `json:"routerMicrobench,omitempty"`
	Notes       []string        `json:"notes"`
	Oddities    []string        `json:"oddities,omitempty"`
}

// Machine describes where the measurement ran.
type Machine struct {
	CPU              string `json:"cpu"`
	Cores            int    `json:"cores"`
	GoVersion        string `json:"goVersion"`
	OhaVersion       string `json:"ohaVersion"`
	OS               string `json:"os"`
	LoadAvg          string `json:"loadAvgAtStart,omitempty"`
	Postgres         string `json:"postgres,omitempty"`
	Database         string `json:"database,omitempty"`
	ServerGOMAXPROCS int    `json:"serverGOMAXPROCS"`
}

// CandidateInfo is the hard-requirement record of one candidate.
type CandidateInfo struct {
	Name                     string `json:"name"`
	Module                   string `json:"module"`
	Version                  string `json:"version"`
	ReleaseDate              string `json:"releaseDate"`
	ReleaseSource            string `json:"releaseDateSource"`
	NetHTTPCompatible        bool   `json:"netHTTPCompatible"`
	NetHTTPNote              string `json:"netHTTPNote"`
	H2C                      bool   `json:"h2c"`
	H2CProbe                 string `json:"h2cProbe"`
	LastReleaseWithin6Months bool   `json:"lastReleaseWithin6Months"`
	Eligible                 bool   `json:"eligible"`
	JSONPath                 string `json:"jsonPath"`
}

// Run is one oha measurement. p50/p99 are milliseconds.
type Run struct {
	Candidate   string         `json:"candidate"`
	Endpoint    string         `json:"endpoint"`
	Concurrency int            `json:"concurrency"`
	RPS         float64        `json:"rps"`
	P50         float64        `json:"p50"`
	P99         float64        `json:"p99"`
	Errors      int            `json:"errors"`
	Requests    int            `json:"requests"`
	Status      map[string]int `json:"statusCodes"`
	ErrorDist   map[string]int `json:"errorDistribution,omitempty"`
	Command     string         `json:"command"`
}

// Exclusion records why a candidate was not eligible.
type Exclusion struct {
	Candidate string `json:"candidate"`
	Reason    string `json:"reason"`
}

// Score is a candidate's decision metric.
type Score struct {
	Candidate string  `json:"candidate"`
	DB256     float64 `json:"dbRPS256"`
	Echo256   float64 `json:"echoRPS256"`
	Sum       float64 `json:"sum"`
	Eligible  bool    `json:"eligible"`
}

// Decision is the applied rule.
type Decision struct {
	Rule          string      `json:"rule"`
	Chosen        string      `json:"chosen"`
	Reason        string      `json:"reason"`
	Excluded      []Exclusion `json:"excluded"`
	Scores        []Score     `json:"scores"`
	ReleaseCutoff string      `json:"releaseCutoff"`
	EvaluatedAt   string      `json:"evaluatedAt"`
}

// RunConfig records the measurement parameters.
type RunConfig struct {
	Duration     string       `json:"duration"`
	Warmup       string       `json:"warmup"`
	Concurrency  []int        `json:"concurrency"`
	GOMAXPROCS   int          `json:"serverGOMAXPROCS"`
	PoolMaxConns int          `json:"poolMaxConns"`
	LookupSQL    string       `json:"lookupSQL"`
	SeedRows     int          `json:"seedRows"`
	DBMode       string       `json:"dbMode"`
	DBCommands   []string     `json:"dbCommands"`
	EchoBody     EchoBodyInfo `json:"echoBody"`
	OhaTemplates []string     `json:"ohaCommandTemplates"`
}

// EchoBodyInfo identifies the /echo request body.
type EchoBodyInfo struct {
	Path   string `json:"path"`
	Bytes  int    `json:"bytes"`
	SHA256 string `json:"sha256"`
}

const ruleText = "Hard requirements: (1) net/http-compatible handler signature — the router is an http.Handler and plain net/http handlers and func(http.Handler) http.Handler middleware (otelhttp, streaming via http.Flusher, cloudsqlconn-backed pools in the same process) mount unchanged; (2) HTTP/2 h2c support, verified live with a prior-knowledge HTTP/2 request; (3) a release within the last 6 months, taken from the module's .Time in `go list -m -json`. Among the candidates meeting all three, pick the one with the largest sum of /db and /echo requests/s at c=256; if that winner is within 5% of the standard library's sum, choose the standard library (fewer dependencies). Candidates failing a hard requirement are measured and shown but excluded."

func decide(infos []CandidateInfo, runs []Run, now time.Time) Decision {
	d := Decision{
		Rule:          ruleText,
		ReleaseCutoff: now.AddDate(0, -6, 0).Format("2006-01-02"),
		EvaluatedAt:   now.Format(time.RFC3339),
		Excluded:      []Exclusion{},
	}
	rps := func(cand, ep string, conc int) float64 {
		for _, r := range runs {
			if r.Candidate == cand && r.Endpoint == ep && r.Concurrency == conc {
				return r.RPS
			}
		}
		return 0
	}
	best, std := -1, -1
	for i, in := range infos {
		s := Score{Candidate: in.Name, DB256: rps(in.Name, "/db", 256), Echo256: rps(in.Name, "/echo", 256), Eligible: in.Eligible}
		s.Sum = s.DB256 + s.Echo256
		d.Scores = append(d.Scores, s)
		if !in.Eligible {
			d.Excluded = append(d.Excluded, Exclusion{Candidate: in.Name, Reason: exclusionReason(in, d.ReleaseCutoff)})
		}
		if in.Name == candidates.StdlibName {
			std = i
		}
		if in.Eligible && (best < 0 || s.Sum > d.Scores[best].Sum) {
			best = i
		}
	}
	if best < 0 {
		d.Reason = "no candidate meets all hard requirements"
		return d
	}
	b := d.Scores[best]
	if b.Candidate != candidates.StdlibName && std >= 0 && d.Scores[std].Eligible && b.Sum <= d.Scores[std].Sum*1.05 {
		s := d.Scores[std]
		d.Chosen = candidates.StdlibName
		d.Reason = fmt.Sprintf("%s has the largest /db+/echo sum at c=256 among eligible candidates (%.0f req/s) but is within 5%% of net/http (%.0f req/s, +%.1f%%), so the rule picks the standard library (fewer dependencies).",
			b.Candidate, b.Sum, s.Sum, pct(b.Sum, s.Sum))
		return d
	}
	d.Chosen = b.Candidate
	runnerUp := ""
	for _, s := range d.Scores {
		if s.Eligible && s.Candidate != b.Candidate && (runnerUp == "" || s.Sum > scoreOf(d.Scores, runnerUp).Sum) {
			runnerUp = s.Candidate
		}
	}
	switch {
	case b.Candidate == candidates.StdlibName && runnerUp != "":
		r := scoreOf(d.Scores, runnerUp)
		d.Reason = fmt.Sprintf("net/http has the largest /db+/echo sum at c=256 among eligible candidates (%.0f req/s); runner-up %s reached %.0f req/s (%.1f%%).", b.Sum, r.Candidate, r.Sum, pct(r.Sum, b.Sum))
	case b.Candidate == candidates.StdlibName:
		d.Reason = fmt.Sprintf("net/http is the only eligible candidate (%.0f req/s /db+/echo at c=256).", b.Sum)
	case std >= 0 && d.Scores[std].Eligible:
		s := d.Scores[std]
		d.Reason = fmt.Sprintf("%s has the largest /db+/echo sum at c=256 among eligible candidates (%.0f req/s), %.1f%% above net/http (%.0f req/s), more than the 5%% margin.", b.Candidate, b.Sum, pct(b.Sum, s.Sum), s.Sum)
	default:
		d.Reason = fmt.Sprintf("%s has the largest /db+/echo sum at c=256 among eligible candidates (%.0f req/s); net/http was not measured.", b.Candidate, b.Sum)
	}
	return d
}

func scoreOf(scores []Score, name string) Score {
	for _, s := range scores {
		if s.Candidate == name {
			return s
		}
	}
	return Score{}
}

func pct(v, base float64) float64 {
	if base == 0 {
		return 0
	}
	return (v - base) / base * 100
}

func exclusionReason(in CandidateInfo, cutoff string) string {
	var rs []string
	if !in.NetHTTPCompatible {
		rs = append(rs, "not net/http compatible: "+in.NetHTTPNote)
	}
	if !in.H2C {
		rs = append(rs, "no HTTP/2 h2c: "+in.H2CProbe)
	}
	if !in.LastReleaseWithin6Months {
		rs = append(rs, fmt.Sprintf("last release %s on %s is older than 6 months (cutoff %s)", in.Version, in.ReleaseDate, cutoff))
	}
	return strings.Join(rs, "; ")
}

func notes(r *Results, cfg config) []string {
	return []string{
		"PoC scale: 4 high-school classes, about 100 students plus their parents; the expected peak is ~50 concurrent users. c=64 and c=256 are above the target load on purpose: the numbers rank per-request framework overhead, they are not a capacity plan.",
		fmt.Sprintf("oha ran on the same machine as the candidate server and the Postgres container, so the load generator competed with the server for CPU. Candidate servers ran with GOMAXPROCS=%d to mirror the Cloud Run 1 vCPU target (Go 1.25+ derives GOMAXPROCS from the container CPU limit) and to keep the server, not oha, as the bottleneck; oha used its default worker threads (%d).", cfg.gomaxprocs, r.Machine.Cores),
		fmt.Sprintf("This orchestrator ran no parallel builds or other benchmark work during the measurement; unrelated development containers were up, and other sessions on the machine could not be paused (load average at start, 1/5/15 min, including this run's own compilation: %s).", r.Machine.LoadAvg),
		fmt.Sprintf("Each candidate was compiled into this one binary, started alone as a child process on a free loopback port, checked for identical endpoint semantics against the live server, probed for h2c, warmed up %s per endpoint at c=%d, measured %s per (endpoint, concurrency) with HTTP/1.1 keep-alive, then stopped before the next candidate.", cfg.warmup, cfg.concurrency[0], cfg.duration),
		"Run-to-run variation on a laptop is a few percent; the 5% margin in the decision rule exists for that reason. Re-running the command regenerates both result files.",
		"All candidates use encoding/json: gin is built without its jsoniter/go_json/sonic tags, fiber keeps its default (encoding/json) encoder and decoder, huma uses DefaultJSONFormat with DefaultConfig's `$schema` link transformer removed (CreateHooks=nil) so its bodies have the same shape as the others.",
		"Errors = non-200 responses plus failed requests (connection errors, timeouts); oha was run with -w so requests still in flight at the deadline are waited for rather than counted as errors. Runs with errors > 0 are marked ⚠ in the table.",
		dbNote(r),
	}
}

func dbNote(r *Results) string {
	switch r.Config.DBMode {
	case "local":
		return fmt.Sprintf("Database: %s. The native server was preferred over a Docker container because on macOS a container's published port goes through Docker Desktop's user-space proxy, which made /db erratic in trial runs on this machine (identical repeats of the same net/http server at c=256: 12,886 vs 2,102 req/s, p50 17 ms vs 100 ms) while the native server repeated at 23,450 / 22,838 / 16,741 req/s; `-pg docker` still runs the container variant. Only the database memoryz_bench was created and dropped; the app's dedicated database (memoryz) was not touched.", r.Machine.Database)
	default:
		return fmt.Sprintf("Database: %s. Note that on macOS the container's published port goes through Docker Desktop's user-space proxy, which made /db erratic in trial runs (identical repeats: 12,886 vs 2,102 req/s at c=256); the default `-pg auto` prefers the native local server for that reason. The app's dedicated database (127.0.0.1:15444/memoryz) was not touched.", r.Machine.Database)
	}
}

func writeJSON(path string, r *Results) error {
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

func writeMarkdown(path string, r *Results) error {
	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format, a...) }

	w("# Go HTTP framework benchmark for the Memoryz server (leaf-1.1)\n\n")
	w("Generated %s by `%s` from `server/bench` (module `memoryz/bench`, Go %s).\n\n", r.GeneratedAt, r.Command, r.Machine.GoVersion)
	w("**Decision: `BENCH_DECISION=%s`** — %s\n\n", r.Decision.Chosen, r.Decision.Reason)

	w("## Scope and caveats\n\n")
	for _, n := range r.Notes {
		w("- %s\n", n)
	}

	w("\n## Machine\n\n| Item | Value |\n|---|---|\n")
	w("| CPU | %s |\n", r.Machine.CPU)
	w("| Cores | %d |\n", r.Machine.Cores)
	w("| Go | %s |\n", r.Machine.GoVersion)
	w("| oha | %s (same machine as the server) |\n", r.Machine.OhaVersion)
	w("| OS | %s |\n", r.Machine.OS)
	w("| Load average at start | %s |\n", r.Machine.LoadAvg)
	w("| Candidate server GOMAXPROCS | %d |\n", r.Machine.ServerGOMAXPROCS)
	w("| PostgreSQL | %s |\n", r.Machine.Postgres)
	w("| Database | %s |\n", r.Machine.Database)

	w("\n## Candidates (versions pinned in go.mod, verified from the binary's build info)\n\n")
	w("| Candidate | Module | Version | Released (UTC) | Within 6 months (cutoff %s) | net/http compatible | h2c (live probe) | Eligible | Exclusion reason |\n", r.Decision.ReleaseCutoff)
	w("|---|---|---|---|---|---|---|---|---|\n")
	for _, c := range r.Candidates {
		reason := ""
		if !c.Eligible {
			reason = exclusionReason(c, r.Decision.ReleaseCutoff)
		}
		w("| %s | %s | %s | %s | %s | %s | %s | %s | %s |\n", c.Name, c.Module, c.Version, c.ReleaseDate,
			yesNo(c.LastReleaseWithin6Months), yesNo(c.NetHTTPCompatible), yesNo(c.H2C), yesNo(c.Eligible), reason)
	}
	w("\nRelease dates come from `go list -m -json <module>@<version>` (.Time of the tagged commit); net/http's date is the go%s toolchain module:\n\n", strings.TrimPrefix(r.Machine.GoVersion, "go"))
	for _, c := range r.Candidates {
		w("- %s: %s\n", c.Name, c.ReleaseSource)
	}
	w("\nnet/http compatibility as used by the rule: the router is an `http.Handler` served by `net/http.Server`, plain `http.Handler` / `func(http.Handler) http.Handler` middleware mounts without copying the request or response (so otelhttp and `http.Flusher` streaming work), and the `http.ResponseWriter` / `*http.Request` are reachable from a handler. h2c is not asserted from documentation: every server is started and asked for `/json` with a prior-knowledge HTTP/2 request over plaintext TCP.\n\n")
	for _, c := range r.Candidates {
		w("- **%s** — %s. h2c probe: %s. JSON path: %s.\n", c.Name, c.NetHTTPNote, c.H2CProbe, c.JSONPath)
	}

	w("\n## Method and exact commands\n\n")
	w("Endpoints (identical semantics per candidate, checked live before measuring: payloads, status codes for bad/missing/unknown ids, ~1KB echo round-trip):\n\n")
	for _, e := range r.Endpoints {
		w("- %s\n", e)
	}
	w("\nShared handler bodies live in `internal/app`; per-framework glue in `internal/candidates`. Every candidate uses the same `pgxpool` (MaxConns=%d) and the same query `%s` against a table of %d seeded rows.\n\n", r.Config.PoolMaxConns, r.Config.LookupSQL, r.Config.SeedRows)
	w("1. Orchestrator: `%s` (run from `server/bench`).\n", r.Command)
	w("2. Database (%s):\n\n```\n%s\n```\n\n", r.Config.DBMode, strings.Join(r.Config.DBCommands, "\n"))
	w("3. Router micro-benchmark: see the section below.\n")
	w("4. Per candidate: `<bench binary> -serve <name> -port <free loopback port> -watch-stdin` with `GOMAXPROCS=%d` and `BENCH_DSN=<dsn>` in the environment; wait for `GET /json` → 200; semantics check; h2c probe; then per endpoint a %s warm-up at c=%d followed by one %s measurement per concurrency (%s), HTTP/1.1 keep-alive; stop the server before the next candidate.\n", r.Config.GOMAXPROCS, r.Config.Warmup, r.Config.Concurrency[0], r.Config.Duration, joinInts(r.Config.Concurrency))
	w("5. oha command per endpoint (`<port>` is the candidate's port; `-c` is 64 or 256; the exact command of every run is in RESULTS.json):\n\n```\n%s\n```\n\n", strings.Join(r.Config.OhaTemplates, "\n"))
	w("   The /echo body is `%s` (%d bytes, sha256 %s).\n", r.Config.EchoBody.Path, r.Config.EchoBody.Bytes, r.Config.EchoBody.SHA256)

	w("\n## Results (%d runs)\n\n", len(r.Runs))
	w("| Candidate | Endpoint | c | req/s | p50 (ms) | p99 (ms) | Errors |\n|---|---|---:|---:|---:|---:|---:|\n")
	hasErrors := false
	for _, run := range r.Runs {
		errCell := "0"
		if run.Errors > 0 {
			hasErrors = true
			errCell = fmt.Sprintf("**%d ⚠**", run.Errors)
		}
		w("| %s | %s | %d | %.0f | %.2f | %.2f | %s |\n", run.Candidate, run.Endpoint, run.Concurrency, run.RPS, run.P50, run.P99, errCell)
	}
	if hasErrors {
		w("\nRuns marked ⚠ had errors (non-200 responses or failed requests):\n\n")
		for _, run := range r.Runs {
			if run.Errors > 0 {
				w("- %s %s c=%d: status codes %v, errors %v\n", run.Candidate, run.Endpoint, run.Concurrency, run.Status, run.ErrorDist)
			}
		}
	} else {
		w("\nNo run had errors (every counted request returned 200).\n")
	}

	w("\n### Requests/s by candidate (c=64 / c=256)\n\n")
	w("| Candidate | /json | /users/{id} | /echo | /db |\n|---|---:|---:|---:|---:|\n")
	for _, c := range r.Candidates {
		w("| %s |", c.Name)
		for _, ep := range []string{"/json", "/users/{id}", "/echo", "/db"} {
			w(" %.0f / %.0f |", rpsOf(r.Runs, c.Name, ep, 64), rpsOf(r.Runs, c.Name, ep, 256))
		}
		w("\n")
	}

	w("\n## Decision\n\n")
	w("Rule (fixed in the ledger before measuring): %s\n\n", r.Decision.Rule)
	w("Evaluated %s; release cutoff %s.\n\n", r.Decision.EvaluatedAt, r.Decision.ReleaseCutoff)
	w("| Candidate | Eligible | /db c=256 req/s | /echo c=256 req/s | Sum | vs net/http |\n|---|---|---:|---:|---:|---:|\n")
	std := scoreOf(r.Decision.Scores, candidates.StdlibName)
	for _, s := range r.Decision.Scores {
		w("| %s | %s | %.0f | %.0f | %.0f | %+.1f%% |\n", s.Candidate, yesNo(s.Eligible), s.DB256, s.Echo256, s.Sum, pct(s.Sum, std.Sum))
	}
	if len(r.Decision.Excluded) > 0 {
		w("\nExcluded (measured, shown, not eligible):\n\n")
		for _, e := range r.Decision.Excluded {
			w("- %s: %s\n", e.Candidate, e.Reason)
		}
	}
	w("\n**Chosen: %s** — %s\n\n", r.Decision.Chosen, r.Decision.Reason)
	w("```\nBENCH_DECISION=%s\n```\n", r.Decision.Chosen)

	if r.Microbench != "" {
		w("\n## Router micro-benchmark (`go test -bench`, in-process GET /users/12345, allocs/op)\n\n```\n%s```\n", r.Microbench)
	}
	if len(r.Oddities) > 0 {
		w("\n## Oddities observed\n\n")
		for _, o := range r.Oddities {
			w("- %s\n", o)
		}
	}
	return os.WriteFile(path, []byte(b.String()), 0o644)
}

func rpsOf(runs []Run, cand, ep string, conc int) float64 {
	for _, r := range runs {
		if r.Candidate == cand && r.Endpoint == ep && r.Concurrency == conc {
			return r.RPS
		}
	}
	return 0
}

func joinInts(ns []int) string {
	s := make([]string, len(ns))
	for i, n := range ns {
		s[i] = fmt.Sprint(n)
	}
	return strings.Join(s, ", ")
}
