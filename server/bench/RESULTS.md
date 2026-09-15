# Go HTTP framework benchmark for the Memoryz server (leaf-1.1)

Generated 2026-09-15T10:10:37Z by `go run . -results RESULTS.json -md RESULTS.md -duration 10s` from `server/bench` (module `memoryz/bench`, Go go1.26.5).

**Decision: `BENCH_DECISION=net/http`** — echo has the largest /db+/echo sum at c=256 among eligible candidates (68042 req/s) but is within 5% of net/http (66665 req/s, +2.1%), so the rule picks the standard library (fewer dependencies).

## Scope and caveats

- PoC scale: 4 high-school classes, about 100 students plus their parents; the expected peak is ~50 concurrent users. c=64 and c=256 are above the target load on purpose: the numbers rank per-request framework overhead, they are not a capacity plan.
- oha ran on the same machine as the candidate server and the Postgres container, so the load generator competed with the server for CPU. Candidate servers ran with GOMAXPROCS=1 to mirror the Cloud Run 1 vCPU target (Go 1.25+ derives GOMAXPROCS from the container CPU limit) and to keep the server, not oha, as the bottleneck; oha used its default worker threads (12).
- This orchestrator ran no parallel builds or other benchmark work during the measurement; unrelated development containers were up, and other sessions on the machine could not be paused (load average at start, 1/5/15 min, including this run's own compilation: 8.61 7.80 11.39).
- Each candidate was compiled into this one binary, started alone as a child process on a free loopback port, checked for identical endpoint semantics against the live server, probed for h2c, warmed up 3s per endpoint at c=64, measured 10s per (endpoint, concurrency) with HTTP/1.1 keep-alive, then stopped before the next candidate.
- Run-to-run variation on a laptop is a few percent; the 5% margin in the decision rule exists for that reason. Re-running the command regenerates both result files.
- All candidates use encoding/json: gin is built without its jsoniter/go_json/sonic tags, fiber keeps its default (encoding/json) encoder and decoder, huma uses DefaultJSONFormat with DefaultConfig's `$schema` link transformer removed (CreateHooks=nil) so its bodies have the same shape as the others.
- Errors = non-200 responses plus failed requests (connection errors, timeouts); oha was run with -w so requests still in flight at the deadline are waited for rather than counted as errors. Runs with errors > 0 are marked ⚠ in the table.
- Database: local native PostgreSQL at 127.0.0.1:15444 (credentials from /Users/seongminhan/test/.env), throwaway database memoryz_bench created for this run and dropped afterwards; the app database was not touched. The native server was preferred over a Docker container because on macOS a container's published port goes through Docker Desktop's user-space proxy, which made /db erratic in trial runs on this machine (identical repeats of the same net/http server at c=256: 12,886 vs 2,102 req/s, p50 17 ms vs 100 ms) while the native server repeated at 23,450 / 22,838 / 16,741 req/s; `-pg docker` still runs the container variant. Only the database memoryz_bench was created and dropped; the app's dedicated database (memoryz) was not touched.

## Machine

| Item | Value |
|---|---|
| CPU | Apple M2 Pro |
| Cores | 12 |
| Go | go1.26.5 |
| oha | oha 1.16.0 (same machine as the server) |
| OS | macOS 26.2 (Darwin 25.2.0, darwin/arm64) |
| Load average at start | 8.61 7.80 11.39 |
| Candidate server GOMAXPROCS | 1 |
| PostgreSQL | PostgreSQL 18.6 on aarch64-apple-darwin25.2.0, compiled by Apple clang version 21.0.0 (clang-2100.1.1.101), 64-bit |
| Database | local native PostgreSQL at 127.0.0.1:15444 (credentials from /Users/seongminhan/test/.env), throwaway database memoryz_bench created for this run and dropped afterwards; the app database was not touched |

## Candidates (versions pinned in go.mod, verified from the binary's build info)

| Candidate | Module | Version | Released (UTC) | Within 6 months (cutoff 2026-03-15) | net/http compatible | h2c (live probe) | Eligible | Exclusion reason |
|---|---|---|---|---|---|---|---|---|
| net/http | standard library | go1.26.5 | 2026-07-01 | yes | yes | yes | yes |  |
| chi | github.com/go-chi/chi/v5 | v5.3.2 | 2026-08-20 | yes | yes | yes | yes |  |
| echo | github.com/labstack/echo/v5 | v5.3.1 | 2026-07-21 | yes | yes | yes | yes |  |
| gin | github.com/gin-gonic/gin | v1.12.0 | 2026-02-28 | no | yes | yes | no | last release v1.12.0 on 2026-02-28 is older than 6 months (cutoff 2026-03-15) |
| fiber | github.com/gofiber/fiber/v3 | v3.5.0 | 2026-08-12 | yes | no | no | no | not net/http compatible: fasthttp server: *fiber.App is not an http.Handler and cannot be served by net/http.Server; net/http handlers and middleware only through the adaptor package, which copies requests and responses (no http.Flusher streaming, otelhttp cannot wrap the server); fasthttp speaks no HTTP/2; no HTTP/2 h2c: prior-knowledge HTTP/2 GET /json failed: Get "http://127.0.0.1:56193/json": http2: failed reading the frame payload: http2: frame too large, note that the frame header looked like an HTTP/1.1 header |
| huma | github.com/danielgtaylor/huma/v2 | v2.39.1 | 2026-07-29 | yes | yes | yes | yes |  |

Release dates come from `go list -m -json <module>@<version>` (.Time of the tagged commit); net/http's date is the go1.26.5 toolchain module:

- net/http: go list -m -json golang.org/toolchain@v0.0.1-go1.26.5.darwin-arm64 → .Time 2026-07-01T21:24:27Z
- chi: go list -m -json github.com/go-chi/chi/v5@v5.3.2 → .Time 2026-08-20T09:37:52Z
- echo: go list -m -json github.com/labstack/echo/v5@v5.3.1 → .Time 2026-07-21T16:09:02Z
- gin: go list -m -json github.com/gin-gonic/gin@v1.12.0 → .Time 2026-02-28T10:10:09Z
- fiber: go list -m -json github.com/gofiber/fiber/v3@v3.5.0 → .Time 2026-08-12T15:09:15Z
- huma: go list -m -json github.com/danielgtaylor/huma/v2@v2.39.1 → .Time 2026-07-29T13:42:03Z

net/http compatibility as used by the rule: the router is an `http.Handler` served by `net/http.Server`, plain `http.Handler` / `func(http.Handler) http.Handler` middleware mounts without copying the request or response (so otelhttp and `http.Flusher` streaming work), and the `http.ResponseWriter` / `*http.Request` are reachable from a handler. h2c is not asserted from documentation: every server is started and asked for `/json` with a prior-knowledge HTTP/2 request over plaintext TCP.

- **net/http** — the standard library itself: http.ServeMux with Go 1.22+ method/pattern routing. h2c probe: prior-knowledge HTTP/2 GET /json → HTTP/2.0 200. JSON path: encoding/json Encoder to the ResponseWriter, Decoder from the body.
- **chi** — *chi.Mux is an http.Handler; handlers are http.HandlerFunc; middleware is func(http.Handler) http.Handler. h2c probe: prior-knowledge HTTP/2 GET /json → HTTP/2.0 200. JSON path: encoding/json Encoder to the ResponseWriter, Decoder from the body (chi has no JSON helpers).
- **echo** — *echo.Echo is an http.Handler; echo.WrapHandler/WrapMiddleware mount http.Handler and net/http middleware unchanged; c.Response() is the http.ResponseWriter and c.Request() the *http.Request. h2c probe: prior-knowledge HTTP/2 GET /json → HTTP/2.0 200. JSON path: c.JSON via DefaultJSONSerializer (encoding/json Encoder); c.Bind via encoding/json Unmarshal.
- **gin** — *gin.Engine is an http.Handler; gin.WrapH/WrapF mount http.Handler/HandlerFunc unchanged; c.Writer is the http.ResponseWriter and c.Request the *http.Request. h2c probe: prior-knowledge HTTP/2 GET /json → HTTP/2.0 200. JSON path: c.JSON via render.JSON (encoding/json Marshal; built without the jsoniter/go_json/sonic tags); c.ShouldBindJSON via encoding/json Decoder plus go-playground/validator.
- **fiber** — fasthttp server: *fiber.App is not an http.Handler and cannot be served by net/http.Server; net/http handlers and middleware only through the adaptor package, which copies requests and responses (no http.Flusher streaming, otelhttp cannot wrap the server); fasthttp speaks no HTTP/2. h2c probe: prior-knowledge HTTP/2 GET /json failed: Get "http://127.0.0.1:56193/json": http2: failed reading the frame payload: http2: frame too large, note that the frame header looked like an HTTP/1.1 header. JSON path: c.JSON via Config.JSONEncoder (default encoding/json Marshal); c.Bind().JSON via Config.JSONDecoder (default encoding/json Unmarshal).
- **huma** — humago adapter registers plain http.HandlerFunc on a net/http ServeMux, which is the http.Handler; typed operation handlers sit on top; net/http middleware wraps the mux. h2c probe: prior-knowledge HTTP/2 GET /json → HTTP/2.0 200. JSON path: huma.DefaultJSONFormat (encoding/json Encoder / Unmarshal) with request validation against the generated schema.

## Method and exact commands

Endpoints (identical semantics per candidate, checked live before measuring: payloads, status codes for bad/missing/unknown ids, ~1KB echo round-trip):

- GET /json — small JSON object {message, ts}
- GET /users/12345 — path parameter echoed in a small JSON object
- POST /echo — decode the 1002-byte JSON body and re-encode it
- GET /db?id=N — one pgxpool query, N random in 1..9999 per request (oha --rand-regex-url)

Shared handler bodies live in `internal/app`; per-framework glue in `internal/candidates`. Every candidate uses the same `pgxpool` (MaxConns=16) and the same query `SELECT id, name, score FROM bench WHERE id=$1` against a table of 10000 seeded rows.

1. Orchestrator: `go run . -results RESULTS.json -md RESULTS.md -duration 10s` (run from `server/bench`).
2. Database (local):

```
DROP DATABASE IF EXISTS memoryz_bench WITH (FORCE)
CREATE DATABASE memoryz_bench
CREATE TABLE bench (id serial PRIMARY KEY, name text NOT NULL, score int NOT NULL)
INSERT INTO bench (name, score) SELECT 'user-' || g, (g * 7919) % 100 FROM generate_series(1, 10000) AS g
ANALYZE bench
-- warm-up: 16 connections x 1000 lookups (SELECT id, name, score FROM bench WHERE id=$1)
```

3. Router micro-benchmark: see the section below.
4. Per candidate: `<bench binary> -serve <name> -port <free loopback port> -watch-stdin` with `GOMAXPROCS=1` and `BENCH_DSN=<dsn>` in the environment; wait for `GET /json` → 200; semantics check; h2c probe; then per endpoint a 3s warm-up at c=64 followed by one 10s measurement per concurrency (64, 256), HTTP/1.1 keep-alive; stop the server before the next candidate.
5. oha command per endpoint (`<port>` is the candidate's port; `-c` is 64 or 256; the exact command of every run is in RESULTS.json):

```
/json: oha -z 10s -c 64 -w --no-tui --http-version 1.1 --output-format json -t 30s 'http://127.0.0.1:<port>/json'
/users/{id}: oha -z 10s -c 64 -w --no-tui --http-version 1.1 --output-format json -t 30s 'http://127.0.0.1:<port>/users/12345'
/echo: oha -z 10s -c 64 -w --no-tui --http-version 1.1 --output-format json -t 30s -m POST -T application/json -D internal/app/echo-body.json 'http://127.0.0.1:<port>/echo'
/db: oha -z 10s -c 64 -w --no-tui --http-version 1.1 --output-format json -t 30s --rand-regex-url 'http://127.0.0.1:<port>/db\?id=[1-9][0-9]{0,3}'
```

   The /echo body is `internal/app/echo-body.json` (1002 bytes, sha256 0f4eb2b513d73404536d879bfd4fa8c2d2e847a67b60b1da315da347a1b9da79).

## Results (48 runs)

| Candidate | Endpoint | c | req/s | p50 (ms) | p99 (ms) | Errors |
|---|---|---:|---:|---:|---:|---:|
| net/http | /json | 64 | 58400 | 0.97 | 3.34 | 0 |
| net/http | /json | 256 | 52504 | 3.96 | 18.95 | 0 |
| net/http | /users/{id} | 64 | 64966 | 0.92 | 2.28 | 0 |
| net/http | /users/{id} | 256 | 65699 | 3.65 | 7.75 | 0 |
| net/http | /echo | 64 | 33639 | 1.79 | 4.20 | 0 |
| net/http | /echo | 256 | 33972 | 7.26 | 17.55 | 0 |
| net/http | /db | 64 | 32790 | 1.80 | 4.01 | 0 |
| net/http | /db | 256 | 32692 | 7.23 | 15.99 | 0 |
| chi | /json | 64 | 64960 | 0.92 | 2.20 | 0 |
| chi | /json | 256 | 64967 | 3.67 | 8.16 | 0 |
| chi | /users/{id} | 64 | 62189 | 0.95 | 2.40 | 0 |
| chi | /users/{id} | 256 | 62780 | 3.76 | 9.24 | 0 |
| chi | /echo | 64 | 33478 | 1.81 | 4.03 | 0 |
| chi | /echo | 256 | 33975 | 7.36 | 15.74 | 0 |
| chi | /db | 64 | 32547 | 1.80 | 4.10 | 0 |
| chi | /db | 256 | 31936 | 7.31 | 14.40 | 0 |
| echo | /json | 64 | 65754 | 0.91 | 2.25 | 0 |
| echo | /json | 256 | 66008 | 3.61 | 7.81 | 0 |
| echo | /users/{id} | 64 | 64729 | 0.91 | 2.35 | 0 |
| echo | /users/{id} | 256 | 65957 | 3.62 | 8.21 | 0 |
| echo | /echo | 64 | 35438 | 1.69 | 4.34 | 0 |
| echo | /echo | 256 | 35481 | 6.81 | 19.18 | 0 |
| echo | /db | 64 | 33186 | 1.78 | 3.96 | 0 |
| echo | /db | 256 | 32562 | 7.22 | 17.45 | 0 |
| gin | /json | 64 | 66000 | 0.91 | 2.18 | 0 |
| gin | /json | 256 | 66011 | 3.62 | 8.06 | 0 |
| gin | /users/{id} | 64 | 64838 | 0.91 | 2.26 | 0 |
| gin | /users/{id} | 256 | 64809 | 3.65 | 8.17 | 0 |
| gin | /echo | 64 | 31918 | 1.87 | 4.29 | 0 |
| gin | /echo | 256 | 32778 | 7.65 | 19.22 | 0 |
| gin | /db | 64 | 32251 | 1.81 | 4.07 | 0 |
| gin | /db | 256 | 31682 | 7.30 | 21.08 | 0 |
| fiber | /json | 64 | 101604 | 0.59 | 1.20 | 0 |
| fiber | /json | 256 | 102957 | 2.37 | 4.25 | 0 |
| fiber | /users/{id} | 64 | 100259 | 0.60 | 1.44 | 0 |
| fiber | /users/{id} | 256 | 101328 | 2.39 | 5.60 | 0 |
| fiber | /echo | 64 | 44029 | 1.36 | 3.06 | 0 |
| fiber | /echo | 256 | 44468 | 5.45 | 12.70 | 0 |
| fiber | /db | 64 | 45203 | 1.30 | 3.25 | 0 |
| fiber | /db | 256 | 43356 | 5.52 | 13.21 | 0 |
| huma | /json | 64 | 63357 | 0.93 | 2.31 | 0 |
| huma | /json | 256 | 63853 | 3.73 | 8.76 | 0 |
| huma | /users/{id} | 64 | 62036 | 0.96 | 2.38 | 0 |
| huma | /users/{id} | 256 | 61698 | 3.83 | 10.14 | 0 |
| huma | /echo | 64 | 23428 | 2.56 | 6.14 | 0 |
| huma | /echo | 256 | 22438 | 11.21 | 28.94 | 0 |
| huma | /db | 64 | 31689 | 1.84 | 4.57 | 0 |
| huma | /db | 256 | 31535 | 7.42 | 19.60 | 0 |

No run had errors (every counted request returned 200).

### Requests/s by candidate (c=64 / c=256)

| Candidate | /json | /users/{id} | /echo | /db |
|---|---:|---:|---:|---:|
| net/http | 58400 / 52504 | 64966 / 65699 | 33639 / 33972 | 32790 / 32692 |
| chi | 64960 / 64967 | 62189 / 62780 | 33478 / 33975 | 32547 / 31936 |
| echo | 65754 / 66008 | 64729 / 65957 | 35438 / 35481 | 33186 / 32562 |
| gin | 66000 / 66011 | 64838 / 64809 | 31918 / 32778 | 32251 / 31682 |
| fiber | 101604 / 102957 | 100259 / 101328 | 44029 / 44468 | 45203 / 43356 |
| huma | 63357 / 63853 | 62036 / 61698 | 23428 / 22438 | 31689 / 31535 |

## Decision

Rule (fixed in the ledger before measuring): Hard requirements: (1) net/http-compatible handler signature — the router is an http.Handler and plain net/http handlers and func(http.Handler) http.Handler middleware (otelhttp, streaming via http.Flusher, cloudsqlconn-backed pools in the same process) mount unchanged; (2) HTTP/2 h2c support, verified live with a prior-knowledge HTTP/2 request; (3) a release within the last 6 months, taken from the module's .Time in `go list -m -json`. Among the candidates meeting all three, pick the one with the largest sum of /db and /echo requests/s at c=256; if that winner is within 5% of the standard library's sum, choose the standard library (fewer dependencies). Candidates failing a hard requirement are measured and shown but excluded.

Evaluated 2026-09-15T10:10:37Z; release cutoff 2026-03-15.

| Candidate | Eligible | /db c=256 req/s | /echo c=256 req/s | Sum | vs net/http |
|---|---|---:|---:|---:|---:|
| net/http | yes | 32692 | 33972 | 66665 | +0.0% |
| chi | yes | 31936 | 33975 | 65912 | -1.1% |
| echo | yes | 32562 | 35481 | 68042 | +2.1% |
| gin | no | 31682 | 32778 | 64460 | -3.3% |
| fiber | no | 43356 | 44468 | 87824 | +31.7% |
| huma | yes | 31535 | 22438 | 53973 | -19.0% |

Excluded (measured, shown, not eligible):

- gin: last release v1.12.0 on 2026-02-28 is older than 6 months (cutoff 2026-03-15)
- fiber: not net/http compatible: fasthttp server: *fiber.App is not an http.Handler and cannot be served by net/http.Server; net/http handlers and middleware only through the adaptor package, which copies requests and responses (no http.Flusher streaming, otelhttp cannot wrap the server); fasthttp speaks no HTTP/2; no HTTP/2 h2c: prior-knowledge HTTP/2 GET /json failed: Get "http://127.0.0.1:56193/json": http2: failed reading the frame payload: http2: frame too large, note that the frame header looked like an HTTP/1.1 header

**Chosen: net/http** — echo has the largest /db+/echo sum at c=256 among eligible candidates (68042 req/s) but is within 5% of net/http (66665 req/s, +2.1%), so the rule picks the standard library (fewer dependencies).

```
BENCH_DECISION=net/http
```

## Router micro-benchmark (`go test -bench`, in-process GET /users/12345, allocs/op)

```
$ go test -run ^$ -bench ^BenchmarkRoute$ -benchmem -count 1 ./internal/candidates/
goos: darwin
goarch: arm64
pkg: memoryz/bench/internal/candidates
cpu: Apple M2 Pro
BenchmarkRoute/net_http-12         	 3129296	       403.6 ns/op	      96 B/op	       4 allocs/op
BenchmarkRoute/chi-12              	 1855825	       636.6 ns/op	     785 B/op	       7 allocs/op
BenchmarkRoute/echo-12             	 3335486	       350.0 ns/op	      80 B/op	       3 allocs/op
BenchmarkRoute/gin-12              	 3046659	       348.3 ns/op	     128 B/op	       4 allocs/op
BenchmarkRoute/fiber-12            	 3990861	       314.9 ns/op	     112 B/op	       3 allocs/op
BenchmarkRoute/huma-12             	 1468494	       798.7 ns/op	     232 B/op	       9 allocs/op
PASS
ok  	memoryz/bench/internal/candidates	7.806s
```
