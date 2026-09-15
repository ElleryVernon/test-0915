// The Go server's regression suite: every check the leaves proved, re-run in one order with one
// verdict. Each suite must exit 0 AND print its own success token; the token regexes are the same
// ones the gate ledgers use, so a suite cannot pass here and fail there. Paid AI is impossible:
// the OpenRouter key is emptied for every suite. Only the dedicated local database is allowed.
// Usage: node server/scripts/regression.mjs            (all suites)
//        REGRESSION_ONLY=auth-http,cache-http node …    (a subset; an unknown name fails)
//        REGRESSION_LOAD=1 node …                       (also the peak load scenario)
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const database = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
  throw new Error('dedicated local database only');

const goStatic = 'cd server && go build ./... && go vet ./... && test -z "$(gofmt -l ./cmd ./internal)" && sqlc diff && echo STATIC_OK';
const goTests = 'cd server && go test ./... -count=1 2>&1 | tee /dev/stderr | grep -E "^(ok|FAIL|---|panic)" | grep -vc "^ok" | grep -qx 0 && echo GO_TESTS_OK';
const suites = [
  ['static', goStatic, /STATIC_OK/],
  ['go-test', goTests, /^(?=[\s\S]*^GO_TESTS_OK$)(?=[\s\S]*^ok\s+memoryz\/server\/internal\/api\s)/m],
  ['review-static', 'node server/scripts/review-static.mjs', /REVIEW_STATIC_OK/],
  ['migrate-check', 'node server/scripts/migrate-check.mjs', /MIGRATIONS_MATCH_PRISMA/],
  ['config-safety', 'node server/scripts/config-safety.mjs', /CONFIG_SAFETY_OK/],
  ['foundation-http', 'node server/scripts/foundation-http.mjs', /FOUNDATION_HTTP_OK/],
  ['auth-http', 'node server/scripts/auth-http.mjs', /AUTH_HTTP_OK/],
  ['seed-parity', 'node server/scripts/seed-parity.mjs', /SEED_PARITY_OK/],
  ['integration-check', 'node server/scripts/serve.mjs "npx tsx scripts/integration-check.ts"', /MEMORYZ_INTEGRATION_OK \(\d+ HTTP checks/],
  ['materials-http', 'node server/scripts/serve.mjs "npx tsx scripts/materials-http.ts"', /MATERIALS_HTTP_OK \(\d+ checks/],
  ['study-review-http', 'node server/scripts/serve.mjs "npx tsx scripts/study-review-http.ts"', /STUDY_REVIEW_HTTP_OK/],
  ['api-contract', 'node server/scripts/serve.mjs "npx tsx scripts/api-contract.ts"', /API_CONTRACT_OK \(\d+ checks/],
  ['api-contract-community', 'node server/scripts/serve.mjs "npx tsx scripts/api-contract-community.ts"', /API_CONTRACT_COMMUNITY_OK \(\d{2,} checks/],
  ['api-contract-parent', 'node server/scripts/serve.mjs "npx tsx scripts/api-contract-parent.ts"', /API_CONTRACT_PARENT_OK \(\d{2,} checks/],
  // bootstrap-parity (TS server vs Go server) ended with the TS server's removal on 2026-09-15; its last
  // evidence is leaf-1.5 H5. The Go payload's shape is held by api-contract and cache-http.
  ['cache-http', 'node server/scripts/serve.mjs "node server/scripts/cache-http.mjs"', /CACHE_HTTP_OK \(\d+ checks/],
  ['telemetry-check', 'node server/scripts/telemetry-check.mjs', /TELEMETRY_OK \(\d+ checks/],
  // Every refusal a class can meet at once carries its retry hint (docs/JITTER.md).
  ['jitter-http', 'node server/scripts/jitter-http.mjs', /JITTER_HTTP_OK \(\d+ checks/],
];
if (process.env.REGRESSION_LOAD === '1') suites.push(['load-peak', 'node server/scripts/load-peak.mjs', /LOAD_PEAK_OK errors=0/]);

let selected = suites;
if (process.env.REGRESSION_ONLY) {
  const names = process.env.REGRESSION_ONLY.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !suites.some(([name]) => name === n));
  if (unknown.length) {
    console.error(`unknown suite(s): ${unknown.join(', ')}`);
    console.log('REGRESSION_FAILED (unknown suite)');
    process.exit(2);
  }
  selected = suites.filter(([name]) => names.includes(name));
}

const env = { ...process.env, OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '', ALLOW_PAID_AI: '' };
const results = [];
for (const [name, command, token] of selected) {
  const started = Date.now();
  const run = spawnSync(command, { shell: '/bin/sh', encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const match = token.exec(output);
  const ok = run.status === 0 && match !== null;
  results.push({ name, ok, seconds, status: run.status, output, evidence: match ? match[0].split('\n').pop() : '' });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(24)} ${seconds.padStart(6)}s exit=${run.status} ${ok ? results.at(-1).evidence : ''}`);
  if (!ok) console.log(`--- ${name} output (tail) ---\n${output.slice(-3000)}\n---`);
}
// A machine-readable record survives output truncation in gate evidence.
mkdirSync('.data', { recursive: true });
writeFileSync('.data/regression-last.json', JSON.stringify({ at: new Date().toISOString(), suites: results.map(({ name, ok, seconds, status, evidence, output }) => ({ name, ok, seconds, status, evidence, tail: ok ? undefined : output.slice(-4000) })) }, null, 2));
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`REGRESSION_FAILED (${results.length} suites, ${failed.length} failed: ${failed.map((r) => r.name).join(', ')})`);
  process.exit(1);
}
console.log(`REGRESSION_OK (${results.length} suites, 0 failed)`);
