package learning

// GenerationSchema is optional within a question. Unsupported structures should be null. It is
// generated with the original question, never in a second blocking request or on explanation GET.
func GenerationSchema() map[string]any {
	str := map[string]any{"type": "string"}
	num := map[string]any{"type": "number"}
	integer := map[string]any{"type": "integer"}
	arr := func(item map[string]any, min, max int) map[string]any {
		return map[string]any{"type": "array", "items": item, "minItems": min, "maxItems": max}
	}
	obj := func(p map[string]any, required ...string) map[string]any {
		return map[string]any{"type": "object", "properties": p, "required": required, "additionalProperties": false}
	}
	pair := arr(integer, 2, 2)
	node := obj(map[string]any{"id": str, "label": str, "span": pair, "detail": str, "group": str, "value": str, "parentId": str}, "id", "label", "span")
	edge := obj(map[string]any{"from": str, "to": str, "label": str, "loop": map[string]any{"type": "boolean"}}, "from", "to")
	cell := obj(map[string]any{"text": str, "nodeId": str}, "text", "nodeId")
	row := obj(map[string]any{"id": str, "label": str, "cells": arr(cell, 2, 3)}, "id", "label", "cells")
	mark := obj(map[string]any{"kind": map[string]any{"type": "string", "enum": []string{"point", "tangent"}}, "x": num, "y": num, "label": str, "nodeId": str, "slope": num}, "kind", "x", "y", "label")
	graph := obj(map[string]any{"expression": str, "samples": arr(arr(num, 2, 2), 2, 200), "marks": arr(mark, 0, 8)}, "expression", "samples", "marks")
	diagram := obj(map[string]any{"id": str, "type": map[string]any{"type": "string", "enum": []string{"FLOW", "COMPARE", "CAUSE", "TIMELINE", "GRAPH", "TREE"}}, "title": str, "nodes": arr(node, 2, 12), "edges": arr(edge, 0, 16), "columns": arr(str, 2, 3), "rows": arr(row, 1, 6), "graph": graph, "answerNodeId": str, "focusNodeIds": arr(str, 0, 12)}, "id", "type", "title", "nodes")
	check := obj(map[string]any{"id": str, "nodeId": str, "prompt": str, "options": arr(str, 2, 2), "answer": map[string]any{"type": "integer", "minimum": 0, "maximum": 1}, "explanation": str, "span": pair}, "id", "nodeId", "prompt", "options", "answer", "explanation", "span")
	metadata := obj(map[string]any{"citation": str, "diagram": diagram, "microChecks": arr(check, 0, 3)}, "citation", "diagram", "microChecks")
	return map[string]any{"anyOf": []any{metadata, map[string]any{"type": "null"}}}
}
