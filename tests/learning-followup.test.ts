import test from 'node:test';
import assert from 'node:assert/strict';
import { conceptConnections } from '../src/lib/learning-followup';
import { askOptions } from '../src/lib/community-nudges';
import type { AppData, Question } from '../src/lib/contracts';

const data = {subjects:[{id:'s',name:'생명과학Ⅰ'}],profile:{completedSubjects:['생명과학 1']}} as unknown as AppData;
test('four study recovery paths stay predictable, missing material explains unavailable creation', () => {
  for (const kind of ['EXPLAIN','WRONGNOTE'] as const) {
    const available = askOptions({kind,hasMaterial:true});
    const missing = askOptions({kind,hasMaterial:false});
    assert.deepEqual(available.map((v)=>v.id),['card','essay','similar','ask']);
    assert.deepEqual(missing.map((v)=>v.id),available.map((v)=>v.id));
    assert.match(missing.find((v)=>v.id==='essay')!.sub,/원본 자료/);
  }
});
test('course normalization connects actual folder and learned history without inferring unknown mastery', () => {
  const q = {past:'생명과학Ⅰ · 항상성',future:'대학 생화학 · 효소 반응'} as Question;
  const links=conceptConnections(q,data);
  assert.equal(links[0].learned,true);assert.equal(links[0].subjectId,'s');
  assert.equal(links[1].learned,false);assert.equal(links[1].subjectId,undefined);
});
test('empty links remain absent and unspaced middle dots remain part of subject name', () => {
  assert.deepEqual(conceptConnections({past:'',future:'없음'} as Question,data),[]);
  const links=conceptConnections({past:'사회·문화 · 사회화',future:''} as Question,data);
  assert.equal(links[0].course,'사회·문화');assert.equal(links[0].concept,'사회화');
});
