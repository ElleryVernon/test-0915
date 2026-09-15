// Package oha runs the oha load generator and parses its JSON report.
package oha

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Spec is one oha invocation.
type Spec struct {
	URL            string
	RandRegexURL   bool   // --rand-regex-url: URL is a regex, one random match per request
	Method         string // "" means GET
	BodyFile       string // -D
	ContentType    string // -T
	Concurrency    int    // -c
	Duration       time.Duration
	RequestTimeout time.Duration // -t (0 = none)
}

// Args renders the oha command line. HTTP/1.1 with keep-alive (oha's
// default; --disable-keepalive is not passed), -w so requests still in flight
// at the deadline are waited for instead of being counted as errors.
func (s Spec) Args() []string {
	args := []string{
		"-z", fmtDuration(s.Duration),
		"-c", strconv.Itoa(s.Concurrency),
		"-w", "--no-tui", "--http-version", "1.1", "--output-format", "json",
	}
	if s.RequestTimeout > 0 {
		args = append(args, "-t", fmtDuration(s.RequestTimeout))
	}
	if s.Method != "" && s.Method != "GET" {
		args = append(args, "-m", s.Method)
	}
	if s.ContentType != "" {
		args = append(args, "-T", s.ContentType)
	}
	if s.BodyFile != "" {
		args = append(args, "-D", s.BodyFile)
	}
	if s.RandRegexURL {
		args = append(args, "--rand-regex-url")
	}
	return append(args, s.URL)
}

// Command is the shell-quoted command line.
func (s Spec) Command() string { return "oha " + shellJoin(s.Args()) }

// Result is the parsed report.
type Result struct {
	RPS       float64
	P50ms     float64
	P99ms     float64
	Requests  int // responses plus failed requests
	Errors    int // non-200 responses plus failed requests
	Status    map[string]int
	ErrorDist map[string]int
	Command   string
}

type report struct {
	Summary struct {
		SuccessRate    float64 `json:"successRate"`
		RequestsPerSec float64 `json:"requestsPerSec"`
	} `json:"summary"`
	LatencyPercentiles     map[string]float64 `json:"latencyPercentiles"`
	StatusCodeDistribution map[string]int     `json:"statusCodeDistribution"`
	ErrorDistribution      map[string]int     `json:"errorDistribution"`
}

// Run executes oha and parses its JSON output.
func Run(ctx context.Context, s Spec) (Result, error) {
	cmd := exec.CommandContext(ctx, "oha", s.Args()...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return Result{}, fmt.Errorf("%s: %w: %s", s.Command(), err, strings.TrimSpace(stderr.String()))
	}
	var r report
	if err := json.Unmarshal(stdout.Bytes(), &r); err != nil {
		return Result{}, fmt.Errorf("%s: parse output: %w", s.Command(), err)
	}
	res := Result{
		RPS:       r.Summary.RequestsPerSec,
		P50ms:     r.LatencyPercentiles["p50"] * 1000,
		P99ms:     r.LatencyPercentiles["p99"] * 1000,
		Status:    r.StatusCodeDistribution,
		ErrorDist: r.ErrorDistribution,
		Command:   s.Command(),
	}
	for code, n := range r.StatusCodeDistribution {
		res.Requests += n
		if code != "200" {
			res.Errors += n
		}
	}
	for _, n := range r.ErrorDistribution {
		res.Requests += n
		res.Errors += n
	}
	if res.Requests == 0 {
		return res, fmt.Errorf("%s: no requests completed", s.Command())
	}
	return res, nil
}

// Version returns the `oha --version` line.
func Version(ctx context.Context) (string, error) {
	out, err := exec.CommandContext(ctx, "oha", "--version").Output()
	if err != nil {
		return "", fmt.Errorf("oha --version: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

func fmtDuration(d time.Duration) string {
	if d%time.Second == 0 {
		return strconv.Itoa(int(d/time.Second)) + "s"
	}
	return strconv.FormatInt(d.Milliseconds(), 10) + "ms"
}

func shellJoin(args []string) string {
	parts := make([]string, len(args))
	for i, a := range args {
		if strings.ContainsAny(a, " \\?[]{}$'\"*&|;<>()") {
			a = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
		}
		parts[i] = a
	}
	return strings.Join(parts, " ")
}
