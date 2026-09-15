// Gate leaf-9 T7: the jitter tests can fail honestly (docs/JITTER.md). Each rule is broken in a
// throwaway copy of the tree and the named test must fail by name; the unmutated copy must pass
// every named test first. The working tree is never touched.
// Prints JITTER_MUTATION_OK killed=<n>/<n> control=pass.
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const database = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
  throw new Error('dedicated local database only');

// Web mutants: { file, from, to, tests: [test files], name: failing test name fragment }.
const WEB = [
  { name: 'between returns lo', file: 'src/lib/jitter.ts', from: 'const v = lo + rand() * (hi - lo);', to: 'const v = lo;', tests: ['tests/jitter.test.ts', 'tests/sync-scheduler.test.ts'], expect: 'between' },
  { name: 'fullJitter returns its cap', file: 'src/lib/jitter.ts', from: 'return between(0, Math.min(capMs, baseMs * 2 ** Math.min(Math.max(attempt, 0), 30)), rand);', to: 'return Math.min(capMs, baseMs * 2 ** Math.min(Math.max(attempt, 0), 30));', tests: ['tests/jitter.test.ts'], expect: 'between' },
  { name: 'retryDelay ignores Retry-After', file: 'src/lib/jitter.ts', from: 'return retryAfterMs == null ? backoffMs : Math.max(backoffMs, retryAfterMs + between(0, 1000, rand));', to: 'return backoffMs;', tests: ['tests/sync-scheduler.test.ts'], expect: 'review sync scheduler' },
  { name: 'cooldown drops the 429 fallback', file: 'src/lib/jitter.ts', from: 'return hint.status === 429 ? between(10_000, 20_000, rand) : 0;', to: 'return 0;', tests: ['tests/jitter.test.ts'], expect: 'between' },
  { name: 'scheduler window 0', file: 'src/lib/offline.ts', from: 'const delay = between(0, o.windowMs, o.rand);', to: 'const delay = 0;', tests: ['tests/sync-scheduler.test.ts'], expect: 'room simulation' },
  { name: 'transient() treats 409 as transient', file: 'src/lib/api.ts', from: '(error.status === 408 || error.status === 429 ||', to: '(error.status === 408 || error.status === 409 || error.status === 429 ||', tests: ['tests/sync-scheduler.test.ts'], expect: 'review sync scheduler' },
  { name: 'poll spread 0 (always 2500 ms)', file: 'src/lib/ai-task.ts', from: 'const pollWait = (rand?: Rand) => between(POLL_MS * 0.75, POLL_MS * 1.25, rand);', to: 'const pollWait = (rand?: Rand) => (void rand, POLL_MS);', tests: ['tests/ai-task-poll.test.ts'], expect: 'AI status polling' },
  { name: 'no wake window after a failed POST', file: 'src/lib/ai-task.ts', from: "    if (postResult && 'error' in postResult && serverDown(postResult.error)) await sleep(between(0, POLL_MS, rand), signal);\n", to: '', tests: ['tests/ai-task-poll.test.ts'], expect: 'AI status polling' },
  { name: 'manual retry ignores its cooldown', file: 'src/lib/ai-task.ts', from: '(task.retryAt ?? 0) > Date.now()', to: 'false', tests: ['tests/ai-task-poll.test.ts'], expect: 'manual retry cooldown' },
  { name: 'unclaimed request id is not reused', file: 'src/lib/ai-task.ts', from: 'if (task.unclaimed && !existsRemotely) {', to: 'if (false) {', tests: ['tests/ai-task-poll.test.ts'], expect: 'manual retry cooldown' },
  { name: 'a cancelled scheduler keeps retrying', file: 'src/lib/offline.ts', from: 'const current = (userId: string, state: SyncState) => scheduled.get(userId) === state;', to: 'const current = (userId: string, state: SyncState) => (void userId, void state, true);', tests: ['tests/sync-scheduler.test.ts'], expect: 'a cancel stops an attempt in flight' },
  { name: 'joined callers each count the failure', file: 'src/lib/offline.ts', from: '  if (state.inflight) return state.inflight;\n', to: '', tests: ['tests/sync-scheduler.test.ts'], expect: 'a cancel stops an attempt in flight' },
];
// Server mutants: { file (under server/), from, to, pkg, test }.
const GO = [
  { name: 'Full ignores rand', file: 'internal/jitter/jitter.go', from: '\treturn Between(r, 0, c)', to: '\treturn c', pkg: './internal/jitter', test: 'TestFull' },
  { name: 'RetryAfter ignores the spread', file: 'internal/httpx/json.go', from: 'e.RetryMin+jitter.Between(r, 0, e.RetrySpread)', to: 'e.RetryMin', pkg: './internal/httpx', test: 'TestRetryAfterHeader' },
  { name: 'ratelimit refusal without spread', file: 'internal/ratelimit/ratelimit.go', from: 'return ErrTooMany.Retry(left, refusalSpread)', to: 'return ErrTooMany.Retry(left, 0)', pkg: './internal/ratelimit', test: 'TestRatelimitHint' },
  { name: 'window script without PEXPIRE', file: 'internal/cache/valkey.go', from: "  redis.call('PEXPIRE', KEYS[1], ARGV[1])", to: '  -- no expiry', pkg: './internal/cache', test: 'TestValkey' },
  { name: 'Valkey bump ignores the floor', file: 'internal/cache/valkey.go', from: 'local n = math.max(cur + 1, tonumber(ARGV[1]))', to: 'local n = cur + 1', pkg: './internal/cache', test: 'TestValkey' },
  { name: 'memory bump ignores the floor', file: 'internal/cache/memory.go', from: '\tnext := max(cur+1, floor)', to: '\tnext := cur + 1', pkg: './internal/cache', test: 'TestBump' },
  { name: 'session expiry without the trim', file: 'internal/auth/session.go', from: 'return now.Add(idleLifetime - jitter.Between(a.rand, 0, lifetimeTrim))', to: 'return now.Add(idleLifetime)', pkg: './internal/auth', test: 'TestSessionLifetime' },
  { name: 'renewal threshold ignored', file: 'internal/auth/session.go', from: 'if sess.CreatedAt.IsZero() || sess.ExpiresAt.Sub(now) >= renewBelow {', to: 'if sess.CreatedAt.IsZero() {', pkg: './internal/auth', test: 'TestSessionRenewal' },
  { name: 'fill bypasses singleflight', file: 'internal/api/cachelayer.go', from: 'ch := s.flights.DoChan(key, func() (any, error) {', to: 'ch := s.flights.DoChan(key+time.Now().String(), func() (any, error) {', pkg: './internal/api', test: 'TestFillCoalesces' },
  { name: 'admission bypassed', file: 'internal/ai/provider.go', from: 'release, err := p.admit(ctx)', to: 'release, err := func() {}, error(nil)', pkg: './internal/ai', test: 'TestAdmission' },
  { name: 'upstream Retry-After ignored', file: 'internal/ai/provider.go', from: 'errBusy.Retry(upstreamWait(res.Header.Get("Retry-After"), time.Now()), busySpread)', to: 'errBusy.Retry(busyMin, busySpread)', pkg: './internal/ai', test: 'TestRetryHints' },
  { name: 'pdfSlot ignores ClientGone', file: 'internal/api/uploads.go', from: '\tcase <-httpx.ClientGone(ctx):\n\t\treturn nil, context.Canceled\n', to: '', pkg: './internal/api', test: 'TestPDFQueue' },
  { name: 'budget charged for replays', file: 'internal/api/airuns.go', from: '\thash := inputHash(kind, input)\n', to: '\thash := inputHash(kind, input)\n\tif err := s.aiBudget(ctx, userID); err != nil {\n\t\treturn runOutcome{}, err\n\t}\n', pkg: './internal/api', test: 'TestBudgetOnlyForNewRuns' },
  { name: 'Drain cancels nothing', file: 'internal/api/airuns.go', from: '\t\tcancel.(context.CancelCauseFunc)(errDraining)', to: '\t\t_ = cancel', pkg: './internal/api', test: 'TestDrainInterruptsRuns' },
  { name: 'client address ignores trusted proxies', file: 'internal/api/api.go', from: 'slices.ContainsFunc(trusted, func(p netip.Prefix) bool { return p.Contains(addr.Unmap()) })', to: 'slices.ContainsFunc(trusted[:0], func(p netip.Prefix) bool { return p.Contains(addr.Unmap()) })', pkg: './internal/api', test: 'TestClientIP' },
  { name: 'GCS write not idempotent', file: 'internal/blob/gcs.go', from: '.If(storage.Conditions{DoesNotExist: true})', to: '', pkg: './internal/blob', test: 'TestGCSIdempotent' },
  { name: 'MaxConnLifetimeJitter 0', file: 'internal/db/db.go', from: '\tcfg.MaxConnLifetimeJitter = 5 * time.Minute', to: '\tcfg.MaxConnLifetimeJitter = 0', pkg: './internal/db', test: 'TestTune$' },
  { name: 'DeadlineDelay 0', file: 'internal/db/db.go', from: 'DeadlineDelay: cancelGrace}', to: 'DeadlineDelay: 0}', pkg: './internal/db', test: 'TestTuneCanceledQueryKeepsConn' },
  { name: 'db.Tx rolls back on the cancelled context', file: 'internal/db/db.go', from: '\t\t_ = tx.Rollback(rollback)', to: '\t\t_ = rollback\n\t\t_ = tx.Rollback(ctx)', pkg: './internal/db', test: 'TestTuneCanceledTxKeepsConn' },
  { name: 'fill build bound to the leaving leader', file: 'internal/api/cachelayer.go', from: 'bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), fillTimeout)', to: 'bctx, cancel := context.WithTimeout(ctx, fillTimeout)', pkg: './internal/api', test: 'TestFillCoalesces' },
  { name: 'bump uses the request context', file: 'internal/api/cachelayer.go', from: '\tbase := context.WithoutCancel(ctx)', to: '\tbase := ctx', pkg: './internal/api', test: 'TestBumpDetached' },
  { name: 'claim without the request-id lock', file: 'internal/api/airuns.go', from: '\t\t\tif _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "airun:"+userID+":"+requestID); err != nil {\n\t\t\t\treturn err\n\t\t\t}\n', to: '', pkg: './internal/api', test: 'TestBudgetOnceForConcurrentSameID' },
  { name: 'provider 504 without a hint', file: 'internal/ai/provider.go', from: '"AI 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.").Retry(busyMin, busySpread)', to: '"AI 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.")', pkg: './internal/ai', test: 'TestRetryHints' },
  { name: 'spans keep the client address', file: 'internal/telemetry/telemetry.go', from: 'func Redact(e sdktrace.SpanExporter) sdktrace.SpanExporter { return redactExporter{e} }', to: 'func Redact(e sdktrace.SpanExporter) sdktrace.SpanExporter { return e }', pkg: './internal/telemetry', test: 'TestRedact' },
  { name: 'hint not rounded to whole milliseconds', file: 'internal/httpx/json.go', from: 'return (d + time.Millisecond - 1).Truncate(time.Millisecond), true', to: 'return d, true', pkg: './internal/httpx', test: 'TestRetryAfterHeader' },
];

function webCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'memoryz-jitter-web-'));
  for (const entry of ['src', 'tests']) cpSync(join(root, entry), join(dir, entry), { recursive: true });
  for (const file of ['package.json', 'tsconfig.json']) cpSync(join(root, file), join(dir, file));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}
function serverCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'memoryz-jitter-go-'));
  cpSync(join(root, 'server'), join(dir, 'server'), { recursive: true, filter: (src) => !src.includes('/bench') });
  // Tests read fixtures from ../tests (the repository layout).
  symlinkSync(join(root, 'tests'), join(dir, 'tests'), 'dir');
  return dir;
}
function runWeb(dir, tests) {
  const r = spawnSync('npx', ['tsx', '--test', ...tests], { cwd: dir, encoding: 'utf8', timeout: 600_000 });
  const out = `${r.stdout}${r.stderr}`;
  const failed = [...new Set([...out.matchAll(/^not ok \d+ - (.+)$/gm), ...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]))];
  return { status: r.status, failed, out };
}
function runGo(dir, pkg, test) {
  const r = spawnSync('go', ['test', pkg, '-count=1', '-timeout', '120s', '-run', `^(${test})`], { cwd: join(dir, 'server'), encoding: 'utf8', env: { ...process.env, DATABASE_URL: database.href }, timeout: 300_000 });
  const out = `${r.stdout}${r.stderr}`;
  const name = test.replace(/\$$/, '');
  const failedByName = new RegExp(`^--- FAIL: ${name}\\b`, 'm').test(out) || (/panic: test timed out/.test(out) && out.includes(name));
  const buildFailed = /\[build failed\]|cannot use|undefined:|declared and not used/.test(out);
  return { status: r.status, failedByName, buildFailed, out };
}

let ok = true;
// Controls: the unmutated copies pass every named test.
const webTests = [...new Set(WEB.flatMap((m) => m.tests))];
let control = webCopy();
try {
  const clean = runWeb(control, webTests);
  console.log(`web control: exit=${clean.status} failed=${clean.failed.length}`);
  if (clean.status !== 0 || clean.failed.length) ok = false;
} finally {
  rmSync(control, { recursive: true, force: true });
}
control = serverCopy();
try {
  for (const pkg of [...new Set(GO.map((m) => m.pkg))]) {
    const tests = GO.filter((m) => m.pkg === pkg).map((m) => m.test).join('|');
    const clean = runGo(control, pkg, tests);
    console.log(`go control ${pkg} (${tests}): exit=${clean.status}`);
    if (clean.status !== 0) {
      ok = false;
      console.log(clean.out.slice(-1500));
    }
  }
} finally {
  rmSync(control, { recursive: true, force: true });
}
const controlPassed = ok;

let killed = 0;
for (const m of WEB) {
  const source = readFileSync(join(root, m.file), 'utf8');
  if (source.split(m.from).length !== 2) {
    console.log(`ANCHOR · ${m.name} · expected exactly one occurrence in ${m.file}`);
    ok = false;
    continue;
  }
  const dir = webCopy();
  try {
    writeFileSync(join(dir, m.file), source.replace(m.from, m.to));
    const r = runWeb(dir, m.tests);
    const dead = r.status !== 0 && r.failed.some((f) => f.includes(m.expect));
    if (dead) killed++;
    else ok = false;
    console.log(`${dead ? 'KILLED' : 'SURVIVED'} · web · ${m.name} · failing: ${r.failed.join(' | ') || '-'}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
for (const m of GO) {
  const source = readFileSync(join(root, 'server', m.file), 'utf8');
  if (source.split(m.from).length !== 2) {
    console.log(`ANCHOR · ${m.name} · expected exactly one occurrence in server/${m.file}`);
    ok = false;
    continue;
  }
  const dir = serverCopy();
  try {
    writeFileSync(join(dir, 'server', m.file), source.replace(m.from, m.to));
    const r = runGo(dir, m.pkg, m.test);
    const dead = r.status !== 0 && r.failedByName && !r.buildFailed;
    if (dead) killed++;
    else ok = false;
    console.log(`${dead ? 'KILLED' : 'SURVIVED'} · go · ${m.name} · ${m.test}${r.buildFailed ? ' (build failed: the mutant is invalid)' : ''}`);
    if (!dead) console.log(r.out.slice(-800));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const total = WEB.length + GO.length;
if (!ok) {
  console.log(`JITTER_MUTATION_FAILED killed=${killed}/${total} control=${controlPassed ? 'pass' : 'fail'}`);
  process.exit(1);
}
console.log(`JITTER_MUTATION_OK killed=${killed}/${total} control=pass`);
