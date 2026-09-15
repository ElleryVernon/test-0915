// S1 oracle: the mapping document covers all 10 diagnoses and 14 IA rows, links the capture gallery, and the
// study sources render no example figure from the review as a constant and no card source line.
import { existsSync, readFileSync } from 'node:fs';

const DOC = 'docs/STUDY_REVIEW.md';
const SOURCES = [
  'src/components/study/subjects.tsx',
  'src/components/study/cards.tsx',
  'src/components/study/insights.ts',
  'src/components/study/study-header.tsx',
];
// Figures that appear in the review's mock screens; the app must compute them, never spell them out.
const EXAMPLES = ['10장', '14장', 'D-12', '13일', '4분 12초', '약 5분'];
const problems = [];

const doc = readFileSync(DOC, 'utf8');
const section = (title) => {
  const start = doc.indexOf(`\n## ${title}`);
  if (start < 0) return '';
  const end = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, end < 0 ? undefined : end);
};
const rows = (text) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .slice(1); // header row
const diagnoses = rows(section('진단 10건')).map((row) => /^\|\s*(\d+)\./.exec(row)?.[1]);
if (diagnoses.join(',') !== '1,2,3,4,5,6,7,8,9,10') problems.push(`diagnosis rows: ${diagnoses.join(',')}`);
const ia = rows(section('정보 구조 14행'));
if (ia.length !== 14) problems.push(`IA rows: ${ia.length}`);
if (ia.some((row) => row.split('|').length < 5 || !row.split('|')[3].trim())) problems.push('IA row without an outcome');
const gallery = /\]\((screenshots\/study-review\/index\.html)\)/.exec(doc)?.[1];
if (!gallery || !existsSync(`docs/${gallery}`)) problems.push('capture gallery link missing');

const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const examples = (text) => EXAMPLES.filter((figure) => code(text).includes(figure));
for (const file of SOURCES) {
  const text = readFileSync(file, 'utf8');
  for (const figure of examples(text)) problems.push(`${file}: example figure "${figure}"`);
  if (/출처/.test(code(text))) problems.push(`${file}: card source line`);
}
// Positive control: the detector must see figures written the way a copied mock would write them.
const control = examples("<small>{'오늘 복습 10장 · 약 5분'}</small> /* 13일 */");
if (control.join(',') !== '10장,약 5분') problems.push(`detector control: ${control.join(',')}`);

console.log(`diagnoses ${diagnoses.length} · IA rows ${ia.length} · gallery ${gallery ?? '-'} · detector control ${control.join(',')}`);
if (problems.length) {
  for (const problem of problems) console.log(`  ${problem}`);
  process.exit(1);
}
console.log('STUDY_REVIEW_DOCS_OK');
