package pdfx

import (
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/text/unicode/norm"
)

func piece(str string, x, y float64, width float64, size float64) Piece {
	return Piece{Str: str, X: x, Y: y, Width: width, Size: size}
}

func line(text string, y float64, x, right, size float64) Line {
	return Line{Text: text, X: x, Right: right, Y: y, Size: size}
}

func texts(lines []Line) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = l.Text
	}
	return out
}

func blockTexts(blocks []Block) []string {
	out := make([]string, len(blocks))
	for i, b := range blocks {
		out[i] = b.Text
	}
	return out
}

func TestLines(t *testing.T) {
	// pieces on one baseline become one line: word gaps are single spaces, glyph runs stay together, never tabs
	lines := ToLines([]Piece{
		piece("학습", 50, 100, 20, 10),
		piece("자료", 72, 100, 20, 10), // 2pt gap: the same word
		piece("정리", 97, 100, 20, 10), // 5pt gap at size 10: a word gap
		piece("\t끝", 300, 100, 20, 10),
		piece("다음 줄", 50, 114, 40, 10),
	})
	if got, want := texts(lines), []string{"학습자료 정리 끝", "다음 줄"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("lines = %q, want %q", got, want)
	}
	for _, l := range lines {
		if strings.Contains(l.Text, "\t") {
			t.Fatalf("tab survived in %q", l.Text)
		}
	}
	// Decomposed jamo (NFD) are stored composed (NFC), so search and citations match.
	if got := ToLines([]Piece{piece(norm.NFD.String("한글"), 0, 10, 20, 10)})[0].Text; got != "한글" {
		t.Fatalf("NFD piece = %q, want 한글", got)
	}
	// Control characters become spaces, zero-width characters vanish, NBSP and ideographic spaces collapse.
	if got := ToLines([]Piece{piece("가"+string(rune(0x0007))+"나"+string(rune(0x200b))+"다"+string(rune(0x00a0))+string(rune(0x3000))+"라", 0, 10, 40, 10)})[0].Text; got != "가 나다 라" {
		t.Fatalf("cleaned piece = %q, want %q", got, "가 나다 라")
	}
	// A piece starting or ending with whitespace never gets a second space; an empty piece is dropped.
	if got := texts(ToLines([]Piece{piece("가 ", 0, 10, 20, 10), piece("나", 30, 10, 10, 10), piece("", 50, 10, 0, 10)})); !reflect.DeepEqual(got, []string{"가 나"}) {
		t.Fatalf("whitespace pieces = %q", got)
	}
	// Line metrics: x is the first non-blank piece, right the furthest extent, size the largest piece,
	// y the leftmost piece's baseline (the row is sorted by x first, as in the TypeScript).
	single := ToLines([]Piece{piece(" ", 10, 20, 5, 8), piece("본문", 40, 21, 20, 12), piece("작게", 70, 19, 10, 6)})
	if len(single) != 1 || single[0].X != 40 || single[0].Right != 80 || single[0].Size != 12 || single[0].Y != 20 {
		t.Fatalf("line metrics = %+v", single)
	}
}

func TestParagraphs(t *testing.T) {
	// soft-wrapped lines rejoin; spacing, a short line, a list marker or a size change start a new paragraph
	blocks := ToParagraphs([]Line{
		line("광합성은 빛에너지를 이용해 이산화 탄소와 물로 포도당을 만드는", 100, 50, 500, 10),
		line("과정이다. 이 과정은 엽록체에서 일어난다.", 114, 50, 300, 10),
		line("명반응은 틸라코이드 막에서 일어난다.", 128, 50, 500, 10),
		line("캘빈 회로는 스트로마에서 일어난다.", 150, 50, 500, 10),
		line("○ 명반응: 빛이 필요하다", 164, 50, 500, 10),
		line("○ 캘빈 회로: 빛이 직접 필요하지 않다", 178, 50, 500, 10),
		line("II. 호흡", 198, 50, 120, 14),
	}, nil)
	want := []string{
		"광합성은 빛에너지를 이용해 이산화 탄소와 물로 포도당을 만드는 과정이다. 이 과정은 엽록체에서 일어난다.",
		"명반응은 틸라코이드 막에서 일어난다.",
		"캘빈 회로는 스트로마에서 일어난다.",
		"○ 명반응: 빛이 필요하다",
		"○ 캘빈 회로: 빛이 직접 필요하지 않다",
		"II. 호흡",
	}
	if got := blockTexts(blocks); !reflect.DeepEqual(got, want) {
		t.Fatalf("blocks = %q, want %q", got, want)
	}
	// Latin hyphenation rejoins.
	if got := ToParagraphs([]Line{line("the photosyn-", 10, 50, 500, 10), line("thesis step", 24, 50, 200, 10)}, nil)[0].Text; got != "the photosynthesis step" {
		t.Fatalf("hyphenation = %q", got)
	}
	// Block spans: top is the first baseline minus its size, bottom the last baseline.
	if blocks[0].Top != 90 || blocks[0].Bottom != 114 {
		t.Fatalf("span = %v..%v", blocks[0].Top, blocks[0].Bottom)
	}
	if ToParagraphs(nil, nil) != nil {
		t.Fatal("no lines should give no blocks")
	}
	// A sentence end followed by an indented line starts a paragraph; without the indent it wraps.
	indented := ToParagraphs([]Line{line("첫 문장이다.", 10, 50, 500, 10), line("들여쓴 둘째 문장", 24, 62, 500, 10)}, nil)
	if len(indented) != 2 {
		t.Fatalf("indented = %q", blockTexts(indented))
	}
	flush := ToParagraphs([]Line{line("첫 문장이다.", 10, 50, 500, 10), line("둘째 문장", 24, 50, 500, 10)}, nil)
	if len(flush) != 1 {
		t.Fatalf("flush = %q", blockTexts(flush))
	}
	// Every list marker family opens a paragraph.
	for _, marker := range []string{"• 항목", "ㅇ 항목", "1. 항목", "12) 항목", "(3) 항목", "③ 항목", "가. 항목", "(나) 항목", "IV. 항목", "b) 항목", "- 항목", "※ 항목"} {
		got := ToParagraphs([]Line{line("앞 줄 본문 내용", 10, 50, 500, 10), line(marker, 24, 50, 500, 10)}, nil)
		if len(got) != 2 {
			t.Errorf("%q did not start a paragraph: %q", marker, blockTexts(got))
		}
	}
	for _, plain := range []string{"123. 항목", "가나. 항목", "x 항목", "IVXL. 항목"} {
		got := ToParagraphs([]Line{line("앞 줄 본문 내용", 10, 50, 500, 10), line(plain, 24, 50, 500, 10)}, nil)
		if len(got) != 1 {
			t.Errorf("%q started a paragraph: %q", plain, blockTexts(got))
		}
	}
}

func TestWrapJoin(t *testing.T) {
	// a wrap that split a Korean word rejoins; a real word boundary keeps its space
	cases := []struct {
		before, after string
		lexicon       Lexicon
		want          string
		reason        string
	}{
		{"함께 제공하는 프", "로그램이다.", nil, "", "a lone syllable that is not a word"},
		{"시제품을 시험", "하며, 마지막", nil, "", "an ending never starts a word"},
		{"기업의 서비스", "를 제공한다", nil, "", "a particle never starts a word"},
		{"현장 전문", "가들과 협업", Lexicon{"전문가": {}, "전문가의": {}}, "", "the document spells the word elsewhere"},
		{"선도하는 기업이", "배출되기 위해", nil, " ", "a word ending with a particle"},
		{"자료를 볼 수", "있다", nil, " ", "a one-syllable word of its own"},
		{"photosynthesis", "happens", nil, " ", "Latin words keep their space"},
		{"끝에 공백 ", "이어짐", nil, " ", "trailing whitespace is a boundary"},
		{"앞말", " 이어짐", nil, " ", "leading whitespace is a boundary"},
		{"가나다", "에서", nil, "", "a particle at the very end"},
		{"가나다", "에서.", nil, "", "a particle followed by punctuation"},
		{"가나다", "에서는", nil, " ", "a particle followed by more syllables is a word"},
		{"가나다 전문", "가", Lexicon{"전문가": {}}, "", "joined form in the lexicon"},
		{"가나다 전", "문가", Lexicon{"전문가": {}}, "", "lexicon prefix of the stem"},
		{"가나다 기", "업이다", Lexicon{"기타": {}}, "", "a lone syllable not in the lone-word list"},
		{"가나다 전", "문가", Lexicon{"전기": {}}, " ", "전 is in the lone-word list"},
		{"가나다 수", "업이다", Lexicon{}, " ", "수 is a word of its own"},
	}
	for _, c := range cases {
		if got := WrapJoin(c.before, c.after, c.lexicon); got != c.want {
			t.Errorf("WrapJoin(%q, %q) = %q, want %q: %s", c.before, c.after, got, c.want, c.reason)
		}
	}
	got := LexiconOf([]Line{line("전문가의 의견과 전문가", 10, 50, 500, 10)})
	keys := make([]string, 0, len(got))
	for k := range got {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if want := []string{"의견과", "전문가", "전문가의"}; !reflect.DeepEqual(keys, want) {
		t.Fatalf("lexicon = %q, want %q", keys, want)
	}
	// Punctuation is stripped from words and single syllables are not words.
	single := LexiconOf([]Line{line("(전문가) 수, 있다.", 10, 50, 500, 10)})
	if _, ok := single["전문가"]; !ok || len(single) != 2 {
		t.Fatalf("lexicon with punctuation = %v", single)
	}
}

func TestTidy(t *testing.T) {
	// table-of-contents leaders become "title (N쪽)"
	cases := map[string]string{
		"I. 공모 개요 ........................ 1": "I. 공모 개요 (1쪽)",
		"Ⅲ. 제안 요청내용 · · · · · · 4":            "Ⅲ. 제안 요청내용 (4쪽)",
		"비용은 3.5 정도":                          "비용은 3.5 정도",
		"목차 ……… 12":                           "목차 (12쪽)",
		"목차 …… 12":                            "목차 …… 12",
		"두 개 .. 3":                            "두 개 .. 3",
		"다섯 자리 ..... 12345":                   "다섯 자리 ..... 12345",
		"점 뒤 공백 없음...7":                       "점 뒤 공백 없음 (7쪽)",
	}
	for in, want := range cases {
		if got := TidyLine(in); got != want {
			t.Errorf("TidyLine(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFurniture(t *testing.T) {
	// running headers, footers and bare page numbers are dropped; body text near the edge stays
	page := func(n int, extra ...Line) PageLayout {
		lines := []Line{
			line("기후테크 창업가 육성사업", 40, 50, 500, 10),
			line("본문 "+itoa(n)+"쪽 내용입니다", 300, 50, 500, 10),
			line("- "+itoa(n)+" -", 780, 50, 500, 10),
		}
		return PageLayout{Width: 600, Height: 800, Lines: append(lines, extra...)}
	}
	pages := DropFurniture([]PageLayout{page(1, line("첫 쪽에만 있는 위쪽 줄", 60, 50, 500, 10)), page(2), page(3), page(4)})
	if got, want := texts(pages[0].Lines), []string{"본문 1쪽 내용입니다", "첫 쪽에만 있는 위쪽 줄"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("page 1 = %q, want %q", got, want)
	}
	for _, p := range pages[1:] {
		if len(p.Lines) != 1 {
			t.Fatalf("page kept %q", texts(p.Lines))
		}
	}
	// Two pages are too few to call a line a running header, but a bare page number is always furniture.
	short := DropFurniture([]PageLayout{page(1), page(2)})
	header := 0
	for _, l := range short[0].Lines {
		if strings.Contains(l.Text, "육성사업") {
			header++
		}
	}
	if header != 1 {
		t.Fatalf("header dropped on a short document: %q", texts(short[0].Lines))
	}
	bare := regexp.MustCompile(`^- \d -$`)
	for _, p := range short {
		for _, l := range p.Lines {
			if bare.MatchString(l.Text) {
				t.Fatalf("page number kept: %q", l.Text)
			}
		}
	}
	// Page-number shapes: every form goes, other short lines in the band stay.
	for _, number := range []string{"7", "- 7 -", "– 7", "7 –", "3 / 12", "Page 4", "p. 4", "12 쪽", "12쪽", "PAGE 9"} {
		got := DropFurniture([]PageLayout{{Width: 600, Height: 800, Lines: []Line{line(number, 790, 50, 500, 10)}}})
		if len(got[0].Lines) != 0 {
			t.Errorf("%q kept", number)
		}
	}
	for _, other := range []string{"12345", "7장", "제 7 절", "3 / 12 / 2", "page"} {
		got := DropFurniture([]PageLayout{{Width: 600, Height: 800, Lines: []Line{line(other, 790, 50, 500, 10)}}})
		if len(got[0].Lines) != 1 {
			t.Errorf("%q dropped", other)
		}
	}
	// A page number in the body band is not furniture.
	body := DropFurniture([]PageLayout{{Width: 600, Height: 800, Lines: []Line{line("7", 400, 50, 500, 10)}}})
	if len(body[0].Lines) != 1 {
		t.Fatal("body number dropped")
	}
}

func itoa(n int) string {
	return strconv.Itoa(n)
}

func TestAssemble(t *testing.T) {
	// assembled text records where every page and paragraph starts
	assembled := Assemble([][]Block{
		{{Text: "첫 쪽 문단", Top: 10, Bottom: 20}},
		{},
		{{Text: "셋째 쪽 첫 문단", Top: 10, Bottom: 20}, {Text: "둘째 문단", Top: 40, Bottom: 50}},
	})
	if assembled.Text != "첫 쪽 문단\n\n셋째 쪽 첫 문단\n\n둘째 문단" {
		t.Fatalf("text = %q", assembled.Text)
	}
	if !reflect.DeepEqual(assembled.PageBreaks, []int{0, 6, 8}) {
		t.Fatalf("pageBreaks = %v", assembled.PageBreaks)
	}
	if !strings.HasPrefix(sliceUTF16(assembled.Text, assembled.PageBreaks[2], 1<<30), "셋째 쪽") {
		t.Fatal("page 3 does not start at its break")
	}
	var got [][2]any
	for _, p := range assembled.Paragraphs {
		got = append(got, [2]any{p.Page, sliceUTF16(assembled.Text, p.Start, p.End)})
	}
	if want := [][2]any{{1, "첫 쪽 문단"}, {3, "셋째 쪽 첫 문단"}, {3, "둘째 문단"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("paragraphs = %v, want %v", got, want)
	}
	// Offsets count UTF-16 code units: an astral character is two.
	astral := Assemble([][]Block{{{Text: "😀a"}}, {{Text: "b"}}})
	if !reflect.DeepEqual(astral.PageBreaks, []int{0, 5}) || astral.Paragraphs[0].End != 3 {
		t.Fatalf("astral offsets = %v %v", astral.PageBreaks, astral.Paragraphs[0].End)
	}
}

func placement(page int, y float64, over func(*Placement)) Placement {
	p := Placement{Page: page, Order: 0, Box: Box{X: 0.1, Y: y, W: 0.5, H: 0.2}, Width: 400, Height: 200, Hash: "h-" + itoa(page) + "-" + strconv.FormatFloat(y, 'f', -1, 64)}
	if over != nil {
		over(&p)
	}
	return p
}

func TestKeepImages(t *testing.T) {
	// content images are kept; tiny icons, full-page backgrounds and logos on most pages are not
	kept := KeepImages([]Placement{
		placement(1, 0.3, nil),
		placement(1, 0.5, func(p *Placement) { p.Width, p.Height, p.Hash = 16, 16, "icon" }),
		placement(2, 0.1, func(p *Placement) { p.Box, p.Hash = Box{X: 0, Y: 0, W: 1, H: 1}, "background" }),
		placement(1, 0.02, func(p *Placement) { p.Hash = "logo" }),
		placement(2, 0.02, func(p *Placement) { p.Hash = "logo" }),
		placement(3, 0.02, func(p *Placement) { p.Hash = "logo" }),
		placement(3, 0.4, func(p *Placement) { p.Box = Box{X: 0.1, Y: 0.4, W: 0.05, H: 0.05} }),
	}, 4)
	var hashes []string
	for _, p := range kept {
		hashes = append(hashes, p.Hash)
	}
	if !reflect.DeepEqual(hashes, []string{"h-1-0.3"}) {
		t.Fatalf("kept = %q", hashes)
	}
	// The repeat rule needs three pages and half the document; the same image twice on one page is fine.
	twice := KeepImages([]Placement{
		placement(1, 0.3, func(p *Placement) { p.Hash = "same" }),
		placement(1, 0.6, func(p *Placement) { p.Hash = "same"; p.Order = 1 }),
		placement(2, 0.3, func(p *Placement) { p.Hash = "same" }),
	}, 2)
	if len(twice) != 3 {
		t.Fatalf("repeat rule fired on two pages: %d kept", len(twice))
	}
	spread := KeepImages([]Placement{
		placement(1, 0.3, func(p *Placement) { p.Hash = "same" }),
		placement(2, 0.3, func(p *Placement) { p.Hash = "same" }),
		placement(3, 0.3, func(p *Placement) { p.Hash = "same" }),
	}, 10)
	if len(spread) != 3 {
		t.Fatalf("three of ten pages is not most pages: %d kept", len(spread))
	}
	// The minimum side is 48 pixels and the area window is 1%..85% of the page.
	edge := KeepImages([]Placement{
		placement(1, 0.3, func(p *Placement) { p.Width, p.Height = 48, 400 }),
		placement(1, 0.3, func(p *Placement) { p.Width, p.Height = 47, 400 }),
		placement(1, 0.3, func(p *Placement) { p.Box = Box{W: 0.1, H: 0.1} }),
		placement(1, 0.3, func(p *Placement) { p.Box = Box{W: 0.1, H: 0.099} }),
		placement(1, 0.3, func(p *Placement) { p.Box = Box{W: 0.85, H: 1} }),
		placement(1, 0.3, func(p *Placement) { p.Box = Box{W: 0.86, H: 1} }),
	}, 1)
	if len(edge) != 3 {
		t.Fatalf("edge cases: %d kept", len(edge))
	}
}

func TestPlaceImages(t *testing.T) {
	// an image follows the paragraph above it on its page, or opens the page when nothing is above
	assembled := Assemble([][]Block{
		{{Text: "첫 쪽 위 문단", Top: 100, Bottom: 120}, {Text: "첫 쪽 아래 문단", Top: 500, Bottom: 520}},
		{{Text: "둘째 쪽 문단", Top: 400, Bottom: 420}},
	})
	placed := PlaceImages([]Placement{placement(1, 0.3, nil), placement(2, 0.1, nil)}, assembled, []float64{1000, 1000})
	middle, top := placed[0], placed[1]
	if middle.Paragraph != 0 || middle.Anchor != assembled.Paragraphs[0].End || middle.Context != "첫 쪽 위 문단" {
		t.Fatalf("middle = %+v", middle)
	}
	if top.Paragraph != 1 {
		t.Fatalf("top.Paragraph = %d, want the last paragraph before its page", top.Paragraph)
	}
	if top.Anchor != assembled.PageBreaks[1] {
		t.Fatalf("top.Anchor = %d, want the start of page 2 (%d)", top.Anchor, assembled.PageBreaks[1])
	}
	if top.Context != "첫 쪽 아래 문단" {
		t.Fatalf("top.Context = %q", top.Context)
	}
	// Before any text: paragraph -1, anchor at the page start, empty context.
	first := PlaceImages([]Placement{placement(1, 0.05, nil)}, assembled, []float64{1000, 1000})[0]
	if first.Paragraph != -1 || first.Anchor != 0 || first.Context != "" {
		t.Fatalf("first = %+v", first)
	}
	// Context is the first 60 UTF-16 units of the paragraph.
	long := strings.Repeat("가", 70)
	ctx := PlaceImages([]Placement{placement(1, 0.9, nil)}, Assemble([][]Block{{{Text: long, Top: 0, Bottom: 10}}}), []float64{1000})[0].Context
	if ctx != strings.Repeat("가", 60) {
		t.Fatalf("context length = %d", len([]rune(ctx)))
	}
	// A page beyond the assembled pages anchors at the end of the text.
	beyond := PlaceImages([]Placement{placement(5, 0.5, nil)}, assembled, []float64{1000, 1000})[0]
	if beyond.Anchor != utf16Len(assembled.Text) || beyond.Paragraph != 2 {
		t.Fatalf("beyond = %+v", beyond)
	}
}

func TestBoundStart(t *testing.T) {
	for _, s := range []string{"를", "를 제공", "에서.", "입니다", "적인)", "들의”"} {
		if !boundStart(s) {
			t.Errorf("%q should be a bound start", s)
		}
	}
	for _, s := range []string{"를르", "에서는", "적인데", "가나", "", "abc"} {
		if boundStart(s) {
			t.Errorf("%q should not be a bound start", s)
		}
	}
}

func TestUTF16(t *testing.T) {
	if utf16Len("a한😀") != 4 {
		t.Fatal("utf16Len")
	}
	if sliceUTF16("a한😀b", 1, 4) != "한😀" || sliceUTF16("abc", 5, 9) != "" {
		t.Fatal("sliceUTF16")
	}
	if clean(string(rune(0x00ad))+"가"+string(rune(0xfeff))+"나"+string(rune(0x200c))) != "가나" || clean("a\x7fb\x1f") != "a b " {
		t.Fatal("clean")
	}
}
