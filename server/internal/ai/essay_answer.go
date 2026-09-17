package ai

import "strings"

// Marking spans inside a complete answer preserves Korean particles and word
// boundaries. Generating keywords separately can silently change their meaning.
// Spans may be natural predicates as well as noun phrases; the resolver never
// rewrites the surrounding prose to fit a keyword's grammatical form.
func essayAnswerSchema() map[string]any {
	return object(map[string]any{
		"prompt": str(5, 2000), "distractors": arrayOf(str(1, 100), 4, 4),
		"annotatedAnswer": str(36, 4016), "citation": str(8, 4000),
	}, "prompt", "distractors", "annotatedAnswer", "citation")
}

func resolveEssayAnswer(raw any) (any, error) {
	root, ok := raw.(map[string]any)
	if !ok {
		return nil, errItemShape
	}
	items, ok := root["items"].([]any)
	if !ok {
		return nil, errItemShape
	}
	result := make([]any, 0, len(items))
	for _, value := range items {
		item, ok := value.(map[string]any)
		if !ok {
			return nil, errItemShape
		}
		annotated, ok := item["annotatedAnswer"].(string)
		if !ok || !within(annotated, 36, 4016) {
			return nil, errItemShape
		}
		var answer strings.Builder
		keywords := make([]any, 0, 4)
		for {
			start := strings.Index(annotated, "[[")
			if start < 0 {
				break
			}
			prefix := annotated[:start]
			if strings.Contains(prefix, "]]") {
				return nil, errItemShape
			}
			answer.WriteString(prefix)
			annotated = annotated[start+2:]
			end := strings.Index(annotated, "]]")
			if end < 0 {
				return nil, errItemShape
			}
			keyword := annotated[:end]
			if !within(keyword, 1, 24) || strings.Contains(keyword, "[[") || strings.Join(strings.Fields(keyword), " ") != keyword {
				return nil, errItemShape
			}
			keywords = append(keywords, keyword)
			answer.WriteString(keyword)
			annotated = annotated[end+2:]
		}
		if len(keywords) != 4 || strings.Contains(annotated, "]]") {
			return nil, errItemShape
		}
		answer.WriteString(annotated)
		copy := map[string]any{}
		for k, v := range item {
			if k != "annotatedAnswer" {
				copy[k] = v
			}
		}
		copy["modelAnswer"], copy["keywords"] = answer.String(), keywords
		result = append(result, copy)
	}
	return map[string]any{"items": result}, nil
}
