package ai

import (
	"strings"
	"testing"
)

func TestEvidenceLosslessScientificText(t *testing.T) {
	source := strings.Repeat("두 단의 문장과 ∆G°′ = −16.7 kJ/mol.\n\n", 200) + "잘리면 안 되는 마지막 내용 + αβ"
	blocks := evidenceBlocks(source)
	var joined strings.Builder
	for _, block := range blocks {
		joined.WriteString(block.text)
		if length(block.text) > 1200 {
			t.Fatal("unbounded block")
		}
	}
	if joined.String() != source {
		t.Fatal("source changed")
	}
	if len(blocks) < 2 {
		t.Fatal("fixture must span multiple blocks")
	}
	item := func(ids ...any) any {
		return map[string]any{"items": []any{map[string]any{"front": "질문", "citationIds": ids}}}
	}
	good, err := resolveEvidence(item("s0", "s1"), blocks)
	if err != nil {
		t.Fatal(err)
	}
	citation := good.(map[string]any)["items"].([]any)[0].(map[string]any)["citation"].(string)
	if citation != strings.TrimSpace(blocks[0].text+blocks[1].text) {
		t.Fatal("citation was retyped")
	}
	for _, bad := range []any{item("invented"), item("s1", "s0"), item("s0", "s0"), item("s0", "s2"), item(), item(1)} {
		if _, err := resolveEvidence(bad, blocks); err == nil {
			t.Fatal("unverifiable citation accepted")
		}
	}
}

func TestEvidenceDoesNotMutateSharedSchema(t *testing.T) {
	derived := evidenceSchema(cardSchema, []evidenceBlock{{"s0", "actual source"}})
	refs := derived["properties"].(map[string]any)["citationIds"].(map[string]any)
	if refs["maxItems"] != 1 || len(refs["items"].(map[string]any)["enum"].([]any)) != 1 {
		t.Fatal("nonexistent references remain selectable")
	}
	if derived["properties"].(map[string]any)["citation"] != nil {
		t.Fatal("model still retypes citation")
	}
	if cardSchema["properties"].(map[string]any)["citation"] == nil {
		t.Fatal("shared schema mutated")
	}
	if _, err := resolveEvidence(map[string]any{"items": []any{map[string]any{"citationIds": []any{"s0", "s1", "s2"}}}}, []evidenceBlock{{"s0", strings.Repeat("a", 1400)}, {"s1", strings.Repeat("a", 1400)}, {"s2", strings.Repeat("a", 1400)}}); err == nil {
		t.Fatal("citation over 4000 accepted")
	}
}

func TestEvidenceParagraphAndSentenceBoundaries(t *testing.T) {
	first := "Competitive inhibitors bind to the active site.\n\n"
	figure := "E S ES E P\n\n"
	caption := "FIGURE 6–15 Three types of reversible inhibition."
	blocks := evidenceBlocks(first + figure + caption)
	if len(blocks) != 3 || blocks[0].text != first || blocks[1].text != figure || blocks[2].text != caption {
		t.Fatalf("separate prose and figure fragments: %#v", blocks)
	}
	long := strings.Repeat("A complete scientific sentence with ΔG°′ and Vmax. ", 35)
	blocks = evidenceBlocks(long)
	var rebuilt strings.Builder
	for i, block := range blocks {
		rebuilt.WriteString(block.text)
		if i < len(blocks)-1 && !strings.HasSuffix(block.text, ". ") {
			t.Fatal("cut a sentence where a boundary was available")
		}
	}
	if rebuilt.String() != long {
		t.Fatal("source modified")
	}
}
