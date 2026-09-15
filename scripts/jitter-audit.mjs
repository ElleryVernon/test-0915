// Gate leaf-9 T1: the jitter design stays visible in the code (docs/JITTER.md).
//  1. Every one of the 129 audited timing sites (scripts/jitter-sites.json) carries exactly one marker
//     `jitter: <token> … [site <id>]` whose token matches the frozen verdict (`none` for a site that
//     needs no jitter), and no marker names an unknown site.
//  2. Every production code line with a timing primitive (setTimeout, setInterval, sleep(,
//     time.After, time.Sleep, NewTicker, NewTimer, AfterFunc, a TTL/Lifetime/Lease constant, a retry
//     hint or retry helper, an 'online'/'offline'/'focus'/'visibilitychange' listener) has a `jitter:`
//     marker on it or within the 3 lines above, so a new timer cannot land without a decision.
//  3. Negative controls: removing a site marker, duplicating one, changing a token, or dropping a
//     primitive's marker must each be refused, or the audit itself is broken.
// Prints JITTER_AUDIT_OK sites=<n> primitives=<n> controls=refused.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const { sites } = JSON.parse(readFileSync('scripts/jitter-sites.json', 'utf8'));
const TOKENS = 'none|window|backoff|period|cooldown|retry-after|coalesce|admission|lifetime|library';
const MARKER = new RegExp(`jitter:\\s*(${TOKENS})\\b[^\\n]*`, 'g');
const SITE = /\[site ([^\]\s]+)\]/;

const listed = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', 'server', 'src', 'scripts', 'public', 'docs'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  .split('\n')
  .filter((f) => f && existsSync(f));
// The audit's own files and the design document quote markers; they are not code.
const skip = (f) => /^(scripts\/jitter-[^/]+|docs\/JITTER\.md)$/.test(f) || /node_modules|\/\.next\/|^out\//.test(f);
const markerFiles = listed.filter((f) => /\.(go|ts|tsx|mjs|js|md)$/.test(f) && !skip(f));
const codeFiles = listed.filter(
  (f) =>
    !skip(f) &&
    ((/^server\/(cmd|internal|bench)\//.test(f) && f.endsWith('.go') && !f.endsWith('_test.go') && !f.startsWith('server/internal/store/')) ||
      (/^src\//.test(f) && /\.(ts|tsx)$/.test(f)) ||
      f === 'public/sw.js' ||
      f === 'scripts/deploy.mjs'),
);

const PRIMITIVES = [
  /\bsetTimeout\(/,
  /\bsetInterval\(/,
  /(^|[^.\w])sleep\(/,
  /\btime\.After\(/,
  /\btime\.Sleep\(/,
  /\bNewTicker\(/,
  /\bNewTimer\(/,
  /\bAfterFunc\(/,
  /\b[A-Za-z_]*(TTL|Lifetime|LIFETIME|Lease)\s*(=|:=)[^=]/,
  /\.Retry\(/,
  /\bretryTransient\(/,
  /addEventListener\(\s*['"](online|offline|focus|visibilitychange)['"]/,
];
const commentOnly = (line) => /^\s*(\/\/|\*|\/\*|#|<!--)/.test(line);

function audit(files) {
  const problems = [];
  const seen = new Map();
  for (const [file, text] of files) {
    if (!/\.(go|ts|tsx|mjs|js|md)$/.test(file)) continue;
    for (const m of text.matchAll(MARKER)) {
      const site = SITE.exec(m[0])?.[1];
      if (!site) continue;
      if (seen.has(site)) problems.push(`${file}: site ${site} is marked twice (also in ${seen.get(site).file})`);
      else seen.set(site, { file, token: m[1] });
    }
  }
  const known = new Map(sites.map((s) => [s.id, s]));
  for (const s of sites) {
    const found = seen.get(s.id);
    if (!found) problems.push(`missing marker for site ${s.id} (expected token ${s.token})`);
    else if (found.token !== s.token) problems.push(`${found.file}: site ${s.id} has token ${found.token}, expected ${s.token}`);
  }
  for (const [site, { file }] of seen) if (!known.has(site)) problems.push(`${file}: marker names unknown site ${site}`);
  let primitives = 0;
  for (const [file, text] of files) {
    if (!codeFiles.includes(file)) continue;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (commentOnly(line) || !PRIMITIVES.some((p) => p.test(line))) return;
      primitives++;
      const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (!/jitter:\s*(none|window|backoff|period|cooldown|retry-after|coalesce|admission|lifetime|library)\b/.test(window))
        problems.push(`${file}:${i + 1}: timing primitive without a jitter: marker within 3 lines above: ${line.trim().slice(0, 100)}`);
    });
  }
  return { problems, primitives, marked: seen.size };
}

const files = new Map(markerFiles.map((f) => [f, readFileSync(f, 'utf8')]));
for (const f of codeFiles) if (!files.has(f)) files.set(f, readFileSync(f, 'utf8'));
const result = audit(files);
if (result.problems.length) {
  console.error(result.problems.join('\n'));
  console.error(`JITTER_AUDIT_FAILED problems=${result.problems.length}`);
  process.exit(1);
}

// Negative controls on in-memory copies.
const withEdit = (file, edit) => new Map([...files].map(([f, t]) => [f, f === file ? edit(t) : t]));
const siteHome = (id) => [...files].find(([, t]) => t.includes(`[site ${id}]`))?.[0];
const sample = sites.find((s) => s.token === 'coalesce') ?? sites[0];
const home = siteHome(sample.id);
const controls = {
  removed: audit(withEdit(home, (t) => t.replace(`[site ${sample.id}]`, ''))).problems.some((p) => p.includes(sample.id)),
  duplicated: audit(withEdit(codeFiles[0], (t) => `${t}\n// jitter: ${sample.token} copy [site ${sample.id}]\n`)).problems.some((p) => p.includes('twice')),
  token: audit(withEdit(home, (t) => t.replace(new RegExp(`jitter:\\s*${sample.token}([^\\n]*\\[site ${sample.id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\])`), 'jitter: backoff$1'))).problems.some((p) =>
    p.includes(`${sample.id} has token backoff`),
  ),
  primitive: (() => {
    const file = codeFiles.find((f) => /setTimeout\(/.test(files.get(f)) && /jitter:/.test(files.get(f)));
    if (!file) return false;
    // Strip every marker from one file that has a timer: its primitives must then be reported.
    return audit(withEdit(file, (t) => t.replace(/jitter:/g, 'jitter-removed:'))).problems.some((p) => p.startsWith(`${file}:`) && p.includes('timing primitive'));
  })(),
};
const refused = Object.values(controls).every(Boolean);
if (!refused) {
  console.error(`JITTER_AUDIT_CONTROLS_FAILED ${JSON.stringify(controls)}`);
  process.exit(1);
}
console.log(`JITTER_AUDIT_OK sites=${result.marked} primitives=${result.primitives} controls=refused`);
