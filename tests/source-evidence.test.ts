import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { sourceEvidence, evidenceText, evidencePageLabel } from '../src/lib/source-evidence';
import { findCitation } from '../src/components/study/material-layout';
import { Citation } from '../src/components/study/shared';
import {
  pdfEvidencePages,
  evidencePdfUrl,
  matchPdfEvidence,
} from '../src/components/study/pdf-evidence';

const before = 'An inhibitor binds at a separate site. This is a source sentence.';
const visual = '(a) Binding\n\nE S ES\n\nI\n\nEI\n\n(b) Release\n\nE S\n\nI I\n\nESI';
const after = 'FIGURE 3 A caption describing the diagram without reconstructing it.';
const quote = `${before}\n\n${visual}\n\n${after}`;

test('PDF layout run is one explicit gap, with byte-for-byte original accessible', () => {
  const parts = sourceEvidence(quote, true);
  assert.deepEqual(
    parts.map((p) => p.kind),
    ['text', 'layout', 'text'],
  );
  assert.equal(parts[1].text, visual);
  for (const p of parts) assert.equal(quote.slice(p.start, p.end), p.text);
  assert.equal(parts[0].text, before);
  assert.equal(parts[2].text, after);
});

test('short statements, single scientific labels, formulas and chemical arrows are not noise', () => {
  for (const text of ['Do not mix.', 'NaCl', 'Vmax = 3', 'A ⇌ B', 'x ≤ 0', 'I', '물이 이동한다.']) {
    assert.equal(sourceEvidence(text, true)[0].kind, 'text', text);
  }
  const parts = sourceEvidence('pH = 7\n\nA → B\n\nΔG°′ < 0', true);
  assert.equal(
    parts.every((p) => p.kind === 'text'),
    true,
  );
});

test('manual/non-PDF source never guesses that short lines are diagram fragments', () => {
  assert.equal(
    sourceEvidence(quote).some((p) => p.kind === 'layout'),
    false,
  );
  assert.deepEqual(sourceEvidence(' \n\n\t', true), []);
  assert.equal(evidenceText('  ΔG°′\n = −16.7  kJ/mol '), 'ΔG°′ = −16.7 kJ/mol');
});

test('exact and whitespace-tolerant location retain original UTF-16 page provenance', () => {
  const content = `😀 서문\n\n${quote}\n\n끝`;
  const breaks = [0, content.indexOf(before), content.indexOf(after)];
  const found = findCitation(content, quote, breaks)!;
  assert.equal(content.slice(found.start, found.end), quote);
  assert.equal(evidencePageLabel(found.start, found.end, breaks), 'PDF 2–3쪽');
  assert.equal(evidencePageLabel(breaks[1], breaks[2], breaks), 'PDF 2쪽');
  assert.equal(evidencePageLabel(0, 1, []), null);
  assert.equal(evidencePageLabel(0, 1, [0, -2]), null);
  assert.equal(findCitation(content, 'invented words', breaks), null);
  assert.equal(findCitation(content, quote.replace(/\s+/g, ' '), breaks)?.page, 2);
});

test('collapsed citation actually omits hidden long source from the accessible content', () => {
  const html = renderToStaticMarkup(createElement(Citation, { citation: quote }));
  assert.match(html, /원문 발췌/);
  assert.match(html, /전체 근거 보기/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls=/);
  assert.doesNotMatch(html, /FIGURE 3/);
});

test('two short paragraphs can be expanded, rather than silently dropping the second', () => {
  const html = renderToStaticMarkup(
    createElement(Citation, { citation: '첫 번째 문장.\n\n두 번째 문장.' }),
  );
  assert.match(html, /전체 근거 보기/);
});

test('a PDF with broken diagram text leads to visual evidence instead of an arbitrary prose preview', () => {
  const html = renderToStaticMarkup(createElement(Citation, {
    citation: quote,
    material: {
      id: 'm', subjectId: 's', title: '교재', type: 'PDF', url: '/api/uploads/abc',
      contentLength: quote.length, excerpt: '', contentHash: 'qa', createdAt: '',
    },
  }));
  assert.match(html, /본문·수식·도식/);
  assert.match(html, /전체 근거 보기/);
  assert.doesNotMatch(html, /An inhibitor/);
  assert.doesNotMatch(html, /E S ES/);
});

test('only overlapping source pages are requested, retaining original page numbers', () => {
  const content =
    'unused preface\n\nFirst source paragraph.\n\nSecond source paragraph.\n\nunused ending';
  const start = content.indexOf('First');
  const second = content.indexOf('Second');
  const end = content.indexOf('unused ending');
  const pages = pdfEvidencePages(content, content.slice(start, end).trim(), [
    0,
    start,
    second,
    end,
  ]);
  assert.deepEqual(
    pages.map((p) => p.page),
    [2, 3],
  );
  assert.equal(evidencePdfUrl('/api/uploads/abc-123', pages), '/api/uploads/abc-123?pages=2%2C3');
  assert.equal(evidencePdfUrl('https://third-party.invalid/doc.pdf', pages), null);
  assert.deepEqual(pdfEvidencePages(content, 'not present', [0, start]), []);
  assert.deepEqual(pdfEvidencePages(content, 'First source paragraph.'), []);
});

test('PDF highlights literal evidence across text runs but not unrelated page text', () => {
  const items = [
    { str: 'An unrelated heading.' },
    { str: 'The catalyst reduces ' },
    { str: 'activation energy without changing equilibrium.' },
    { str: 'An unrelated footer.' },
  ];
  const spans = matchPdfEvidence(
    items,
    'The catalyst reduces activation energy without changing equilibrium.',
  );
  assert.deepEqual(
    spans.map((s) => s.item),
    [1, 2],
  );
  assert.equal(
    items[spans[0].item].str.slice(spans[0].start, spans[0].end).trim(),
    'The catalyst reduces',
  );
  assert.deepEqual(
    matchPdfEvidence(items, 'Fabricated scientific evidence not present on the page.'),
    [],
  );
});

test('do not highlight ambiguous repeated quotes or merely similar formulas', () => {
  const sentence = 'An identical statement that appears twice.';
  assert.deepEqual(matchPdfEvidence([{ str: sentence }, { str: sentence }], sentence), []);
  assert.deepEqual(matchPdfEvidence([{ str: 'ΔG°′ = +16.7 kJ/mol' }], 'ΔG°′ = −16.7 kJ/mol'), []);
  assert.deepEqual(matchPdfEvidence([{ str: 'ES E S I' }], 'E'), []);
});

test('PDF highlight matcher handles ligatures and noncontiguous column ordering without rewriting', () => {
  const items = [
    { str: 'Efﬁciency increases as the concentration rises.' },
    { str: 'Some unrelated other-column text.' },
    { str: 'The equilibrium constant does not change.' },
  ];
  const spans = matchPdfEvidence(
    items,
    'Efficiency increases as the concentration rises. The equilibrium constant does not change.',
  );
  assert.deepEqual(
    spans.map((s) => s.item),
    [0, 2],
  );
});
