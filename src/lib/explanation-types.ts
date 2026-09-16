/** Source spans use JavaScript UTF-16 offsets into LearningExplanation.citation. */
export type ExplanationDepth = 'SHORT' | 'FULL';
export type MicroResult = 'PASS' | 'FAIL' | 'SKIP';
export type DiagramType = 'FLOW' | 'COMPARE' | 'CAUSE' | 'TIMELINE' | 'GRAPH' | 'TREE';
export type SourceSpan = [number, number];
export interface LearningNode {
  id: string;
  label: string;
  span: SourceSpan;
  detail?: string;
  group?: string;
  value?: string;
  parentId?: string;
}
export interface LearningDiagram {
  id: string;
  type: DiagramType;
  title: string;
  nodes: LearningNode[];
  edges?: { from: string; to: string; label?: string; loop?: boolean }[];
  columns?: string[];
  rows?: { id: string; label: string; cells: { text: string; nodeId: string }[] }[];
  graph?: {
    expression: string;
    samples: [number, number][];
    marks: { kind: 'point' | 'tangent'; x: number; y: number; label: string; nodeId?: string; slope?: number }[];
  };
  answerNodeId?: string;
  optionNodeMap?: Record<string, string>;
  focusNodeIds?: string[];
}
export interface MicroCheck {
  id: string;
  nodeId: string;
  prompt: string;
  options: [string, string];
  answer: 0 | 1;
  explanation: string;
  span: SourceSpan;
}
export interface LearningExplanation {
  version: 1;
  status: 'READY' | 'TEXT';
  questionId: string;
  citation: string;
  diagnosis?: string;
  optionReasons: string[];
  diagram?: LearningDiagram;
  microChecks: MicroCheck[];
  source: 'generated' | 'rule' | 'text';
  message?: string;
}
export interface LearningReflection {
  microResult?: MicroResult | null;
  beatsSeen?: number;
  responseMs?: number;
  divergenceNodeId?: string;
  explainDepth?: ExplanationDepth;
}
