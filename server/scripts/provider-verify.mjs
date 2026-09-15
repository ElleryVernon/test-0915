// Billable provider verification (the Go form of the Next.js `backend-check --provider-only`):
// builds the server and runs `server verify-provider`, which spends one model call per skill
// (quiz, essay, cards, grade, planner, ocr) with the key from .env and writes
// .data/openrouter-verification.json. The key value is never printed.
//
// A record is reused instead of paying again only when everything that decides the result is the
// same and it is under 24 hours old: the AI code (internal/ai), the validators it calls
// (internal/planner, internal/textmatch), the config that holds the default provider order
// (internal/config/config.go), and the model/order/effort environment. --fresh forces a new run.
// Usage: node server/scripts/provider-verify.mjs [--fresh] [--out <file>]
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (!process.env.OPENROUTER_API_KEY || !process.env.OPENROUTER_MODEL) {
  console.error('OPENROUTER_API_KEY and OPENROUTER_MODEL must be set in .env for this billable check');
  process.exit(2);
}
const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : join('.data', 'openrouter-verification.json');

const hash = createHash('sha256');
for (const dir of ['server/internal/ai', 'server/internal/planner', 'server/internal/textmatch']) {
  const abs = resolve(dir);
  for (const name of readdirSync(abs).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go')).sort())
    hash.update(`${dir}/${name}`).update('\0').update(readFileSync(join(abs, name))).update('\0');
}
hash.update('server/internal/config/config.go').update('\0').update(readFileSync(resolve('server/internal/config/config.go'))).update('\0');
hash.update(process.env.OPENROUTER_MODEL).update('\0').update(process.env.OPENROUTER_PROVIDER_ORDER ?? '').update('\0').update(process.env.OPENROUTER_REASONING_EFFORT ?? 'high');
const codeHash = hash.digest('hex');

if (!fresh && existsSync(out)) {
  try {
    const stored = JSON.parse(readFileSync(out, 'utf8'));
    const age = Date.now() - Date.parse(stored.verifiedAt);
    if (stored.server === 'go' && stored.codeHash === codeHash && stored.requests?.length >= 6 && age >= 0 && age < 24 * 3600 * 1000) {
      console.log(`OPENROUTER_VERIFIED ${JSON.stringify({ ...stored, reused: true, ageMinutes: Math.round(age / 60000) })}`);
      process.exit(0);
    }
  } catch {
    // unreadable record: verify again
  }
}

const work = mkdtempSync(join(tmpdir(), 'memoryz-verify-'));
try {
  const bin = join(work, 'server');
  const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: resolve('server'), encoding: 'utf8' });
  if (build.status !== 0) {
    console.error(build.stderr);
    process.exit(1);
  }
  const env = {
    ...process.env,
    ENV: 'development',
    LOG_FORMAT: 'json',
    LOG_LEVEL: 'info',
    // The command never opens the database; a syntactically valid URL keeps config validation quiet.
    DATABASE_URL: process.env.DATABASE_URL || 'postgres://memoryz@127.0.0.1:15444/memoryz',
    OTEL_EXPORTER: 'none',
  };
  const run = spawnSync(bin, ['verify-provider', '--out', out], { env, encoding: 'utf8', maxBuffer: 64 << 20 });
  // Server logs go to stderr as JSON; the key is redacted there (config.Redacted) and never echoed.
  for (const line of (run.stderr || '').split('\n'))
    if (line.includes('"ai request"') || line.includes('"ai retry"')) console.log(line);
  if (run.status !== 0 || !/^OPENROUTER_VERIFIED /m.test(run.stdout || '')) {
    process.stdout.write(run.stdout || '');
    console.error((run.stderr || '').split('\n').filter((line) => !line.startsWith('{')).join('\n'));
    process.exit(run.status || 1);
  }
  const report = JSON.parse(readFileSync(out, 'utf8'));
  report.codeHash = codeHash;
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`OPENROUTER_VERIFIED ${JSON.stringify(report)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
