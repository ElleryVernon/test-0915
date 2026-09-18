import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const corpus = process.env.UNIVERSITY_CORPUS_DIR || path.join(root, '.unlazy/university-learning/corpus');
const sha = value => createHash('sha256').update(value).digest('hex');
const keys = (value, expected, label) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label}: keys`);
const strings = (value, label, min = 0) => {
  assert(Array.isArray(value) && value.length >= min, `${label}: string array`);
  assert(value.every(v => typeof v === 'string' && v.trim().length > 0), `${label}: nonempty strings`);
  assert.equal(new Set(value).size, value.length, `${label}: unique values`);
};
const extracted = new Map();
function actualSource(binding) {
  const cacheKey = `${binding.pdfFile}:${binding.pageStart}:${binding.pageEnd}`;
  if (extracted.has(cacheKey)) return extracted.get(cacheKey);
  assert(!path.isAbsolute(binding.pdfFile) && !binding.pdfFile.split(/[\\/]/).includes('..'), 'source path must stay inside corpus');
  const pdf = path.join(corpus, binding.pdfFile);
  assert(existsSync(pdf), `source PDF missing: ${pdf}`);
  assert.equal(sha(readFileSync(pdf)), binding.pdfSha256, `${binding.id}: PDF hash changed`);
  const raw = execFileSync('pdftotext', ['-f', String(binding.pageStart), '-l', String(binding.pageEnd), pdf, '-'], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
  extracted.set(cacheKey, raw);
  return raw;
}

export function validateFixtures(data, manifest) {
  keys(data, ['version','cases'], 'fixture');
  keys(manifest, ['version','bindings'], 'manifest');
  assert.equal(data.version, 1); assert.equal(manifest.version, 1);
  assert.equal(data.cases.length, 8, 'eight independent cases');
  assert.equal(manifest.bindings.length, 8, 'eight source bindings');
  const ids = new Set(); const counts = new Map();
  const kinds = ['correct','partial','misconception','keyword-only','prompt-injection'];
  for (const c of data.cases) {
    keys(c, ['id','split','book','chapter','pdfFile','pageStart','pageEnd','source','topic','concepts','mustNot','grade'], c.id);
    assert(typeof c.id === 'string' && /^[a-z0-9-]+$/.test(c.id));
    assert(!ids.has(c.id), 'duplicate case'); ids.add(c.id);
    assert(['dev','holdout'].includes(c.split));
    assert(['Lehninger Principles of Biochemistry','McMurry Organic Chemistry 9th edition'].includes(c.book));
    for (const key of [c.split,c.book,`${c.book}:${c.split}`]) counts.set(key, (counts.get(key)||0)+1);
    assert(Number.isInteger(c.chapter) && c.chapter > 0);
    assert(Number.isInteger(c.pageStart) && c.pageStart > 0 && Number.isInteger(c.pageEnd) && c.pageEnd >= c.pageStart && c.pageEnd-c.pageStart < 3);
    assert(typeof c.topic === 'string' && c.topic.length >= 12);
    assert(typeof c.source === 'string' && c.source.length >= 1500 && c.source.length <= 6000);
    strings(c.concepts, `${c.id}: concepts`, 4); strings(c.mustNot, `${c.id}: mustNot`, 3);
    const g = c.grade;
    keys(g, ['prompt','keywords','modelAnswer','citation','answers'], `${c.id}: grade`);
    assert(typeof g.prompt === 'string' && g.prompt.length >= 90);
    assert(typeof g.modelAnswer === 'string' && g.modelAnswer.length >= 150);
    assert(typeof g.citation === 'string' && g.citation.length >= 400 && g.citation.length <= 4000 && c.source.includes(g.citation), 'citation must be actual source quote');
    strings(g.keywords, `${c.id}: keywords`, 4); assert.equal(g.keywords.length, 4);
    assert.deepEqual(g.answers.map(a=>a.id), kinds, `${c.id}: five required answer kinds`);
    for (const a of g.answers) {
      keys(a, ['id','answer','minScore','maxScore','expectedMissing','expectedMatched','mustMention'], `${c.id}/${a.id}`);
      assert(typeof a.answer === 'string' && a.answer.length > 8);
      assert(Number.isFinite(a.minScore) && Number.isFinite(a.maxScore) && a.minScore >= 0 && a.minScore <= a.maxScore && a.maxScore <= 100);
      for (const key of ['expectedMissing','expectedMatched','mustMention']) strings(a[key], `${c.id}/${a.id}/${key}`);
      for (const key of ['expectedMissing','expectedMatched']) assert(a[key].every(k=>g.keywords.includes(k)), 'expected membership must use exact rubric keyword');
      assert(!a.expectedMissing.some(k=>a.expectedMatched.includes(k)), 'contradictory membership expectation');
      if (a.id !== 'correct') assert(a.mustMention.length > 0, 'non-correct feedback must have acceptable correction aliases');
      if (a.id === 'correct') {
        assert.notEqual(a.answer, g.modelAnswer, 'correct response must be independent paraphrase');
        assert(a.minScore >= 85); assert.deepEqual(a.expectedMatched, g.keywords);
      }
      if (a.id === 'misconception') {
        assert(g.keywords.filter(k=>a.answer.includes(k)).length >= 3, 'adversarial misconception must contain rubric words');
        assert(a.maxScore <= 30);
      }
      if (a.id === 'keyword-only') { assert.equal(a.answer, g.keywords.join(', ')+'.'); assert(a.maxScore <= 30); }
      if (a.id === 'prompt-injection') { assert(a.maxScore <= 10); assert.deepEqual(a.expectedMissing, g.keywords); }
    }
    const matches = manifest.bindings.filter(b=>b.id===c.id);
    assert.equal(matches.length, 1, 'one source binding per case'); const b=matches[0];
    keys(b, ['id','pdfFile','pdfSha256','pageStart','pageEnd','extractor','sourceStart','sourceEnd','sourceSha256','caseSha256'], `${c.id}: source binding`);
    for (const key of ['pdfFile','pageStart','pageEnd']) assert.equal(b[key], c[key]);
    assert.equal(b.caseSha256, sha(JSON.stringify(c)), `${c.id}: frozen case content changed`);
    assert.equal(b.sourceSha256, sha(c.source), `${c.id}: source content changed`);
    assert.deepEqual(b.extractor, ['pdftotext','-f',String(c.pageStart),'-l',String(c.pageEnd),'PDF','-']);
    assert(Number.isInteger(b.sourceStart) && Number.isInteger(b.sourceEnd) && b.sourceStart >= 0 && b.sourceEnd > b.sourceStart);
    assert.equal(actualSource(b).slice(b.sourceStart,b.sourceEnd),c.source, `${c.id}: source must be exact contiguous extraction from cited pages`);
  }
  for (const split of ['dev','holdout']) assert.equal(counts.get(split),4);
  for (const book of ['Lehninger Principles of Biochemistry','McMurry Organic Chemistry 9th edition']) {
    assert.equal(counts.get(book),4); for (const split of ['dev','holdout']) assert.equal(counts.get(`${book}:${split}`),2);
  }
  return {cases: data.cases.length, answers: data.cases.reduce((n,c)=>n+c.grade.answers.length,0), pdfPages: data.cases.reduce((n,c)=>n+c.pageEnd-c.pageStart+1,0)};
}

const data=JSON.parse(readFileSync(path.join(dir,'cases.json'),'utf8'));
const manifest=JSON.parse(readFileSync(path.join(dir,'sources.json'),'utf8'));
const result=validateFixtures(data,manifest);
if (process.argv.includes('--self-test')) {
  const mutated=structuredClone(data); mutated.cases[0].source += '\nInvented quote.';
  assert.throws(()=>validateFixtures(mutated,manifest), /frozen case content changed/);
  const rehashedData=structuredClone(data), rehashedManifest=structuredClone(manifest);
  rehashedData.cases[0].source=rehashedData.cases[0].source.replace('competitive','invented___');
  rehashedData.cases[0].grade.citation=rehashedData.cases[0].source;
  rehashedManifest.bindings[0].sourceSha256=sha(rehashedData.cases[0].source);
  rehashedManifest.bindings[0].caseSha256=sha(JSON.stringify(rehashedData.cases[0]));
  assert.throws(()=>validateFixtures(rehashedData,rehashedManifest), /exact contiguous extraction/);
  const malformed=structuredClone(data); malformed.cases[0].grade.answers[0].expectedMatched=['invented keyword'];
  assert.throws(()=>validateFixtures(malformed,manifest), /exact rubric keyword/);
  console.log('UNIVERSITY_GOLD_NEGATIVE_CONTROLS_OK tampered_fixture rehashed_fake_quote invalid_keyword');
}
console.log(`UNIVERSITY_GOLD_OK ${JSON.stringify(result)}`);
