import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_STAGES,
  formatElapsed,
  generationCopy,
  PLANNER_COPY,
  progressCopy,
} from '../src/lib/ai-progress';
import { sessionHint } from '../src/lib/session-hint';

test('progress copy follows the recorded stage and the elapsed time', () => {
  const copy = generationCopy('복습 카드');
  assert.deepEqual(AI_STAGES, ['LOAD_CONTEXT', 'GENERATE', 'VALIDATE', 'COMMIT']);
  const accepted = progressCopy(copy, undefined, 1500);
  assert.equal(accepted.stage, '자료 본문을 읽는 중');
  assert.equal(accepted.step, 0);
  assert.equal(accepted.elapsed, '1초');
  assert.equal(accepted.hint, '자료 분량과 검토 과정에 따라 시간이 달라요.');
  const generating = progressCopy(
    copy,
    [
      { stage: 'LOAD_CONTEXT', status: 'COMPLETED', startedAt: 'x' },
      { stage: 'GENERATE', status: 'RUNNING', startedAt: 'x' },
    ],
    45_000,
  );
  assert.equal(generating.stage, '복습 카드를 만드는 중');
  assert.equal(generating.step, 1);
  assert.equal(generating.elapsed, '45초');
  assert.match(generating.hint, /1분을 넘길 수 있어요/);
  const validating = progressCopy(
    copy,
    [{ stage: 'VALIDATE', status: 'RUNNING', startedAt: 'x' }],
    65_000,
  );
  assert.equal(validating.stage, '원문 근거와 형식을 확인하는 중');
  assert.equal(validating.elapsed, '1분 05초');
  assert.match(validating.hint, /요청 번호로 보관/);
  const late = progressCopy(
    copy,
    [{ stage: 'COMMIT', status: 'RUNNING', startedAt: 'x' }],
    130_000,
  );
  assert.equal(late.stage, '저장하는 중');
  assert.equal(late.step, 3);
  assert.match(late.hint, /190초가 지나면/);
  // An unknown stage name never breaks the display.
  assert.equal(
    progressCopy(PLANNER_COPY, [{ stage: 'WEIRD', status: 'RUNNING', startedAt: 'x' }], 0).stage,
    PLANNER_COPY.LOAD_CONTEXT,
  );
  assert.equal(formatElapsed(-5), '0초');
  assert.equal(formatElapsed(3_600_000), '60분 00초');
});

test('the signed-in hint is decided by the cookie string alone', () => {
  assert.equal(sessionHint(''), false);
  assert.equal(sessionHint('memoryz_signed_in=1'), true);
  assert.equal(sessionHint('theme=dark; memoryz_signed_in=1; other=x'), true);
  assert.equal(sessionHint('memoryz_signed_in=0'), false);
  assert.equal(sessionHint('memoryz_signed_in='), false);
  assert.equal(sessionHint('xmemoryz_signed_in=1'), false);
  assert.equal(sessionHint('memoryz_session=abc'), false);
  console.log('AI_PROGRESS_OK');
});
