import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { diagramStepNodes } from '../src/lib/explanation-validation';
import { ExplanationDiagram } from '../src/components/study/explanation-diagram';
import type { DiagramType, LearningExplanation } from '../src/lib/explanation-types';

function explanation(type: DiagramType): LearningExplanation {
  return {
    version: 1,
    questionId: 'q',
    citation: '자료 개념',
    status: 'READY',
    source: 'generated',
    optionReasons: [],
    microChecks: [],
    diagram: {
      id: 'd',
      type,
      title: '자료 구조',
      nodes: [
        { id: 'a', label: '자료', span: [0, 2] },
        { id: 'b', label: '개념', span: [3, 5], parentId: type === 'TREE' ? 'a' : undefined },
      ],
      edges: [{ from: 'a', to: 'b' }],
      columns: ['대상', '설명'],
      rows: [
        {
          id: 'r',
          label: '자료',
          cells: [
            { text: '자료', nodeId: 'a' },
            { text: '개념', nodeId: 'b' },
          ],
        },
      ],
      graph: {
        expression: 'y=x',
        samples: [
          [0, 0],
          [1, 1],
        ],
        marks: [{ kind: 'point', x: 1, y: 1, label: '개념', nodeId: 'b' }],
      },
    },
  };
}
test('all six diagram views render source nodes as controls with a named expansion', () => {
  for (const type of ['FLOW', 'CAUSE', 'COMPARE', 'TIMELINE', 'TREE', 'GRAPH'] as const) {
    const html = renderToStaticMarkup(
      createElement(ExplanationDiagram, { explanation: explanation(type), depth: 'FULL' }),
    );
    assert.match(html, /자료/);
    assert.match(html, /개념/);
    assert.match(html, /크게 보기/);
  }
});
test('masked answers never appear in rendered card text, labels or SVG metadata', () => {
  for (const type of ['FLOW', 'CAUSE', 'COMPARE', 'TIMELINE', 'TREE', 'GRAPH'] as const) {
    const e = explanation(type);
    e.diagram!.nodes[1].label = '숨긴정답';
    e.diagram!.rows![0].cells[1].text = '숨긴정답';
    e.diagram!.graph!.marks[0].label = '숨긴정답';
    const front = renderToStaticMarkup(
      createElement(ExplanationDiagram, {
        explanation: e,
        maskedNodeIds: ['b'],
        interactive: false,
      }),
    );
    assert.doesNotMatch(front, /숨긴정답/, type);
    assert.doesNotMatch(front, /자료 열기|크게 보기/);
    const back = renderToStaticMarkup(
      createElement(ExplanationDiagram, {
        explanation: e,
        maskedNodeIds: ['b'],
        revealed: true,
        interactive: false,
        depth: 'FULL',
      }),
    );
    assert.match(back, /숨긴정답/, type);
  }
});
test('duplicate comparison row headings are omitted but real comparison attributes remain', () => {
  const e = explanation('COMPARE');
  const duplicate = renderToStaticMarkup(createElement(ExplanationDiagram, { explanation: e }));
  assert.doesNotMatch(duplicate, />항목</);
  e.diagram!.rows![0].label = '속성';
  const attributed = renderToStaticMarkup(createElement(ExplanationDiagram, { explanation: e }));
  assert.match(attributed, />항목</);
  assert.match(attributed, /속성/);
});
test('comparison target labels are static while evidence cells remain actionable', () => {
  const html = renderToStaticMarkup(
    createElement(ExplanationDiagram, { explanation: explanation('COMPARE') }),
  );
  const rowHeading = html.match(/<th scope="row"[^>]*>(.*?)<\/th>/)?.[1];
  assert.ok(rowHeading);
  assert.doesNotMatch(rowHeading, /<button/);
  assert.match(html, /<td[^>]*><button/);
});

test('comparison steps skip static target labels and retain real attributes', () => {
  const e = explanation('COMPARE');
  assert.deepEqual(
    diagramStepNodes(e.diagram!).map((node) => node.id),
    ['b'],
  );
  e.diagram!.rows![0].label = '속성';
  assert.deepEqual(
    diagramStepNodes(e.diagram!).map((node) => node.id),
    ['a', 'b'],
  );
});
