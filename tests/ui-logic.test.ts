import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampStep,
  dateLabel,
  daysInMonth,
  monthGrid,
  objectParticle,
  roundToStep,
  shiftMonth,
  sliderKey,
  sliderPercent,
  timeOptions,
  validationMessage,
  weekdayOf,
} from '../src/lib/ui-logic';

test('month grid: 42 cells starting on the Sunday before the 1st, with today, selection and range', () => {
  // September 2026 starts on a Tuesday (weekday 2).
  assert.equal(weekdayOf('2026-09-01'), 2);
  const grid = monthGrid(2026, 9, { today: '2026-09-15', selected: '2026-09-20', min: '2026-09-03', max: '2026-10-05' });
  assert.equal(grid.length, 42);
  assert.deepEqual(grid.slice(0, 3).map((c) => [c.date, c.inMonth]), [['2026-08-30', false], ['2026-08-31', false], ['2026-09-01', true]]);
  assert.equal(grid.filter((c) => c.inMonth).length, 30);
  assert.equal(grid.find((c) => c.today)?.date, '2026-09-15');
  assert.equal(grid.find((c) => c.selected)?.date, '2026-09-20');
  assert.deepEqual(grid.filter((c) => c.disabled).map((c) => c.date).slice(0, 4), ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
  assert.equal(grid.at(-1)?.date, '2026-10-10');
  assert.equal(grid.at(-1)?.disabled, true);
  assert.equal(grid[0].weekday, 0);
  // February 2026 starts on a Sunday: no leading filler.
  assert.equal(monthGrid(2026, 2)[0].date, '2026-02-01');
  assert.equal(daysInMonth(2028, 2), 29);
});

test('month arithmetic wraps years', () => {
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(shiftMonth(2026, 6, 18), { year: 2027, month: 12 });
});

test('date labels', () => {
  assert.equal(dateLabel('2026-09-15'), '9월 15일 (화)');
  assert.equal(dateLabel(''), '');
  assert.equal(dateLabel('nope'), '');
});

test('time options in five-minute steps and rounding that never wraps the day', () => {
  const all = timeOptions();
  assert.equal(all.length, 288);
  assert.equal(all[0], '00:00');
  assert.equal(all[1], '00:05');
  assert.equal(all.at(-1), '23:55');
  assert.deepEqual(timeOptions(30, '09:00', '10:00'), ['09:00', '09:30', '10:00']);
  assert.equal(roundToStep('09:07'), '09:05');
  assert.equal(roundToStep('09:08'), '09:10');
  assert.equal(roundToStep('23:58'), '23:55');
  assert.equal(roundToStep('09:15', 30), '09:30');
  assert.equal(roundToStep('x'), '');
});

test('stepper snaps to the step grid and clamps to the range', () => {
  assert.equal(clampStep(7, { min: 0, max: 100, step: 5 }), 5);
  assert.equal(clampStep(8, { min: 0, max: 100, step: 5 }), 10);
  assert.equal(clampStep(120, { min: 0, max: 100, step: 5 }), 100);
  assert.equal(clampStep(-3, { min: 0, max: 100 }), 0);
  assert.equal(clampStep(Number.NaN, { min: 10, max: 20 }), 10);
  assert.equal(clampStep(0.87, { min: 0.8, max: 0.97, step: 0.01 }).toFixed(2), '0.87');
});

test('slider keys follow the ARIA pattern', () => {
  const range = { min: 80, max: 97, step: 1 };
  assert.equal(sliderKey(90, 'ArrowRight', range), 91);
  assert.equal(sliderKey(90, 'ArrowUp', range), 91);
  assert.equal(sliderKey(90, 'ArrowLeft', range), 89);
  assert.equal(sliderKey(90, 'ArrowDown', range), 89);
  assert.equal(sliderKey(90, 'PageUp', range), 97);
  assert.equal(sliderKey(90, 'PageDown', range), 80);
  assert.equal(sliderKey(90, 'Home', range), 80);
  assert.equal(sliderKey(90, 'End', range), 97);
  assert.equal(sliderKey(97, 'ArrowRight', range), 97);
  assert.equal(sliderKey(90, 'a', range), 90);
  assert.equal(sliderPercent(90, 80, 97).toFixed(1), '58.8');
  assert.equal(sliderPercent(5, 10, 10), 0);
});

test('inline validation messages replace the browser bubble', () => {
  assert.equal(validationMessage('', { label: '제목', required: true }), '제목을 입력해 주세요.');
  assert.equal(validationMessage('  ', { label: '학교', required: true }), '학교를 입력해 주세요.');
  assert.equal(validationMessage('ab', { label: '닉네임', minLength: 3 }), '닉네임을 3자 이상 입력해 주세요.');
  assert.equal(validationMessage('a'.repeat(21), { label: '시험 이름', maxLength: 20 }), '시험 이름을 20자 이내로 줄여 주세요.');
  assert.equal(validationMessage('abc', { label: '코드', pattern: /^\d{6}$/, patternMessage: '숫자 6자리예요.' }), '숫자 6자리예요.');
  assert.equal(validationMessage('123456', { label: '코드', pattern: /^\d{6}$/ }), '');
  assert.equal(validationMessage('', { label: '메모', minLength: 3 }), '');
  assert.equal(objectParticle('제목'), '을');
  assert.equal(objectParticle('학교'), '를');
});

console.log('UI_LOGIC_VERIFIED');
