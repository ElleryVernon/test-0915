package textmatch

import "testing"

// runes builds a string from code points so no invisible character has to live
// in the source: U+FEFF is illegal in Go source and the others are easy to lose.
func runes(codes ...rune) string { return string(codes) }

// The expectations below were taken from V8 (node 26): `\s`, trim() and
// normalize('NFKC') on the same inputs. The planner golden replays hasCitation
// end to end; this pins the corners where Go's own notion of whitespace differs.
func TestParityJSWhitespace(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"runs collapse and ends trim", "  a  b\t\nc \r\n", "a b c"},
		{"nbsp and ideographic space fold through NFKC", runes('a', 0x00A0, 'b', 0x3000, 'c'), "a b c"},
		{"zwnbsp is JS whitespace", runes(0xFEFF, 'a', 0xFEFF, 0xFEFF, 'b', 0xFEFF), "a b"},
		{"nel is not JS whitespace", runes('a', 0x0085, 'b'), runes('a', 0x0085, 'b')},
		{"zero width space stays", runes('a', 0x200B, 'b'), runes('a', 0x200B, 'b')},
		{"mongolian vowel separator stays", runes('a', 0x180E, 'b'), runes('a', 0x180E, 'b')},
		{"line and paragraph separators fold", runes('a', 0x2028, 'b', 0x2029, 'c'), "a b c"},
		{"ogham space mark folds", runes('a', 0x1680, 'b'), "a b"},
		// Compat jamo map to leading consonants and vowels, so only L+V pairs compose.
		{"compat jamo compose into syllables", runes(0x314E, 0x314F, 0x3134), runes(0xD558, 0x1102)},
		{"full width letters and digits", runes(0xFF21, 0xFF22, 0xFF23, 0x3000, 0xFF11, 0xFF12), "ABC 12"},
		{"only whitespace", runes(' ', '\t', 0xFEFF), ""},
	}
	for _, c := range cases {
		if got := Normalized(c.in); got != c.want {
			t.Errorf("%s: Normalized(%q) = %q, want %q", c.name, c.in, got, c.want)
		}
	}
}

func TestParityUTF16Len(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"a", 1},
		{runes(0xD55C), 1},
		{runes(0x1F600), 2},
		{runes('a', 0x1F600, 'b'), 4},
	}
	for _, c := range cases {
		if got := UTF16Len(c.in); got != c.want {
			t.Errorf("UTF16Len(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestParityHasCitationLength(t *testing.T) {
	source := "나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다."
	cases := []struct {
		citation string
		want     bool
	}{
		{"나트륨 이온이", false},                        // 7 units
		{"나트륨 이온이 세", true},                       // 8 units
		{"   나트륨 이온이   ", false},                  // padding is trimmed before measuring
		{"칼륨 이온이 세포 안으로", false},                  // not in the source
		{runes(0x1F642, 0x1F642, 0x1F642), false}, // 6 units, and not in the source
	}
	for _, c := range cases {
		if got := HasCitation(source, c.citation); got != c.want {
			t.Errorf("HasCitation(source, %q) = %v, want %v", c.citation, got, c.want)
		}
	}
	emoji := runes(0x1F642, 0x1F642, 0x1F642, 0x1F642)
	if !HasCitation(emoji+" 학습", emoji) {
		t.Errorf("four supplementary runes are 8 UTF-16 units and must pass")
	}
	if HasCitation(emoji+" 학습", runes(0x1F642, 0x1F642, 0x1F642)) {
		t.Errorf("three supplementary runes are 6 UTF-16 units and must fail")
	}
}
