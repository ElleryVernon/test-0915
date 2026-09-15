// Command bench measures six Go HTTP framework candidates against the same
// four endpoints with oha and applies the decision rule fixed in
// .unlazy/memoryz-cloud/gates/leaf-1.1.md before anything was measured.
//
//	cd server/bench && go run . -results RESULTS.json -md RESULTS.md -duration 10s
//
// The same binary serves a single candidate when started with -serve; the
// orchestrator spawns itself that way, one candidate at a time.
package main

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"memoryz/bench/internal/pgbench"
)

type config struct {
	resultsPath string
	mdPath      string
	duration    time.Duration
	warmup      time.Duration
	concurrency []int
	gomaxprocs  int
	pgMode      pgbench.Mode
	pgPort      int
	envFile     string
	only        []string
	skipMicro   bool
	args        []string
}

func main() {
	var (
		serve      = flag.String("serve", "", "child mode: serve this candidate (net/http, chi, echo, gin, fiber, huma)")
		port       = flag.Int("port", 0, "child mode: loopback port to listen on")
		watchStdin = flag.Bool("watch-stdin", false, "child mode: shut down when stdin reaches EOF (the orchestrator holds the other end)")

		results = flag.String("results", "RESULTS.json", "JSON output path")
		md      = flag.String("md", "RESULTS.md", "Markdown output path")
		dur     = flag.Duration("duration", 10*time.Second, "measured duration per run (oha -z)")
		warm    = flag.Duration("warmup", 3*time.Second, "warm-up per endpoint before its measured runs, at the first concurrency (0 disables)")
		conc    = flag.String("concurrency", "64,256", "comma-separated oha connection counts")
		gmp     = flag.Int("gomaxprocs", 1, "GOMAXPROCS for candidate servers (0 = inherit); 1 mirrors the Cloud Run 1 vCPU target")
		pg      = flag.String("pg", string(pgbench.ModeAuto), "database provisioning: auto (a throwaway memoryz_bench on the local server from .env DATABASE_URL, else a Docker container), docker, local")
		pgPort  = flag.Int("pg-port", pgbench.DefaultPort, "host port for the throwaway Docker Postgres")
		envFile = flag.String("env-file", "", "the .env holding DATABASE_URL for -pg local (default: search upward from the working directory)")
		only    = flag.String("only", "", "comma-separated subset of candidates (development only; the ledger needs all six)")
		skip    = flag.Bool("skip-microbench", false, "skip the go test -bench router micro-benchmark")
	)
	flag.Parse()

	if *serve != "" {
		os.Exit(runServe(*serve, *port, *watchStdin))
	}

	cfg := config{
		resultsPath: *results,
		mdPath:      *md,
		duration:    *dur,
		warmup:      *warm,
		gomaxprocs:  *gmp,
		pgMode:      pgbench.Mode(*pg),
		pgPort:      *pgPort,
		envFile:     *envFile,
		skipMicro:   *skip,
		args:        os.Args[1:],
	}
	for _, s := range strings.Split(*conc, ",") {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		n, err := strconv.Atoi(s)
		if err != nil || n <= 0 {
			fmt.Fprintf(os.Stderr, "bad -concurrency value %q\n", s)
			os.Exit(2)
		}
		cfg.concurrency = append(cfg.concurrency, n)
	}
	if len(cfg.concurrency) == 0 || cfg.duration <= 0 {
		fmt.Fprintln(os.Stderr, "-concurrency and -duration must be positive")
		os.Exit(2)
	}
	if *only != "" {
		for _, s := range strings.Split(*only, ",") {
			if s = strings.TrimSpace(s); s != "" {
				cfg.only = append(cfg.only, s)
			}
		}
	}
	os.Exit(runOrchestrator(cfg))
}
