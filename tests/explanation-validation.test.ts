import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diagramPresentation,
  validateExplanation,
  validSourceSpan,
} from '../src/lib/explanation-validation';
import type { DiagramType, LearningExplanation } from '../src/lib/explanation-types';

const citation = '광종은 노비안검법을 시행했다. 성종은 12목을 설치했다.';
function fixture(type: DiagramType = 'FLOW'): LearningExplanation {
  const first = citation.indexOf('노비안검법');
  const second = citation.indexOf('12목');
  return {
    version: 1,
    questionId: 'q1',
    status: 'READY',
    source: 'rule',
    citation,
    optionReasons: ['원문에서 확인해요'],
    microChecks: [],
    diagram: {
      id: 'd1',
      title: '고려의 정책',
      type,
      nodes: [
        { id: 'n1', label: '노비안검법', span: [first, first + 5] },
        { id: 'n2', label: '12목', span: [second, second + 3] },
      ],
      answerNodeId: 'n1',
      optionNodeMap: { '0': 'n2' },
      focusNodeIds: ['n1'],
      ...(type === 'COMPARE'
        ? {
            columns: ['첫 번째', '두 번째'],
            rows: [
              {
                id: 'r1',
                label: '정책',
                cells: [
                  { text: '노비안검법', nodeId: 'n1' },
                  { text: '12목', nodeId: 'n2' },
                ],
              },
            ],
          }
        : {}),
      ...(type === 'GRAPH'
        ? {
            graph: {
              expression: 'y = x',
              samples: [
                [0, 0],
                [1, 1],
              ],
              marks: [{ kind: 'tangent', x: 1, y: 1, slope: 1, label: '기울기', nodeId: 'n1' }],
            },
          }
        : {}),
      ...(type === 'TREE' ? { edges: [{ from: 'n1', to: 'n2' }] } : {}),
    },
  };
}

test('all six supported structures preserve grounded nodes', () => {
  for (const type of ['FLOW', 'COMPARE', 'CAUSE', 'TIMELINE', 'GRAPH', 'TREE'] as const) {
    const parsed = validateExplanation(fixture(type));
    assert.equal(parsed?.status, 'READY', type);
    assert.equal(parsed?.diagram?.type, type);
  }
});

test('malformed envelopes are rejected while invalid diagrams retain text explanations', () => {
  assert.equal(validateExplanation(null), null);
  assert.equal(validateExplanation({ ...fixture(), version: 2 }), null);
  const bad = fixture();
  (bad.diagram as unknown as { type: string }).type = 'HTML';
  const parsed = validateExplanation(bad);
  assert.equal(parsed?.status, 'TEXT');
  assert.equal(parsed?.diagram, undefined);
  assert.deepEqual(parsed?.optionReasons, bad.optionReasons);
  assert.equal(parsed?.citation, citation);
});

test('source spans reject whitespace, reversed, out-of-bounds and split emoji offsets', () => {
  assert.equal(validSourceSpan('가😀나', [1, 3]), true);
  for (const span of [
    [1, 2],
    [2, 3],
    [3, 2],
    [-1, 2],
    [0, 5],
    [1.5, 3],
  ] as [number, number][])
    assert.equal(validSourceSpan('가😀나', span), false);
  assert.equal(validSourceSpan('  ', [0, 2]), false);
  const bad = fixture();
  bad.diagram!.nodes[0].span = [0, 999];
  assert.equal(validateExplanation(bad)?.status, 'TEXT');
});

test('a wrong claim sharing one keyword is not sufficient grounding', () => {
  const bad = fixture();
  bad.diagram!.nodes[0].label = '노비안검법 폐지';
  assert.equal(validateExplanation(bad)?.status, 'TEXT');
  bad.diagram!.nodes[0].label = '노비안검법';
  bad.diagram!.nodes[0].detail = '노비안검법을 폐지했다';
  assert.equal(validateExplanation(bad)?.status, 'TEXT');
});

test('duplicate node IDs and all dangling reference classes are rejected', () => {
  const mutations: ((e: LearningExplanation) => void)[] = [
    (e) => {
      e.diagram!.nodes[1].id = 'n1';
    },
    (e) => {
      e.diagram!.answerNodeId = 'missing';
    },
    (e) => {
      e.diagram!.optionNodeMap = { '0': 'missing' };
    },
    (e) => {
      e.diagram!.focusNodeIds = ['missing'];
    },
    (e) => {
      e.diagram!.nodes[0].parentId = 'missing';
    },
    (e) => {
      e.diagram!.edges = [{ from: 'n1', to: 'missing' }];
    },
  ];
  for (const mutate of mutations) {
    const bad = fixture();
    mutate(bad);
    assert.equal(validateExplanation(bad)?.status, 'TEXT');
  }
});

test('comparison requires consistent dimensions and grounded cell text', () => {
  const bad = fixture('COMPARE');
  bad.diagram!.rows![0].cells.pop();
  assert.equal(validateExplanation(bad)?.status, 'TEXT');
  const wrongCell = fixture('COMPARE');
  wrongCell.diagram!.rows![0].cells[0].text = '훈민정음';
  assert.equal(validateExplanation(wrongCell)?.status, 'TEXT');
});

test('graphs reject nonfinite samples, reversed x, missing tangent slope and unknown references', () => {
  const mutations: ((e: LearningExplanation) => void)[] = [
    (e) => {
      e.diagram!.graph!.samples[0][1] = Infinity;
    },
    (e) => {
      e.diagram!.graph!.samples[0][0] = 5;
    },
    (e) => {
      delete e.diagram!.graph!.marks[0].slope;
    },
    (e) => {
      e.diagram!.graph!.marks[0].nodeId = 'missing';
    },
  ];
  for (const mutate of mutations) {
    const bad = fixture('GRAPH');
    mutate(bad);
    assert.equal(validateExplanation(bad)?.status, 'TEXT');
  }
});

test('tree rejects cycles, multiple parents, and depth greater than three', () => {
  const cyclic = fixture('TREE');
  cyclic.diagram!.edges!.push({ from: 'n2', to: 'n1' });
  assert.equal(validateExplanation(cyclic)?.status, 'TEXT');
  const deep = fixture('TREE');
  deep.diagram!.nodes.push(
    { ...deep.diagram!.nodes[0], id: 'n3', parentId: 'n2' },
    { ...deep.diagram!.nodes[1], id: 'n4', parentId: 'n3' },
  );
  assert.equal(validateExplanation(deep)?.status, 'TEXT');
  const conflict = fixture('TREE');
  conflict.diagram!.nodes.push({ ...conflict.diagram!.nodes[0], id: 'n3' });
  conflict.diagram!.edges!.push({ from: 'n3', to: 'n2' });
  assert.equal(validateExplanation(conflict)?.status, 'TEXT');
});

test('only CAUSE allows explicit return loops; linear backward edges are rejected', () => {
  const bad = fixture('FLOW');
  bad.diagram!.edges = [{ from: 'n2', to: 'n1' }];
  assert.equal(validateExplanation(bad)?.status, 'TEXT');
  bad.diagram!.edges[0].loop = true;
  assert.equal(validateExplanation(bad)?.status, 'TEXT');
  bad.diagram!.type = 'CAUSE';
  assert.equal(validateExplanation(bad)?.status, 'READY');
});

test('micro checks require grounded answers and matching node IDs without discarding valid diagram', () => {
  const data = fixture();
  const span = data.diagram!.nodes[0].span;
  data.microChecks = [
    {
      id: 'm1',
      nodeId: 'n1',
      prompt: '원문에 나온 정책은?',
      options: ['노비안검법', '훈민정음'],
      answer: 0,
      explanation: '노비안검법',
      span,
    },
  ];
  assert.equal(validateExplanation(data)?.microChecks.length, 1);
  data.microChecks[0].answer = 1;
  assert.equal(validateExplanation(data)?.microChecks.length, 0);
  assert.equal(validateExplanation(data)?.status, 'READY');
  data.microChecks[0].answer = 0;
  data.microChecks[0].nodeId = 'missing';
  assert.equal(validateExplanation(data)?.microChecks.length, 0);
});

test('masked presentation removes answer from content, values, headers and source spans without mutation', () => {
  const data = fixture('COMPARE');
  data.diagram!.title = '노비안검법';
  data.diagram!.nodes[0].detail = '노비안검법';
  data.diagram!.nodes[0].value = '노비안검법';
  data.diagram!.nodes[0].group = '노비안검법';
  data.diagram!.columns = ['노비안검법', '두 번째'];
  data.diagram!.rows![0].label = '노비안검법';
  data.diagram!.edges = [{ from: 'n1', to: 'n2', label: '노비안검법' }];
  const before = JSON.stringify(data.diagram);
  const front = diagramPresentation(data.diagram!, ['n1']);
  assert.equal(front.isMasked, true);
  assert.equal(JSON.stringify(front.diagram).includes('노비안검법'), false);
  assert.deepEqual(front.diagram.nodes[0].span, [0, 0]);
  assert.equal(JSON.stringify(data.diagram), before);
  const back = diagramPresentation(data.diagram!, ['n1'], true);
  assert.equal(back.isMasked, false);
  assert.equal(back.diagram.nodes[0].label, '노비안검법');
});

test('masked graph omits expression, marks and sampled geometry until answer reveal', () => {
  const data = fixture('GRAPH');
  assert.equal(diagramPresentation(data.diagram!, ['n1']).diagram.graph, undefined);
  assert.equal(diagramPresentation(data.diagram!, ['n1'], true).diagram.graph, data.diagram!.graph);
});

test('unknown mask IDs conceal all nodes instead of leaking a stale card answer', () => {
  const data = fixture();
  const front = diagramPresentation(data.diagram!, ['deleted-node']);
  assert.equal(front.isMasked, true);
  assert.equal(front.maskedIds.size, data.diagram!.nodes.length);
  assert.equal(JSON.stringify(front.diagram).includes('노비안검법'), false);
  assert.equal(JSON.stringify(front.diagram).includes('12목'), false);
  assert.equal(diagramPresentation(data.diagram!, ['deleted-node'], true).isMasked, false);
});

test('masked terms repeated inside other nodes and comparison cells are also concealed', () => {
  const data = fixture('COMPARE');
  data.diagram!.nodes[1].label = '노비안검법 이후';
  data.diagram!.nodes[1].detail = '노비안검법을 시행했다';
  data.diagram!.rows![0].cells[1].text = '노비안검법 이후';
  assert.equal(
    JSON.stringify(diagramPresentation(data.diagram!, ['n1']).diagram).includes('노비안검법'),
    false,
  );
  assert.equal(
    diagramPresentation(data.diagram!, ['n1'], true).diagram.nodes[1].label,
    '노비안검법 이후',
  );
});
