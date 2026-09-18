import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TIME_WINDOWS,
  WeeklyResult,
  WeeklySetup,
  daysLabel,
  needSummary,
  weeklySuggestions,
  type WeeklySetupProps,
} from '../src/components/social/planner-workspace';
import type { Card, Subject } from '../src/lib/contracts';
import type { WeeklyInput, WeeklyNeed, WeeklyPlan } from '../src/lib/planner-workspace';

const subject = (id: string, name: string): Subject => ({
  id,
  name,
  icon: 'science',
  semester: '2026 2학기',
  color: 'gray',
  materialCount: 1,
  questionCount: 1,
  cardCount: 1,
});
const dueCard = (id: string, subjectId: string): Card => ({
  id,
  subjectId,
  front: `질문 ${id}`,
  back: `정답 ${id}`,
  type: 'CONCEPT',
  bucket: 'GOOD',
  consecutiveEasy: 0,
  nextReviewAt: new Date(Date.now() - 1000).toISOString(),
  deleted: false,
});
const data = {
  subjects: [subject('bio', '생명과학I'), subject('eng', '영어')],
  cards: [dueCard('c1', 'bio'), dueCard('c2', 'bio'), dueCard('c3', 'bio')],
};
const need = (patch: Partial<WeeklyNeed> = {}): WeeklyNeed => ({
  id: 'n1',
  title: '',
  minutes: 120,
  sessionMinutes: 60,
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  ...patch,
});
const input = (patch: Partial<WeeklyInput> = {}): WeeklyInput => ({
  from: '2026-09-21',
  start: '16:00',
  end: '22:00',
  needs: [need()],
  groups: [],
  ...patch,
});
const noop = () => {};
const setup = (patch: Partial<WeeklySetupProps> = {}) =>
  renderToStaticMarkup(
    createElement(WeeklySetup, {
      data,
      input: input(),
      today: '2026-09-18',
      invalid: '할 일 이름을 100자 이내로 적어 주세요.',
      error: '',
      busy: false,
      open: null,
      onOpen: noop,
      customWindow: false,
      onCustomWindow: noop,
      onChange: noop,
      onPropose: noop,
      ...patch,
    }),
  );
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the setup half uses app-drawn controls only, offers time-window presets and keeps the summary beside the action', () => {
  const html = setup();
  assert.ok(!html.includes('<select'), 'no native select');
  assert.ok(!html.includes('type="time"'), 'no native time input');
  assert.ok(!html.includes('type="date"'), 'no native date input');
  for (const w of TIME_WINDOWS) assert.ok(html.includes(w.label), `preset ${w.label}`);
  assert.ok(html.includes('aria-pressed="true"'), 'the matching preset is pressed');
  const t = text(html);
  assert.ok(t.includes('9월 21일 월부터 7일'), 'period is spelled out');
  assert.ok(t.includes('할 일 1개'), 'live count in the footer');
  assert.ok(t.includes('주 2시간'), 'live total in the footer');
  assert.ok(t.includes('배치안 보기'));
  assert.ok(t.includes('할 일 이름을 100자 이내로 적어 주세요.'), 'validation reads inline');
  assert.ok(
    /disabled=""[^>]*>배치안 보기|<button[^>]*disabled[^>]*>[^<]*배치안 보기/.test(html),
    'primary action waits for valid input',
  );
});

test('an untitled task row names what is missing and a titled row summarizes its budget', () => {
  const t = text(setup());
  assert.ok(t.includes('할 일 1 · 이름을 적어 주세요'));
  assert.ok(t.includes('1시간 × 주 2번 · 매일'));
  const titled = text(
    setup({
      input: input({
        needs: [need({ title: '생명과학 복습', minutes: 180, weekdays: [0, 2, 4] })],
      }),
      invalid: '',
    }),
  );
  assert.ok(titled.includes('생명과학 복습'));
  assert.ok(titled.includes('1시간 × 주 3번 · 월·수·금'));
  assert.equal(
    needSummary(need({ minutes: 90, sessionMinutes: 90, weekdays: [5, 6] })),
    '1시간 30분 × 주 1번 · 주말',
  );
  assert.equal(daysLabel([0, 1, 2, 3, 4]), '평일');
});

test('the open editor budgets with session chips and a count stepper, quick day picks and a subject field', () => {
  const html = setup({
    open: 'n1',
    input: input({ needs: [need({ title: '운동' })] }),
    invalid: '',
  });
  const t = text(html);
  assert.ok(html.includes('choice-stepper'), 'app-drawn stepper for the weekly count');
  assert.ok(t.includes('= 2시간'), 'the total is computed from session × count');
  for (const chip of ['30분', '1시간', '1시간 30분', '2시간']) assert.ok(t.includes(chip), chip);
  for (const quick of ['매일', '평일', '주말']) assert.ok(t.includes(quick), quick);
  assert.ok(t.includes('과목 연결') && t.includes('과목 없이'));
  assert.ok(html.includes('role="switch"'), 'differentDays is a switch');
  assert.ok(t.includes('삭제') && t.includes('완료'));
});

test('quick-add suggestions follow the cards due now and skip tasks already listed', () => {
  const suggested = weeklySuggestions(data, []);
  assert.deepEqual(
    suggested.map((s) => s.title),
    ['생명과학I 복습', '운동'],
  );
  assert.equal(suggested[0].count, 1);
  assert.equal(suggested[0].subjectId, 'bio');
  assert.deepEqual(
    weeklySuggestions(data, [need({ title: '생명과학I 복습' })]).map((s) => s.title),
    ['운동'],
  );
  const t = text(setup());
  assert.ok(t.includes('생명과학I 복습') && t.includes('지금 복습 3장'));
});

test('candidate groups stay optional and collapsed until added', () => {
  const t = text(setup());
  assert.ok(t.includes('후보 비교') && t.includes('묶음 추가'));
  const withGroup = text(
    setup({
      input: input({
        groups: [
          {
            id: 'g1',
            title: '과학 학원',
            options: [
              { id: 'o1', title: '월수금반', weekdays: [0, 2, 4], start: '18:00', end: '20:00' },
              { id: 'o2', title: '화목반', weekdays: [1, 3], start: '18:00', end: '20:00' },
            ],
          },
        ],
      }),
      invalid: '',
    }),
  );
  assert.ok(withGroup.includes('월수금반') && withGroup.includes('월·수·금 · 18:00–20:00'));
  assert.ok(withGroup.includes('후보 1묶음'), 'the footer counts groups');
});

test('the result half shows a three-number summary, a seven-day overview and accept/adjust actions', () => {
  const plan: WeeklyPlan = {
    id: 'p1',
    title: '고르게',
    blocks: [
      {
        title: '생명과학 복습',
        date: '2026-09-21',
        start: '16:00',
        end: '17:00',
        kind: 'FLEXIBLE',
      },
      { title: '과학 학원', date: '2026-09-23', start: '18:00', end: '20:00', kind: 'FIXED' },
    ],
    choices: ['과학 학원: 월수금반'],
    unmet: [{ title: '운동', minutes: 60 }],
    allocated: 60,
  };
  const html = renderToStaticMarkup(
    createElement(WeeklyResult, {
      input: input(),
      result: {
        plans: [plan, { ...plan, id: 'p2', title: '앞쪽', unmet: [], allocated: 120 }],
        rejected: 1,
        error: '',
      },
      selected: 0,
      onSelect: noop,
      busy: false,
      error: '',
      pending: false,
      receipt: false,
      onApply: noop,
      onBack: noop,
    }),
  );
  const t = text(html);
  assert.ok(
    t.includes('1안') && t.includes('2안') && t.includes('1시간 부족') && t.includes('모두 배치'),
  );
  assert.ok(t.includes('배치한 시간') && t.includes('추가할 일정') && t.includes('부족한 시간'));
  assert.equal((html.match(/aria-label="주간 미리보기"/g) ?? []).length, 1);
  assert.equal((html.match(/data-kind="/g) ?? []).length, 2, 'two blocks placed');
  assert.ok(t.includes('비어 있어요'), 'empty days are explicit');
  assert.ok(t.includes('후보 선택 · 과학 학원: 월수금반'));
  assert.ok(t.includes('배치된 2개만 등록하기') && t.includes('조건 바꾸기'));
  assert.ok(t.includes('1개 조합은 뺐어요'));
});
