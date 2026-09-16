'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronRight } from '@/components/icons';
import { Sheet } from '@/components/ui';
import { diagramPresentation, diagramStepNodes } from '@/lib/explanation-validation';
import type {
  ExplanationDepth,
  LearningDiagram,
  LearningExplanation,
  LearningNode,
} from '@/lib/explanation-types';
import styles from './explanation-diagram.module.css';

const typeNames = {
  FLOW: '과정',
  COMPARE: '비교',
  CAUSE: '원인과 결과',
  TIMELINE: '시간 순서',
  GRAPH: '그래프',
  TREE: '분류',
};

type Props = {
  explanation: LearningExplanation;
  selectedAnswer?: number | null;
  depth?: ExplanationDepth;
  maskedNodeIds?: string[];
  revealed?: boolean;
  onNodeSelect?: (nodeId: string) => void;
  onOpenSource?: () => void;
  interactive?: boolean;
};

export function ExplanationDiagram({
  explanation,
  selectedAnswer,
  depth = 'SHORT',
  maskedNodeIds = [],
  revealed = false,
  onNodeSelect,
  onOpenSource,
  interactive = true,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const sourceId = useId();
  useEffect(() => {
    if (!selectedId) return;
    const source = document.getElementById(expanded ? `${sourceId}-expanded` : sourceId);
    source?.scrollIntoView({
      block: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  }, [selectedId, expanded, sourceId]);
  const original = explanation.diagram;
  if (explanation.status !== 'READY' || !original?.nodes.length) {
    return (
      <div className={styles.fallback}>
        <p>{explanation.message || '이 문제는 글 해설로 확인해요.'}</p>
        {interactive && onOpenSource && (
          <button type="button" className={styles.textButton} onClick={onOpenSource}>
            자료 원문 보기
          </button>
        )}
      </div>
    );
  }
  const { diagram, maskedIds, isMasked } = diagramPresentation(original, maskedNodeIds, revealed);
  const mappedId =
    selectedAnswer == null ? undefined : diagram.optionNodeMap?.[String(selectedAnswer)];
  const selected = diagram.nodes.find((n) => n.id === selectedId);
  const focusId =
    selected?.id ??
    mappedId ??
    diagram.answerNodeId ??
    diagram.focusNodeIds?.[0] ??
    diagram.nodes[0].id;
  const stepIds = new Set(diagramStepNodes(original).map((node) => node.id));
  const steps = diagram.nodes.filter((node) => stepIds.has(node.id));
  const fullIndex = Math.max(
    0,
    steps.findIndex((n) => n.id === focusId),
  );
  const focusNode = steps[fullIndex];
  const canSource = interactive && !isMasked && !!explanation.citation;
  const choose = (nodeId: string) => {
    setSelectedId(nodeId);
    onNodeSelect?.(nodeId);
  };
  const focusedIds = new Set(
    diagram.focusNodeIds?.length
      ? diagram.focusNodeIds
      : diagram.nodes.slice(Math.max(0, fullIndex - 1), fullIndex + 2).map((n) => n.id),
  );
  // Tables, trees and plots retain their context; only linear journeys can be shortened.
  const linear = ['FLOW', 'CAUSE', 'TIMELINE'].includes(diagram.type);
  const compactNodes =
    depth === 'SHORT' && linear && !isMasked
      ? diagram.nodes.filter((n) => focusedIds.has(n.id) || n.id === mappedId)
      : diagram.nodes;
  const omitted = diagram.nodes.length - compactNodes.length;

  function source(node: LearningNode, expandedView = false) {
    if (!canSource) return null;
    const [start, end] = node.span;
    if (start < 0 || end <= start || end > explanation.citation.length) return null;
    return (
      <section
        id={expandedView ? `${sourceId}-expanded` : sourceId}
        className={styles.source}
        aria-label="선택한 내용의 원문"
        aria-live="polite"
      >
        <div className={styles.sourceHeading}>
          <strong>이 내용의 원문</strong>
          {onOpenSource && (
            <button type="button" className={styles.textButton} onClick={onOpenSource}>
              자료 열기 <span aria-hidden="true">↗</span>
            </button>
          )}
        </div>
        <blockquote>
          {start > 70 ? '…' : ''}
          {explanation.citation.slice(Math.max(0, start - 70), start)}
          <mark>{explanation.citation.slice(start, end)}</mark>
          {explanation.citation.slice(end, end + 70)}
          {end + 70 < explanation.citation.length ? '…' : ''}
        </blockquote>
      </section>
    );
  }

  function nodeContent(n: LearningNode, label?: string, hideMarker = false) {
    const masked = maskedIds.has(n.id);
    return (
      <>
        <span className={styles.nodeCopy}>
          {!masked && !hideMarker && n.id === diagram.answerNodeId && (
            <span className={styles.correctLabel}>정답 근거</span>
          )}
          <span className={masked ? styles.maskLabel : styles.nodeLabel}>{label ?? n.label}</span>
          {!masked && depth === 'FULL' && n.detail && n.detail !== n.label && (
            <span className={styles.detail}>{n.detail}</span>
          )}
          {masked ? (
            <span className={styles.maskBadge}>가림</span>
          ) : n.id === mappedId && !hideMarker ? (
            <span className={styles.answerBadge}>내 답과 연결</span>
          ) : null}
        </span>
      </>
    );
  }

  function node(
    n: LearningNode,
    options: {
      prefix?: ReactNode;
      label?: string;
      table?: boolean;
      hideMarker?: boolean;
      readOnly?: boolean;
    } = {},
  ) {
    const className = [
      styles.node,
      n.id === diagram.answerNodeId && !maskedIds.has(n.id) ? styles.answerNode : '',
      (expanded ? focusNode.id === n.id : selected?.id === n.id) ? styles.selected : '',
      maskedIds.has(n.id) ? styles.masked : '',
      options.table ? styles.tableNode : '',
    ]
      .filter(Boolean)
      .join(' ');
    const content = (
      <>
        {options.prefix}
        {nodeContent(n, options.label, options.hideMarker)}
      </>
    );
    return interactive && !options.readOnly ? (
      <button
        type="button"
        className={className}
        onClick={() => choose(n.id)}
        aria-pressed={expanded ? focusNode.id === n.id : selected?.id === n.id}
        aria-controls={canSource ? (expanded ? `${sourceId}-expanded` : sourceId) : undefined}
      >
        {content}
        <ChevronRight size={14} aria-hidden="true" className={styles.nodeChevron} />
      </button>
    ) : (
      <div className={className}>{content}</div>
    );
  }

  function renderDiagram(nodes: LearningNode[]) {
    const ids = new Set(nodes.map((n) => n.id));
    if (diagram.type === 'COMPARE' && diagram.columns && diagram.rows) {
      const presented = new Set<string>();
      // Decide from the unmasked structure so card fronts and backs keep the same columns.
      const omitRowHeading =
        !!original?.rows?.length &&
        original.rows.every((row) => row.label.trim() === row.cells[0]?.text.trim());
      return (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.srOnly}>{diagram.title}</caption>
            {omitRowHeading && (
              <colgroup>
                <col style={{ width: '20%' }} />
                {diagram.columns.slice(1).map((_, i) => (
                  <col key={i} style={{ width: `${80 / (diagram.columns!.length - 1)}%` }} />
                ))}
              </colgroup>
            )}
            <thead>
              <tr>
                {!omitRowHeading && (
                  <th scope="col" className={styles.rowHeading}>
                    항목
                  </th>
                )}
                {diagram.columns.map((column, i) => (
                  <th scope="col" key={i}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {diagram.rows.map((row) => (
                <tr key={row.id}>
                  {!omitRowHeading && <th scope="row">{row.label}</th>}
                  {row.cells.map((cell, i) => {
                    const n = nodes.find((item) => item.id === cell.nodeId);
                    const hideMarker = presented.has(cell.nodeId);
                    presented.add(cell.nodeId);
                    if (omitRowHeading && i === 0)
                      return (
                        <th scope="row" className={styles.targetCell} key={i}>
                          {n
                            ? node(n, {
                                label: cell.text,
                                table: true,
                                hideMarker: true,
                                readOnly: true,
                              })
                            : null}
                        </th>
                      );
                    return (
                      <td key={i}>
                        {n ? node(n, { label: cell.text, table: true, hideMarker }) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    if (diagram.type === 'TREE') {
      const parentOf = new Map(
        nodes.map((n) => [
          n.id,
          n.parentId ?? diagram.edges?.find((edge) => edge.to === n.id)?.from,
        ]),
      );
      const draw = (n: LearningNode, ancestors: Set<string>): ReactNode => {
        if (ancestors.has(n.id) || ancestors.size >= 3) return null;
        const next = new Set([...ancestors, n.id]);
        const children = nodes.filter((child) => parentOf.get(child.id) === n.id);
        return (
          <li key={n.id}>
            {node(n)}
            {children.length > 0 && <ul>{children.map((child) => draw(child, next))}</ul>}
          </li>
        );
      };
      return (
        <ul className={styles.tree}>
          {nodes
            .filter((n) => !parentOf.get(n.id) || !ids.has(parentOf.get(n.id)!))
            .map((n) => draw(n, new Set()))}
        </ul>
      );
    }
    if (diagram.type === 'GRAPH') {
      return (
        <div>
          {diagram.graph ? (
            <GraphPlot diagram={diagram} />
          ) : (
            <div className={styles.graphMasked}>그래프는 답을 확인할 때 함께 보여요</div>
          )}
          <ul className={styles.graphNodes}>
            {nodes.map((n) => (
              <li key={n.id}>{node(n)}</li>
            ))}
          </ul>
        </div>
      );
    }
    const timeline = diagram.type === 'TIMELINE';
    const extraEdges =
      diagram.edges?.filter(
        (edge) =>
          (edge.loop ||
            diagram.nodes.findIndex((n) => n.id === edge.to) -
              diagram.nodes.findIndex((n) => n.id === edge.from) >
              1) &&
          ids.has(edge.from) &&
          ids.has(edge.to),
      ) ?? [];
    return (
      <>
        <ol className={timeline ? styles.timeline : styles.flow}>
          {nodes.map((n, index) => {
            const absoluteIndex = diagram.nodes.findIndex((item) => item.id === n.id);
            const previous = nodes[index - 1];
            const edge =
              previous &&
              diagram.edges?.find((e) => !e.loop && e.from === previous.id && e.to === n.id);
            const adjacent = previous && diagram.nodes[absoluteIndex - 1]?.id === previous.id;
            const connected = adjacent && (!diagram.edges?.length || edge);
            return (
              <li key={n.id}>
                {index > 0 && !timeline && (
                  <div className={styles.connector}>
                    {connected ? (
                      <>
                        {edge?.label && <span>{edge.label}</span>}
                        <span aria-hidden="true">↓</span>
                      </>
                    ) : (
                      <span aria-hidden="true">···</span>
                    )}
                  </div>
                )}
                {node(n, {
                  prefix: timeline ? (
                    <span className={styles.timeLabel}>
                      {maskedIds.has(n.id) ? '—' : (n.value ?? `${absoluteIndex + 1}`)}
                    </span>
                  ) : (
                    <span className={styles.number} aria-hidden="true">
                      {absoluteIndex + 1}
                    </span>
                  ),
                })}
                {timeline && n.group && !maskedIds.has(n.id) && (
                  <span className={styles.group}>{n.group}</span>
                )}
              </li>
            );
          })}
        </ol>
        {extraEdges.map((edge, index) => (
          <p className={styles.loop} key={index}>
            {edge.loop && <span>되돌림 · </span>}
            {nodes.find((n) => n.id === edge.from)?.label} →{' '}
            {nodes.find((n) => n.id === edge.to)?.label}
            {edge.label ? ` · ${edge.label}` : ''}
          </p>
        ))}
      </>
    );
  }

  return (
    <section className={styles.diagram} aria-label={diagram.title}>
      <div className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>{typeNames[diagram.type]}</span>
          <h3>{diagram.title}</h3>
        </div>
        {interactive && (
          <button type="button" className={styles.textButton} onClick={() => setExpanded(true)}>
            크게 보기 <ChevronRight size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {renderDiagram(compactNodes)}
      {omitted > 0 && (
        <p className={styles.contextNote}>
          전체 {diagram.nodes.length}개 중 관련 내용 {compactNodes.length}개
          {interactive && (
            <button type="button" className={styles.textButton} onClick={() => setExpanded(true)}>
              전체 보기
            </button>
          )}
        </p>
      )}
      {canSource && (
        <p className={styles.hint}>화살표가 있는 내용을 누르면 원문 근거를 확인할 수 있어요</p>
      )}
      {selected && source(selected)}
      {interactive && (
        <Sheet
          open={expanded}
          onClose={() => setExpanded(false)}
          title={diagram.title}
          fullScreen
          description={`${typeNames[diagram.type]} · ${steps.length}개 내용`}
        >
          <div className={styles.expanded}>
            <div className={styles.stepHeader} aria-live="polite">
              <span>
                {fullIndex + 1} / {steps.length}
              </span>
              <h3>{focusNode.label}</h3>
            </div>
            <div className={styles.stepPicker} aria-label="확인할 내용 선택">
              {steps.map((n, i) => (
                <button
                  type="button"
                  key={n.id}
                  onClick={() => choose(n.id)}
                  aria-current={n.id === focusNode.id ? 'step' : undefined}
                  aria-label={`${i + 1}번째 내용: ${n.label}`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
            {renderDiagram(diagram.nodes)}
            {source(focusNode, true)}
            <div className={styles.stepActions}>
              <button
                type="button"
                disabled={fullIndex === 0}
                onClick={() => choose(steps[fullIndex - 1].id)}
              >
                이전 내용
              </button>
              {fullIndex < steps.length - 1 ? (
                <button type="button" onClick={() => choose(steps[fullIndex + 1].id)}>
                  다음 내용 <span aria-hidden="true">→</span>
                </button>
              ) : (
                <button type="button" onClick={() => setExpanded(false)}>
                  해설로 돌아가기
                </button>
              )}
            </div>
          </div>
        </Sheet>
      )}
    </section>
  );
}

function GraphPlot({ diagram }: { diagram: LearningDiagram }) {
  const clipId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const graph = diagram.graph!;
  const all = [...graph.samples, ...graph.marks.map((mark) => [mark.x, mark.y])];
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const lowX = Math.min(0, ...xs),
    highX = Math.max(0, ...xs);
  const lowY = Math.min(0, ...ys),
    highY = Math.max(0, ...ys);
  const width = highX - lowX || 1,
    height = highY - lowY || 1;
  const x = (value: number) => 30 + ((value - lowX) / width) * 250;
  const y = (value: number) => 190 - ((value - lowY) / height) * 160;
  return (
    <figure className={styles.plot}>
      <svg
        viewBox="0 0 320 220"
        role="img"
        aria-label={`${graph.expression}. ${graph.marks.map((mark) => mark.label).join(', ')}`}
      >
        <defs>
          <clipPath id={`plot-${clipId}`}>
            <rect x="24" y="20" width="272" height="178" />
          </clipPath>
        </defs>
        <line x1="24" y1={y(0)} x2="292" y2={y(0)} className={styles.axis} />
        <line x1={x(0)} y1="20" x2={x(0)} y2="198" className={styles.axis} />
        <text x="298" y={Math.min(202, y(0) + 15)}>
          x
        </text>
        <text x={Math.max(7, x(0) - 14)} y="18">
          y
        </text>
        <g clipPath={`url(#plot-${clipId})`}>
          <polyline
            points={graph.samples.map(([px, py]) => `${x(px)},${y(py)}`).join(' ')}
            className={styles.curve}
          />
          {graph.marks.map((mark, index) => (
            <g key={index}>
              {mark.kind === 'tangent' && mark.slope !== undefined && (
                <line
                  x1={x(lowX)}
                  y1={y(mark.y + mark.slope * (lowX - mark.x))}
                  x2={x(highX)}
                  y2={y(mark.y + mark.slope * (highX - mark.x))}
                  className={styles.tangent}
                />
              )}
              <circle cx={x(mark.x)} cy={y(mark.y)} r="4" className={styles.point} />
            </g>
          ))}
        </g>
        <text x="30" y="216">
          {lowX}
        </text>
        <text x="280" y="216" textAnchor="end">
          {highX}
        </text>
      </svg>
      <figcaption>
        <strong>{graph.expression}</strong>
        {graph.marks.map((mark, i) => (
          <span key={i}>
            {mark.label} · ({mark.x}, {mark.y})
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
