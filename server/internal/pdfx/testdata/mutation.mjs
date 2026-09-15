// Mutation control for the pdfx package (gate X4): each rule below is broken in a throwaway copy of
// the package (a sibling directory inside the Go module, removed afterwards) and the unit and
// fixture tests must fail by name; the unmutated copy must pass first, so a build problem is not
// mistaken for a kill. The working tree is untouched. Run: node server/internal/pdfx/testdata/mutation.mjs
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const server = resolve(pkg, '../..');
const TESTS = 'TestLines|TestWrapJoin|TestParagraphs|TestFurniture|TestKeepImages|TestPlaceImages|TestTidy|TestFixture';

const MUTATIONS = [
  {
    name: 'whitespace runs are not collapsed to one space',
    file: 'layout.go',
    from: 'Text:  trim(spaceRun.ReplaceAllString(text.String(), " ")),',
    to: 'Text:  trim(text.String()),',
  },
  {
    name: 'a particle may start a word (wrapJoin particle rule disabled)',
    file: 'layout.go',
    from: '\tif boundStart(after) {\n\t\treturn ""\n\t}\n',
    to: '',
  },
  {
    name: 'tiny images are kept (minimum side 48 -> 4)',
    file: 'layout.go',
    from: 'min(p.Width, p.Height) >= 48 &&',
    to: 'min(p.Width, p.Height) >= 4 &&',
  },
];

const copyDir = join(server, 'internal', `pdfx_mutation_${process.pid}_${Date.now().toString(36)}`);
function makeCopy() {
  rmSync(copyDir, { recursive: true, force: true });
  mkdirSync(copyDir, { recursive: true });
  for (const entry of readdirSync(pkg)) {
    if (entry.endsWith('.go')) cpSync(join(pkg, entry), join(copyDir, entry));
  }
  mkdirSync(join(copyDir, 'testdata'));
  for (const entry of readdirSync(join(pkg, 'testdata'))) {
    if (entry.endsWith('.txt')) cpSync(join(pkg, 'testdata', entry), join(copyDir, 'testdata', entry));
  }
}
function run() {
  const result = spawnSync('go', ['test', `./internal/${copyDir.split('/').pop()}/`, '-count=1', '-run', TESTS], {
    cwd: server,
    encoding: 'utf8',
    env: { ...process.env, PDFX_SAMPLE_DIR: '' },
  });
  const output = `${result.stdout}${result.stderr}`;
  const failed = [...new Set([...output.matchAll(/^\s*--- FAIL: (\S+)/gm)].map((m) => m[1]))];
  const built = !/\[build failed\]|^#\s|cannot find package|missing go\.sum entry/m.test(output);
  return { status: result.status, failed, built, output };
}

let ok = true;
let caught = 0;
try {
  makeCopy();
  const control = run();
  console.log(`unmutated copy: exit=${control.status} · failed=${control.failed.length}${control.built ? '' : ' · BUILD FAILED'}`);
  if (control.status !== 0 || control.failed.length || !control.built) {
    ok = false;
    console.log(control.output.split('\n').slice(-25).join('\n'));
  } else {
    for (const m of MUTATIONS) {
      const source = readFileSync(join(pkg, m.file), 'utf8');
      if (source.split(m.from).length !== 2) {
        console.log(`ANCHOR · ${m.name} · expected exactly one match in ${m.file}`);
        ok = false;
        continue;
      }
      makeCopy();
      writeFileSync(join(copyDir, m.file), source.replace(m.from, m.to));
      const mutated = run();
      const killed = mutated.built && mutated.status !== 0 && mutated.failed.length > 0;
      console.log(`${killed ? 'KILLED' : 'SURVIVED'} · ${m.name} · failing: ${mutated.failed.join(' | ') || '-'}${mutated.built ? '' : ' · BUILD FAILED'}`);
      if (killed) caught++;
      else ok = false;
    }
  }
} finally {
  rmSync(copyDir, { recursive: true, force: true });
  if (existsSync(copyDir)) console.log(`could not remove ${copyDir}`);
}
if (!ok) process.exit(1);
console.log(`PDFX_MUTATIONS_CAUGHT ${caught}/${MUTATIONS.length}`);
