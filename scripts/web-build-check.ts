// Gate leaf-2.1 W1: the web is a static build with no server code left behind. Verifies the
// removals, runs `next build` (output: 'export'), inspects `out/`, and confirms the TypeScript
// checks, the unit tests and the three golden generators (against the frozen TS references) still
// hold — the goldens must come out byte-identical.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let checks = 0;
const check = (ok: unknown, message: string) => {
  assert.ok(ok, message);
  checks++;
};
const run = (cmd: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

// 1. Server code is gone; the reference copies exist.
for (const gone of ['src/lib/server', 'src/proxy.ts', 'src/app/api', 'src/lib/oauth.ts', 'tests/backend.test.ts']) check(!existsSync(gone), `${gone} removed`);
for (const kept of ['server/testdata/reference/algorithms.ts', 'server/testdata/reference/pdf-extract.ts', 'scripts/lib/session.ts', 'prisma/schema.prisma', 'prisma/seed.ts']) check(existsSync(kept), `${kept} present`);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const dep of ['@prisma/client', '@prisma/adapter-pg', 'jose', 'pdf-parse', '@napi-rs/canvas']) check(!pkg.dependencies?.[dep], `${dep} is not a runtime dependency`);
check(pkg.devDependencies?.prisma && pkg.devDependencies?.['@prisma/client'] && pkg.devDependencies?.['pdf-parse'], 'prisma and the PDF oracle package stay as dev dependencies');
const config = readFileSync('next.config.ts', 'utf8');
check(/output: 'export'/.test(config) && /PHASE_DEVELOPMENT_SERVER/.test(config) && /GO_API_URL/.test(config) && !/async headers\(/.test(config), 'next.config: export at build, rewrite in dev, no headers()');
const grep = run('grep', ['-rln', '--exclude=web-build-check.ts', '--exclude=db.ts', "src/lib/server\\|from '@/lib/server\\|better-auth\\|@prisma/client", 'src', 'scripts', 'tests']);
check(grep.status === 1, `no remaining imports of the server code: ${grep.out.trim()}`);

// 2. The real publish pipeline: next build → merge kept chunks → precompress → out/. A bare
// `next build` here would overwrite out/ without the .br/.gz siblings web-static-check audits.
const build = run(process.execPath, ['scripts/build-web.mjs'], { NEXT_TELEMETRY_DISABLED: '1' });
check(build.status === 0, `web build failed:\n${build.out.slice(-3000)}`);
const routes = ['study', 'subjects', 'quiz', 'essay', 'flashcards', 'wrong-notes', 'create-card', 'completed-subjects', 'community', 'boards', 'planner', 'parent', 'parent-boards', 'cheer', 'admin', 'search', 'notifications', 'profile'];
check(existsSync('out/index.html') && existsSync('out/404.html'), 'out/index.html and out/404.html exist');
// Next writes out/<screen>.html (trailingSlash off); the Go server maps /<screen> to it.
for (const route of routes) check(existsSync(join('out', route + '.html')) || existsSync(join('out', route, 'index.html')), `out/${route}.html exported`);
check(!existsSync('.next/server/app/api'), 'no API route handlers in the build');
const shell = readFileSync('out/index.html', 'utf8');
check(/\/_next\/static\//.test(shell) && /manifest\.webmanifest/.test(shell), 'the shell references hashed assets and the manifest');
const staticDir = readdirSync('out/_next/static', { recursive: true }) as string[];
check(staticDir.some((f) => f.endsWith('.js')), 'hashed JS chunks present');

// 3. Type check and unit tests.
const tsc = run('node_modules/.bin/tsc', ['--noEmit']);
check(tsc.status === 0, `tsc failed:\n${tsc.out.slice(-3000)}`);
const tests = run('node_modules/.bin/tsx', ['--import', './tests/register-css.mjs', '--test', ...readdirSync('tests').filter((f) => f.endsWith('.test.ts')).map((f) => join('tests', f))]);
check(tests.status === 0 && /^(#|ℹ) fail 0$/m.test(tests.out), `unit tests:\n${tests.out.slice(-2000)}`);

// 4. Golden generators produce byte-identical goldens from the frozen references.
const tmp = mkdtempSync(join(tmpdir(), 'memoryz-golden-'));
try {
  const goldens: [string, string[], string][] = [
    ['server/internal/srs/testdata/golden.json', ['server/internal/srs/testdata/gen.ts'], 'GOLDEN_OUT'],
    ['server/internal/planner/testdata/golden.json', ['server/internal/planner/testdata/gen.ts'], 'GOLDEN_OUT'],
    ['server/internal/pdfx/testdata/document.ts.txt', ['server/internal/pdfx/testdata/ts-text.ts', 'document', join(tmp, 'document.ts.txt')], ''],
  ];
  for (const [golden, args, envKey] of goldens) {
    const target = envKey ? join(tmp, golden.replace(/\//g, '_')) : args[2];
    const gen = run('node_modules/.bin/tsx', args, envKey ? { [envKey]: target } : {});
    check(gen.status === 0, `${args[0]} runs: ${gen.out.slice(-500)}`);
    check(existsSync(target) && sha(target) === sha(golden), `${golden} regenerates byte-identical`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`WEB_BUILD_OK (${checks} checks)`);
