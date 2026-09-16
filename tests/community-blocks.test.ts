import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { recordedSolveSelection, BlockView, BlockDraftList, allowedBlockTypes, blockSummary, excerptSentences, excerptSelection, safeScheduleRows, photoFileError } from '../src/components/social/community-blocks';
import type { AppData, Schedule } from '../src/lib/contracts';
import type { CommunityBlock } from '../src/lib/community-types';

const data = {
  profile: { id: 'me', role: 'STUDENT' }, materials: [], subjects: [], cards: [], questions: [], essays: [], attempts: [], schedules: [],
} as unknown as AppData;
const block = (type: CommunityBlock['type'], payload: CommunityBlock['payload'], extras: Partial<CommunityBlock> = {}): CommunityBlock => ({ id: 'b1', type, payload, hidden: true, ...extras });
const render = (value: CommunityBlock, extras = {}) => renderToStaticMarkup(createElement(BlockView, { block: value, postId: 'post1', data, navigate: () => {}, toast: () => {}, ...extras }));

test('parents cannot attach student data and comments expose only the four allowed types', () => {
  assert.deepEqual(allowedBlockTypes('PARENT'), ['PHOTO', 'POLL']);
  assert.deepEqual(allowedBlockTypes('PARENT', true), ['PHOTO']);
  assert.deepEqual(allowedBlockTypes('STUDENT', true), ['QUESTION', 'CARD', 'PHOTO', 'MATH']);
  assert.equal(allowedBlockTypes('STUDENT').length, 8);
});
test('hidden question renders no answer/explanation before explicit reveal', () => {
  const html = render(block('QUESTION', { prompt: '혈당을 낮추는 호르몬은?', options: ['인슐린', '글루카곤'], answer: 0, explanation: '답은 SECRET_INSULIN', citation: 'PRIVATE_CITATION', selected: 1 }));
  assert.match(html, /나도 풀어보기/); assert.match(html, /정답 보기/);
  assert.match(html, /작성자 답 2번/); assert.doesNotMatch(html, /SECRET_INSULIN|PRIVATE_CITATION/);
  assert.doesNotMatch(html, /47명|61%/);
});
test('draft preview cannot mutate stats or copy content into learning', () => {
  const html = render(block('QUESTION', { prompt: '문제', options: ['하나', '둘'], answer: 0 }), { preview: true });
  assert.doesNotMatch(html, /나도 풀어보기|내 오답노트에 담기/);
  const card = render(block('CARD', { front: '앞면', back: 'BACK_SECRET' }), { preview: true });
  assert.match(card, /뒷면 보기/); assert.doesNotMatch(card, /BACK_SECRET|내 카드에 담기/);
});
test('revealed question renders canonical explanation and real aggregate numbers', () => {
  const html = render(block('QUESTION', { prompt: '문제', options: ['인슐린', '글루카곤'], answer: 0, explanation: '혈당을 낮춰요' }, { hidden: false, stats: { attempts: 4, correct: 3 } }));
  assert.match(html, /혈당을 낮춰요/); assert.match(html, /4명 참여 · 정답률 75%/);
  assert.match(html, /정답 접기/);
});
test('source material link is available only when the authenticated bootstrap owns it', () => {
  const materialBlock = block('MATERIAL', { title: '공개 발췌', text: '선택한 문장' }, { refId: 'material-secret' });
  assert.doesNotMatch(render(materialBlock), /내 원본 자료 보기/);
  const owner = { ...data, materials: [{ id: 'material-secret', subjectId: 'bio' }] } as AppData;
  assert.match(render(materialBlock, { data: owner }), /내 원본 자료 보기/);
  assert.doesNotMatch(render({ ...materialBlock, sourceDeleted: true }, { data: owner }), /내 원본 자료 보기/);
});
test('material excerpt keeps exact source whitespace and only contiguous three-sentence ranges', () => {
  const source = '첫 문장입니다.\n\n두 번째 문장이에요. 세 번째예요.\n네 번째예요.';
  assert.equal(excerptSentences(source).length, 4);
  assert.equal(excerptSelection(source, [0, 1]), '첫 문장입니다.\n\n두 번째 문장이에요.');
  assert.equal(excerptSelection(source, [0, 2]), '');
  assert.equal(excerptSelection(source, [0, 1, 2, 3]), '');
  assert.equal(excerptSelection(source, [3, 9]), '');
  assert.equal(excerptSelection('가'.repeat(2001) + '.', [0]), '');
});
test('fixed schedule names and identifiers never leave the picker snapshot', () => {
  const source: Schedule[] = [
    { id: 'school-secret', title: '사적인 병원 방문', date: '2026-09-16', start: '08:00', end: '09:00', kind: 'FIXED', done: false },
    { id: 'study', title: '한국사 복습', date: '2026-09-16', start: '10:00', end: '10:25', kind: 'FLEXIBLE', done: false },
  ];
  const rows = safeScheduleRows(source);
  assert.equal(rows[0].title, '학교'); assert.equal(rows[1].title, '한국사 복습');
  assert.equal('id' in rows[0], false);
  const html = render(block('SCHEDULE', { rows }));
  assert.doesNotMatch(html, /사적인 병원 방문|school-secret/);
  assert.match(html, /자율 일정 1개만/); assert.match(html, /겹치는 시간은 제외/);
});
test('poll results stay hidden until voting or close; rendered counts are actual stats', () => {
  const payload = { question: '어떤 과목?', options: ['국어', '수학'], closesAt: '2099-01-01T00:00:00Z' };
  const before = render(block('POLL', payload, { stats: { attempts: 0, correct: 0, votes: [10, 20] } }));
  assert.match(before, /투표 후 결과 공개/); assert.doesNotMatch(before, /10표|20표/);
  const voted = render(block('POLL', payload, { stats: { attempts: 0, correct: 0, votes: [10, 20], voted: 1 } }));
  assert.match(voted, /10표/); assert.match(voted, /20표/); assert.match(voted, /30명 참여/);
  const expired = render(block('POLL', { ...payload, closesAt: '2020-01-01T00:00:00Z' }));
  assert.match(expired, /투표 마감/); assert.doesNotMatch(expired, />투표하기</);
});
test('photo rejects oversized and active-content formats before decoding', () => {
  assert.match(photoFileError({ type: 'image/jpeg', size: 10 * 1024 * 1024 + 1 }), /10MB/);
  assert.match(photoFileError({ type: 'image/svg+xml', size: 1234 }), /JPG/);
  assert.equal(photoFileError({ type: 'image/png', size: 2048 }), '');
  assert.match(render(block('PHOTO', { image: 'https://private.example/photo' })), /사진을 표시할 수 없어요/);
  assert.doesNotMatch(render(block('PHOTO', { image: 'data:image/svg+xml;base64,xxx' })), /src="data:image\/svg/);
});
test('math is safely rendered verbatim, not evaluated or presented as parsed LaTeX', () => {
  const html = render(block('MATH', { text: '√(x) + x² <script>alert(1)</script>' }));
  assert.match(html, /√\(x\) \+ x²/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
});
test('essay feedback has an explicit action when a comment target is available', () => {
  const value = block('ESSAY', { prompt: '설명하세요', answer: '작성자의 실제 답안', score: 75 });
  assert.match(render(value, { onFeedback: () => {} }), /이 답안에 피드백 남기기/);
  assert.match(render(value), /75점/);
});
test('drafts expose ordered labels, named removal and hidden-answer choices', () => {
  const blocks = [block('CARD', { front: '앞', back: '비공개 뒷면' }), block('MATH', { text: 'x²' }, { id: 'b2' })];
  const html = renderToStaticMarkup(createElement(BlockDraftList, { blocks, onChange: () => {}, data }));
  assert.match(html, /첨부 1 삭제/); assert.match(html, /첨부 2 위로 이동/); assert.match(html, /정답을 가려서 올리기/);
  assert.equal(blockSummary(blocks), '복습 카드 1 · 수식 1');
});

test('repeated solves show the persisted first choice, not a conflicting new selection', () => {
  assert.deepEqual(recordedSolveSelection({ selected: 1 }, 0), { selected: 1, previous: true });
  assert.deepEqual(recordedSolveSelection({ selected: 0 }, 0), { selected: 0, previous: false });
  assert.deepEqual(recordedSolveSelection({}, 1), { selected: 1, previous: false });
});
