package ai

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// Source IDs let the model select evidence without retyping scientific symbols.
// Blocks are lossless contiguous slices, never summaries or repaired equations.
type evidenceBlock struct{ id, text string }

func evidenceBlocks(source string) []evidenceBlock {
	var blocks []evidenceBlock
	for source != "" {
		end, runes, sentence, space := 0, 0, 0, 0
		for end < len(source) && runes < 1200 {
			r, size := utf8.DecodeRuneInString(source[end:])
			end += size
			runes++
			if r == ' ' || r == '\n' || r == '\t' {
				space = end
			}
			// Keep paragraphs separate even when short. Previously a paragraph
			// only counted as a boundary after 700 runes, pulling diagrams and
			// unrelated neighbouring prose into the same selectable evidence.
			if strings.HasSuffix(source[:end], "\n\n") {
				break
			}
			if strings.HasSuffix(source[:end], ". ") || strings.HasSuffix(source[:end], ".\n") || strings.HasSuffix(source[:end], "。") {
				sentence = end
			}
			if runes >= 700 && sentence > 0 {
				end = sentence
				break
			}
		}
		if runes == 1200 && end < len(source) && space > 0 {
			end = space
		}
		blocks = append(blocks, evidenceBlock{fmt.Sprintf("s%d", len(blocks)), source[:end]})
		source = source[end:]
	}
	return blocks
}

func evidenceInput(blocks []evidenceBlock) string {
	var b strings.Builder
	for _, block := range blocks {
		fmt.Fprintf(&b, "\n<evidence id=%q>\n%s\n</evidence>\n", block.id, block.text)
	}
	return b.String()
}

func evidenceSchema(original map[string]any, blocks []evidenceBlock) map[string]any {
	props := map[string]any{}
	for k, v := range original["properties"].(map[string]any) {
		if k != "citation" {
			props[k] = v
		}
	}
	ids := make([]any, 0, len(blocks))
	for _, block := range blocks {
		ids = append(ids, block.id)
	}
	// Constrain references to actual source blocks at decoding time as well as
	// validating them afterwards. A short source often has only s0, not s1..s3.
	props["citationIds"] = arrayOf(map[string]any{"type": "string", "enum": ids}, 1, min(3, len(blocks)))
	var required []string
	for _, key := range original["required"].([]any) {
		if key != "citation" {
			required = append(required, key.(string))
		}
	}
	required = append(required, "citationIds")
	return object(props, required...)
}

func resolveEvidence(raw any, blocks []evidenceBlock) (any, error) {
	root, ok := raw.(map[string]any)
	if !ok {
		return nil, errItemShape
	}
	items, ok := root["items"].([]any)
	if !ok {
		return nil, errItemShape
	}
	indices := map[string]int{}
	for i, block := range blocks {
		indices[block.id] = i
	}
	resolved := make([]any, 0, len(items))
	for _, value := range items {
		item, ok := value.(map[string]any)
		if !ok {
			return nil, errItemShape
		}
		refs, ok := item["citationIds"].([]any)
		if !ok || len(refs) < 1 || len(refs) > 3 {
			return nil, errCitation
		}
		var quote strings.Builder
		previous := -1
		for n, ref := range refs {
			id, ok := ref.(string)
			if !ok {
				return nil, errCitation
			}
			index, ok := indices[id]
			if !ok || (n > 0 && index != previous+1) {
				return nil, errCitation
			}
			quote.WriteString(blocks[index].text)
			previous = index
		}
		citation := strings.TrimSpace(quote.String())
		if !within(citation, 8, 4000) {
			return nil, errCitation
		}
		copy := map[string]any{}
		for k, v := range item {
			if k != "citationIds" {
				copy[k] = v
			}
		}
		copy["citation"] = citation
		resolved = append(resolved, copy)
	}
	return map[string]any{"items": resolved}, nil
}
