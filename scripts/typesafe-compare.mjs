#!/usr/bin/env node
// Builds the LLM-vs-Jev comparison table from learning-eval grade reports and the Jev evaluation
// report. Usage:
//   node scripts/typesafe-compare.mjs --off=<dir> --on=<dir> [--jev=.unlazy/feedback-3-typesafe/report.json]
// Each learning-eval dir holds report.json with results[] (caseId, task, failures, usage[], retries[],
// productDurationMs). Prints Markdown; nothing is written.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const flags = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const load = (dir) => JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const f4 = (n) => (Math.round(n * 10000) / 10000).toFixed(4);

function summarize(report) {
  const rows = (report.results || report).filter((r) => String(r.task).startsWith('grade'));
  const graded = rows.filter((r) => !r.error);
  const pass = graded.filter((r) => !r.failures || r.failures.length === 0);
  const usage = rows.flatMap((r) => r.usage || []);
  const llm = usage.filter((u) => u.provider !== 'typesafe');
  const jev = usage.filter((u) => u.provider === 'typesafe');
  const cost = (list) => list.reduce((s, u) => s + (u.cost || 0), 0);
  const notes = rows.flatMap((r) =>
    (r.retries || []).filter((x) => x.kind === 'judge').map((x) => x.reason),
  );
  const skipped = notes.filter((n) => n.includes('review skipped')).length;
  const agreements = notes.filter((n) => n.startsWith('grade agreement')).length;
  const disagreements = notes.filter((n) => n.startsWith('grade disagreement')).length;
  const reviews = llm.filter((u) => u.task === 'memoryz_essay_grade_review').length;
  const grades = llm.filter((u) => u.task === 'memoryz_essay_grade').length;
  const durations = graded.map((r) => r.productDurationMs || r.durationMs || 0);
  return {
    answers: rows.length,
    errors: rows.length - graded.length,
    pass: pass.length,
    llmCalls: llm.length,
    gradeCalls: grades,
    reviewCalls: reviews,
    jevCalls: jev.length,
    llmCost: cost(llm),
    jevCost: cost(jev),
    meanMs: mean(durations),
    medianMs: median(durations),
    maxMs: Math.max(0, ...durations),
    agreements,
    disagreements,
    skipped,
  };
}

const off = flags.off ? summarize(load(flags.off)) : null;
const on = flags.on ? summarize(load(flags.on)) : null;
const jevReport = JSON.parse(
  readFileSync(flags.jev || '.unlazy/feedback-3-typesafe/report.json', 'utf8'),
);
const jevGrade = jevReport.results.find(
  (r) => r.summary.task === 'grade' && r.summary.lang === 'ko',
);
const jevRows = jevGrade.rows.filter((r) => !r.error);
const jevSubset = jevRows.filter((r) => !/-v[234]$/.test(r.caseId));
const jevLat = jevSubset.map((r) => r.ms);

const line = (label, offV, onV, jevV) =>
  `| ${label} | ${offV ?? '—'} | ${onV ?? '—'} | ${jevV ?? '—'} |`;
const per = (s, v) => (s ? f4(v / s.answers) : null);
console.log('| 항목 | LLM만 (AI_JUDGE=off, 채점+검수) | LLM + Jev (AI_JUDGE=on) | Jev 판정만 |');
console.log('| --- | --- | --- | --- |');
console.log(line('답안 수', off?.answers, on?.answers, jevSubset.length));
console.log(
  line(
    '고정 규칙 통과(점수 구간·키워드·피드백)',
    off && `${off.pass}/${off.answers}`,
    on && `${on.pass}/${on.answers}`,
    `유형 ${jevSubset.filter((r) => r.typeOK).length}/${jevSubset.length}, 구간 ${jevSubset.filter((r) => r.bandOK).length}/${jevSubset.length} (점수는 코드 산식)`,
  ),
);
console.log(
  line(
    'LLM 호출 수 (채점 / 검수)',
    off && `${off.llmCalls} (${off.gradeCalls} / ${off.reviewCalls})`,
    on && `${on.llmCalls} (${on.gradeCalls} / ${on.reviewCalls})`,
    '0',
  ),
);
console.log(line('Jev 호출 수', off?.jevCalls, on?.jevCalls, jevSubset.length));
console.log(
  line(
    '검수 생략(판정 일치)',
    off && '0',
    on && `${on.skipped} / 일치 ${on.agreements}, 불일치 ${on.disagreements}`,
    '—',
  ),
);
console.log(
  line(
    '답안당 소요 평균 / 중앙값',
    off && `${f1(off.meanMs / 1000)}초 / ${f1(off.medianMs / 1000)}초`,
    on && `${f1(on.meanMs / 1000)}초 / ${f1(on.medianMs / 1000)}초`,
    `${f1(mean(jevLat) / 1000)}초 / ${f1(median(jevLat) / 1000)}초`,
  ),
);
console.log(
  line(
    '답안당 최대',
    off && `${f1(off.maxMs / 1000)}초`,
    on && `${f1(on.maxMs / 1000)}초`,
    `${f1(Math.max(...jevLat) / 1000)}초`,
  ),
);
console.log(
  line(
    '총 비용 (LLM + Jev)',
    off && `$${f4(off.llmCost + off.jevCost)}`,
    on && `$${f4(on.llmCost + on.jevCost)} (Jev $${f4(on.jevCost)})`,
    `$${f4(jevSubset.reduce((s, r) => s + (r.tokens / 1e6) * 0.042, 0))}`,
  ),
);
console.log(
  line(
    '답안당 비용',
    off && `$${per(off, off.llmCost + off.jevCost)}`,
    on && `$${per(on, on.llmCost + on.jevCost)}`,
    `$${f4(jevSubset.reduce((s, r) => s + (r.tokens / 1e6) * 0.042, 0) / jevSubset.length)}`,
  ),
);
if (off?.errors || on?.errors)
  console.log(
    `\n오류(제품 경로가 결과를 내지 못한 답안): off ${off?.errors ?? 0}, on ${on?.errors ?? 0}`,
  );
