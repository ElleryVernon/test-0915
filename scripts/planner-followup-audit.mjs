// Planner follow-up audit. Three modes, each with a positive control against the pre-change sources:
//   (default)   no lock icon on fixed schedules in the planner sources
//   --evidence  the browser capture recorded no lock and two equal, icon-free segment options
//   --docs      docs/SCHEDULE_REVIEW.md records the suggestion exposure rules and the icon decision
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const BASE = 'adb72eb';
const PLANNER = [
  'src/components/social/planner.tsx',
  'src/components/social/planner-editor.tsx',
  'src/components/social/planner-pickers.tsx',
];
const read = (file, rev) =>
  rev
    ? execFileSync('git', ['show', `${rev}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    : readFileSync(file, 'utf8');
const mode = process.argv[2] ?? '';
const problems = [];

if (mode === '') {
  const locks = (rev) => PLANNER.flatMap((file) => [...read(file, rev).matchAll(/<LockKeyhole\b/g)].map(() => file));
  const current = locks();
  const control = locks(BASE);
  console.log(`lock icons now: ${current.length} · in ${BASE}: ${control.length} (${[...new Set(control)].join(', ')})`);
  if (current.length) problems.push(`lock icons remain in ${current.join(', ')}`);
  if (control.length !== 2) problems.push('positive control did not find the two lock icons');
  if (!problems.length) console.log('PLANNER_FOLLOWUP_AUDIT_OK');
} else if (mode === '--evidence') {
  const shots = 'docs/screenshots/schedule-review';
  const json = (name) => JSON.parse(readFileSync(`${shots}/followup-${name}-390.json`, 'utf8'));
  for (const name of ['timetable', 'add-sheet'])
    if (!existsSync(`${shots}/followup-${name}-390.png`)) problems.push(`missing followup-${name}-390.png`);
  const timetable = json('timetable');
  const { segment } = json('add-sheet');
  if (timetable.lockIcons !== 0) problems.push(`lock icons on timetable cards: ${timetable.lockIcons}`);
  if (!(timetable.fixedCards > 0)) problems.push('the timetable capture shows no fixed card to judge');
  if (segment.lockIcons !== 0) problems.push(`lock icons in the add sheet: ${segment.lockIcons}`);
  if (JSON.stringify(segment.labels) !== JSON.stringify(['자율 학습', '고정 일정'])) problems.push(`segment labels ${segment.labels}`);
  if (segment.icons.some((n) => n !== 0)) problems.push(`segment icons ${segment.icons}`);
  if (new Set(segment.heights).size !== 1 || new Set(segment.fontSizes).size !== 1)
    problems.push(`segments differ: ${segment.heights} / ${segment.fontSizes}`);
  console.log(`timetable locks ${timetable.lockIcons} (fixed cards ${timetable.fixedCards}) · segment ${JSON.stringify(segment)}`);
  if (!problems.length) console.log('PLANNER_FOLLOWUP_ICON_EVIDENCE_OK');
} else if (mode === '--docs') {
  const covered = (doc) => {
    const at = doc.indexOf('## 추천 시트 노출 규칙');
    if (at < 0) return ['section'];
    const section = doc.slice(at, doc.indexOf('\n## ', at + 1) === -1 ? undefined : doc.indexOf('\n## ', at + 1));
    return [
      ...['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'].filter((rule) => !new RegExp(`\\b${rule}\\b`).test(section)),
      ...['자물쇠', '추천 다시 보기', 'followup-'].filter((word) => !section.includes(word)),
    ];
  };
  const missing = covered(read('docs/SCHEDULE_REVIEW.md'));
  const control = covered(read('docs/SCHEDULE_REVIEW.md', BASE));
  console.log(`missing now: ${missing.join(', ') || '-'} · control (${BASE}) missing: ${control.join(', ')}`);
  if (missing.length) problems.push(`document lacks ${missing.join(', ')}`);
  if (!control.length) problems.push('positive control: the old document already passes, so the check proves nothing');
  if (!problems.length) console.log('PLANNER_FOLLOWUP_DOCS_OK');
} else {
  problems.push(`unknown mode ${mode}`);
}
if (problems.length) {
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
