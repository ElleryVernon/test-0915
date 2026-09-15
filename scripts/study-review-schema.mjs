// The study review may only add Subject.examName / Subject.examDate (nullable), and the local
// database must already match the schema. `prisma migrate diff` is read-only.
import { execFileSync, spawnSync } from 'node:child_process';

const BASE = '0f14f1e';
const diff = execFileSync('git', ['diff', '--unified=0', BASE, '--', 'prisma/schema.prisma'], {
  encoding: 'utf8',
});
const changed = diff
  .split('\n')
  .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
  .map((l) => l.replace(/\s+/g, ' ').trim());
const expected = ['+ examName String?', '+ examDate String?'].map((l) => l.replace('+ ', '+'));
const normalized = changed.map((l) => l.replace(/^([+-]) /, '$1'));
const onlyExpected =
  normalized.length === expected.length && expected.every((line) => normalized.includes(line));
const hunkInSubject = /model Subject/.test(
  execFileSync('git', ['diff', BASE, '--', 'prisma/schema.prisma'], { encoding: 'utf8' }),
);
const sync = spawnSync(
  'npx',
  ['prisma', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'],
  { encoding: 'utf8' },
);
console.log(`schema changes vs ${BASE}: ${normalized.join(' | ') || '(none)'}`);
console.log(`inside model Subject: ${hunkInSubject}`);
console.log(`migrate diff exit=${sync.status} (0 means the database matches the schema)`);
if (!onlyExpected || !hunkInSubject || sync.status !== 0) process.exit(1);
console.log('STUDY_REVIEW_SCHEMA_SYNCED');
