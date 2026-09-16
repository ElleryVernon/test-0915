// Gate W1: nothing in any git worktree is missing from main. For every worktree, every branch
// commit ahead of main counts as pending, and every modified or untracked file is classified:
//   integrated  — its content is main's working copy, or a blob main's history carried since the
//                 worktree's base (it was merged, and main moved on), or a 3-way merge
//                 (base = worktree HEAD, ours = main, theirs = worktree) changes no line of main,
//                 or main holds every line the worktree added (the merge only conflicts because
//                 main moved those lines), or main held them all before it removed the file;
//   superseded  — a capture artifact (docs/screenshots/**) that main re-captured later (tracked in
//                 main with a newer modification time);
//   local       — worktree-only tooling (.claude/**) that never belongs in main;
//   pending     — anything else, including a merge with conflicts.
// Prints WORKTREES_INTEGRATED only when pending = 0 and no branch is ahead of main.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const root = process.cwd();
// Several lookups ask for paths a commit may not have; their stderr is caught with the error, not printed.
const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// File contents must keep their trailing newline, so they are read without trimming.
const gitRaw = (args, cwd = root) => execFileSync('git', args, { cwd, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const worktrees = git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).filter((p) => p !== root);
const branches = git(['for-each-ref', '--format=%(refname:short) %(ahead-behind:main)', 'refs/heads']).split('\n').filter(Boolean).map((l) => l.split(' '));
const ahead = branches.filter(([name, a]) => name !== 'main' && Number(a) > 0);
const work = mkdtempSync(join(tmpdir(), 'wt-merge-'));
const mainBlob = (path) => {
  try {
    return git(['rev-parse', `main:${path}`]);
  } catch {
    return null;
  }
};
// The lines the worktree's own change adds (base -> worktree file), without the ones every file
// repeats (a brace, a blank line). A positional merge can conflict while main already has every line
// the worktree added — which is what "integrated" means — and main may have taken the change before
// replacing the file altogether.
const addedLines = (baseContent, file) => {
  const b = join(work, 'added-base');
  const t = join(work, 'added-theirs');
  writeFileSync(b, baseContent);
  writeFileSync(t, readFileSync(file));
  return spawnSync('diff', [b, t], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .stdout.split('\n')
    .filter((l) => l.startsWith('> '))
    .map((l) => l.slice(2).trim())
    .filter((l) => l.length > 3);
};
const carriesAll = (text, added) => {
  const have = new Set(text.split('\n').map((l) => l.trim()));
  return added.length > 0 && added.every((l) => have.has(l));
};

let files = 0;
let pending = 0;
let conflicts = 0;
const lines = [];
try {
  for (const wt of worktrees) {
    const base = git(['rev-parse', 'HEAD'], wt);
    // NUL-separated and untrimmed: trimming the whole output ate the leading space of the first
    // entry, so its path lost a character and the file was silently taken for one main had deleted.
    // A rename or copy is followed by its source path, which carries no status prefix of its own.
    const entries = gitRaw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], wt).toString().split('\0').filter(Boolean);
    const changed = [];
    for (let i = 0; i < entries.length; i++) {
      changed.push(entries[i].slice(3));
      if (/^[RC]/.test(entries[i])) i++;
    }
    for (const rel of changed) {
      files++;
      const full = join(wt, rel);
      let verdict = 'pending';
      if (rel.startsWith('.claude/')) verdict = 'local';
      else if (!existsSync(full)) verdict = 'integrated (deleted in worktree; main decides)';
      else {
        const hash = git(['hash-object', full]);
        const inMain = mainBlob(rel);
        if (inMain === hash) verdict = 'integrated (same as main)';
        else {
          const history = git(['log', '--format=%H', `${base}..main`, '--', rel]).split('\n').filter(Boolean);
          const carried = history.find((c) => {
            try {
              return git(['rev-parse', `${c}:${rel}`]) === hash;
            } catch {
              return false;
            }
          });
          if (carried) verdict = `integrated (main carried it at ${carried.slice(0, 7)})`;
          else if (rel.startsWith('docs/screenshots/') && inMain && statSync(join(root, rel)).mtimeMs > statSync(full).mtimeMs) verdict = 'superseded (main re-captured it later)';
          else if (inMain) {
            const b = join(work, 'base');
            const o = join(work, 'ours');
            const t = join(work, 'theirs');
            let baseContent = '';
            try {
              baseContent = gitRaw(['show', `${base}:${rel}`], wt);
            } catch {}
            writeFileSync(b, baseContent);
            writeFileSync(o, gitRaw(['show', `main:${rel}`]));
            writeFileSync(t, readFileSync(full));
            const merged = spawnSync('git', ['merge-file', '--diff-algorithm=histogram', '-p', o, b, t], { encoding: 'utf8' });
            // The merge result goes to a file: `diff ours -` reads nothing from a spawnSync pipe and
            // reports "no differences", which counted every merge as adding nothing.
            const m = join(work, 'merged');
            writeFileSync(m, merged.stdout ?? '');
            const added = spawnSync('diff', [o, m], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /^[<>]/.test(l)).length;
            const own = addedLines(baseContent, full);
            if (merged.status === 0 && added === 0) verdict = 'integrated (3-way merge adds nothing)';
            else if (carriesAll(readFileSync(o, 'utf8'), own)) verdict = `integrated (main has all ${own.length} added lines)`;
            else if (merged.status > 0) {
              conflicts += merged.status;
              verdict = `pending (${merged.status} conflicts, ${added} lines)`;
            } else verdict = `pending (${added} lines to add)`;
          } else {
            // main removed the file. The work still counts as integrated when main took the added
            // lines before removing it (the Next.js server was replaced by the Go one in server/).
            const removedAt = git(['log', '--format=%H', '-1', '--diff-filter=D', '--', rel]);
            let baseContent = '';
            try {
              baseContent = gitRaw(['show', `${base}:${rel}`], wt);
            } catch {}
            const own = addedLines(baseContent, full);
            let last = '';
            if (removedAt) {
              try {
                last = gitRaw(['show', `${removedAt}^:${rel}`]).toString();
              } catch {}
            }
            if (last && carriesAll(last, own)) verdict = `integrated (main carried all ${own.length} added lines, then removed the file at ${removedAt.slice(0, 7)})`;
          }
        }
      }
      if (verdict.startsWith('pending')) pending++;
      lines.push(`${relative(root, wt)} ${rel}: ${verdict}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
for (const l of lines) console.log(l);
for (const [name, a] of ahead) console.log(`branch ${name} is ${a} commit(s) ahead of main`);
const ok = pending === 0 && conflicts === 0 && ahead.length === 0;
console.log(`${ok ? 'WORKTREES_INTEGRATED' : 'WORKTREES_PENDING'} worktrees=${worktrees.length} files=${files} pending=${pending} conflicts=${conflicts} ahead=${ahead.length}`);
process.exit(ok ? 0 : 1);
