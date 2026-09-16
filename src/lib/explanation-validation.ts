import { z } from 'zod';
import type { LearningDiagram, LearningExplanation } from './explanation-types';

const text = z.string().trim().min(1).max(1200);
const id = z.string().min(1).max(120);
const span = z.tuple([z.number().int().nonnegative(), z.number().int().positive()]);
const node = z.object({
  id,
  label: text,
  span,
  detail: text.optional(),
  group: text.optional(),
  value: text.optional(),
  parentId: id.optional(),
});
const finite = z.number().finite().min(-1e9).max(1e9);
const diagramSchema = z.object({
  id,
  type: z.enum(['FLOW', 'COMPARE', 'CAUSE', 'TIMELINE', 'GRAPH', 'TREE']),
  title: text,
  nodes: z.array(node).min(2).max(12),
  edges: z
    .array(
      z.object({
        from: id,
        to: id,
        label: z.string().max(120).optional(),
        loop: z.boolean().optional(),
      }),
    )
    .max(24)
    .optional(),
  columns: z.array(text).min(2).max(3).optional(),
  rows: z
    .array(
      z.object({
        id,
        label: text,
        cells: z
          .array(z.object({ text, nodeId: id }))
          .min(2)
          .max(3),
      }),
    )
    .min(1)
    .max(6)
    .optional(),
  graph: z
    .object({
      expression: text,
      samples: z
        .array(z.tuple([finite, finite]))
        .min(2)
        .max(1000),
      marks: z
        .array(
          z.object({
            kind: z.enum(['point', 'tangent']),
            x: finite,
            y: finite,
            label: text,
            nodeId: id.optional(),
            slope: finite.optional(),
          }),
        )
        .max(8),
    })
    .optional(),
  answerNodeId: id.optional(),
  optionNodeMap: z.record(z.string().regex(/^\d+$/), id).optional(),
  focusNodeIds: z.array(id).max(12).optional(),
});
const microSchema = z.object({
  id,
  nodeId: id,
  prompt: text,
  options: z.tuple([text, text]),
  answer: z.union([z.literal(0), z.literal(1)]),
  explanation: text,
  span,
});
const explanationSchema = z.object({
  version: z.literal(1),
  status: z.enum(['READY', 'TEXT']),
  questionId: id,
  citation: z.string().max(100000),
  diagnosis: text.optional(),
  optionReasons: z.array(z.string().max(2000)).max(12),
  diagram: z.unknown().optional(),
  microChecks: z.array(z.unknown()).max(12),
  source: z.enum(['generated', 'rule', 'text']),
  message: text.optional(),
});

/** UTF-16 spans must not bisect a surrogate pair or point at an empty excerpt. */
export function validSourceSpan(citation: string, value: [number, number]): boolean {
  const [start, end] = value;
  const splitsPair = (at: number) =>
    at > 0 &&
    at < citation.length &&
    /[\uD800-\uDBFF]/.test(citation[at - 1]) &&
    /[\uDC00-\uDFFF]/.test(citation[at]);
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= citation.length &&
    !splitsPair(start) &&
    !splitsPair(end) &&
    citation.slice(start, end).trim().length > 0
  );
}

const normalize = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
/** Lexical grounding is a conservative display guard, not a claim of semantic proof. */
function grounded(label: string, excerpt: string) {
  const source = normalize(excerpt);
  const normalized = normalize(label);
  if (!normalized) return false;
  if (source.includes(normalized)) return true;
  const tokens =
    label
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return (
    tokens.length > 0 &&
    tokens.every((token) => {
      const stem = token.replace(
        /(에서는|으로|에서|에게|이다|한다|된다|을|를|은|는|이|가|의|에|로)$/u,
        '',
      );
      return source.includes(token) || (stem.length >= 2 && source.includes(stem));
    })
  );
}

function validDiagram(diagram: LearningDiagram, citation: string) {
  const ids = new Set(diagram.nodes.map((n) => n.id));
  if (ids.size !== diagram.nodes.length) return false;
  if (
    diagram.nodes.some(
      (n) =>
        !validSourceSpan(citation, n.span) ||
        !grounded(n.label, citation.slice(...n.span)) ||
        (n.detail && !grounded(n.detail, citation.slice(...n.span))) ||
        (n.value && !grounded(n.value, citation.slice(...n.span))),
    )
  )
    return false;
  const refs = [
    diagram.answerNodeId,
    ...Object.values(diagram.optionNodeMap ?? {}),
    ...(diagram.focusNodeIds ?? []),
    ...diagram.nodes.map((n) => n.parentId),
  ].filter((value): value is string => !!value);
  if (refs.some((ref) => !ids.has(ref))) return false;
  if (
    diagram.edges?.some((edge) => !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to)
  )
    return false;
  if (diagram.type !== 'CAUSE' && diagram.edges?.some((edge) => edge.loop)) return false;
  if (diagram.type === 'FLOW' || diagram.type === 'CAUSE') {
    const indices = new Map(diagram.nodes.map((n, index) => [n.id, index]));
    if (
      diagram.edges?.some((edge) => !edge.loop && indices.get(edge.from)! >= indices.get(edge.to)!)
    )
      return false;
  }
  if (diagram.type === 'COMPARE') {
    if (!diagram.columns || !diagram.rows) return false;
    if (new Set(diagram.rows.map((r) => r.id)).size !== diagram.rows.length) return false;
    if (
      diagram.rows.some(
        (row) =>
          row.cells.length !== diagram.columns!.length ||
          row.cells.some((cell) => {
            const n = diagram.nodes.find((n) => n.id === cell.nodeId);
            return !n || !grounded(cell.text, citation.slice(...n.span));
          }),
      )
    )
      return false;
  }
  if (diagram.type === 'GRAPH') {
    if (!diagram.graph) return false;
    const { samples, marks } = diagram.graph;
    if (samples.some((point, index) => index > 0 && point[0] <= samples[index - 1][0]))
      return false;
    if (
      marks.some(
        (mark) =>
          (mark.nodeId && !ids.has(mark.nodeId)) ||
          (mark.kind === 'tangent' && mark.slope === undefined),
      )
    )
      return false;
  }
  if (diagram.type === 'TREE') {
    const parents = new Map(diagram.nodes.map((n) => [n.id, n.parentId]));
    // Edges may supply parent links; reject conflicting parents and directed cycles.
    for (const edge of diagram.edges ?? []) {
      if (edge.loop || (parents.get(edge.to) && parents.get(edge.to) !== edge.from)) return false;
      parents.set(edge.to, edge.from);
    }
    for (const n of diagram.nodes) {
      const seen = new Set<string>();
      let at: string | undefined = n.id;
      while (at) {
        if (seen.has(at) || seen.size >= 3) return false;
        seen.add(at);
        at = parents.get(at);
      }
    }
  }
  return true;
}

/** Invalid envelopes are rejected; unsafe diagrams preserve the existing text journey. */
export function validateExplanation(input: unknown): LearningExplanation | null {
  const parsed = explanationSchema.safeParse(input);
  if (!parsed.success) return null;
  const { diagram: rawDiagram, microChecks: rawChecks, ...base } = parsed.data;
  const parsedDiagram = diagramSchema.safeParse(rawDiagram);
  if (
    base.status === 'TEXT' ||
    !parsedDiagram.success ||
    !validDiagram(parsedDiagram.data, base.citation)
  ) {
    return { ...base, status: 'TEXT', microChecks: [], source: 'text' };
  }
  const diagram = parsedDiagram.data;
  const ids = new Set(diagram.nodes.map((n) => n.id));
  const checkIds = new Set<string>();
  const microChecks = rawChecks.flatMap((raw) => {
    const check = microSchema.safeParse(raw);
    if (
      !check.success ||
      checkIds.has(check.data.id) ||
      !ids.has(check.data.nodeId) ||
      !validSourceSpan(base.citation, check.data.span) ||
      !grounded(check.data.options[check.data.answer], base.citation.slice(...check.data.span)) ||
      check.data.options[0] === check.data.options[1]
    )
      return [];
    checkIds.add(check.data.id);
    return [check.data];
  });
  return { ...base, diagram, microChecks };
}

/** Remove answers before constructing DOM, including captions and accessibility text. */
export function diagramPresentation(
  diagram: LearningDiagram,
  maskedNodeIds: string[] = [],
  revealed = false,
) {
  const unknownMask = maskedNodeIds.some((id) => !diagram.nodes.some((n) => n.id === id));
  // A stale card must never accidentally reveal every answer because its IDs changed.
  const maskedIds = new Set(
    revealed ? [] : unknownMask ? diagram.nodes.map((n) => n.id) : maskedNodeIds,
  );
  const isMasked = maskedIds.size > 0;
  if (!isMasked) return { diagram, maskedIds, isMasked };
  const hiddenTerms = diagram.nodes
    .filter((n) => maskedIds.has(n.id))
    .map((n) => n.label)
    .sort((a, b) => b.length - a.length);
  const redact = (value: string | undefined) =>
    value === undefined
      ? undefined
      : hiddenTerms.reduce((result, term) => result.split(term).join('가린 내용'), value);
  const safe: LearningDiagram = {
    ...diagram,
    title: '가린 개념을 떠올려 보세요',
    nodes: diagram.nodes.map((n) =>
      maskedIds.has(n.id)
        ? { id: n.id, label: '가린 내용', span: [0, 0], parentId: n.parentId }
        : {
            ...n,
            label: redact(n.label)!,
            detail: redact(n.detail),
            value: redact(n.value),
            group: redact(n.group),
          },
    ),
    columns: diagram.columns?.map((_, index) => `비교 ${index + 1}`),
    rows: diagram.rows?.map((row, index) => ({
      ...row,
      label: `항목 ${index + 1}`,
      cells: row.cells.map((cell) =>
        maskedIds.has(cell.nodeId)
          ? { ...cell, text: '가린 내용' }
          : { ...cell, text: redact(cell.text)! },
      ),
    })),
    edges: diagram.edges?.map(({ label: _label, ...edge }) => edge),
    graph: undefined,
  };
  return { diagram: safe, maskedIds, isMasked };
}

/** A comparison's repeated target names provide context, not separate study steps. */
export function diagramStepNodes(diagram: LearningDiagram) {
  if (
    diagram.type !== 'COMPARE' ||
    !diagram.rows?.length ||
    !diagram.rows.every((row) => row.label.trim() === row.cells[0]?.text.trim())
  ) {
    return diagram.nodes;
  }
  const evidenceIds = new Set(
    diagram.rows.flatMap((row) => row.cells.slice(1).map((cell) => cell.nodeId)),
  );
  const evidence = diagram.nodes.filter((node) => evidenceIds.has(node.id));
  return evidence.length ? evidence : diagram.nodes;
}
