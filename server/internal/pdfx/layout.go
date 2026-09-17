// Package pdfx turns a PDF into learning text: paragraphs without page markers, tabs, TOC leaders,
// running headers/footers or page-number lines, the offset where every page starts, and the embedded
// images anchored to the paragraph they follow. Pages without a text layer can be read by an OCR
// callback. It is a port of src/lib/server/pdf-extract.ts; this file holds the pure layout rules,
// derived from the TypeScript ones, and extract.go feeds them from pdfium instead of pdf.js.
// The production path additionally preserves sustained two-column prose in columns.go.
//
// Offsets (page breaks, paragraph starts and ends, image anchors) count UTF-16 code units, as the
// web client's JavaScript strings do, so they stay compatible with the stored TypeScript output.
package pdfx

import (
	"math"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"

	"memoryz/server/internal/textmatch"
)

// Piece is a text run in page coordinates: x/y from the top-left, y at the baseline, all in PDF points.
type Piece struct {
	Str   string
	X     float64
	Y     float64
	Width float64
	Size  float64
}

// Line is one baseline of text with its horizontal extent.
type Line struct {
	Text  string
	X     float64
	Right float64
	Y     float64
	Size  float64
	// readingGroup separates columns and full-width bands on the same page.
	readingGroup int
}

// Block is a paragraph with the vertical span it came from.
type Block struct {
	Text   string
	Top    float64
	Bottom float64
}

// PageLayout is a page's size in points and its lines.
type PageLayout struct {
	Width  float64
	Height float64
	Lines  []Line
}

// Box is a rectangle normalised to the page (0..1, top-left origin).
type Box struct {
	X float64
	Y float64
	W float64
	H float64
}

// Placement is where an image was painted, with its native pixel size and a content hash.
type Placement struct {
	Page   int
	Order  int
	Box    Box
	Width  int
	Height int
	Hash   string
}

// PlacedImage is a Placement anchored to the extracted text.
type PlacedImage struct {
	Placement
	// Paragraph is the global index of the paragraph the image follows; -1 when it comes before any text.
	Paragraph int
	// Anchor is the offset in the extracted text where the image belongs (end of that paragraph, or its page start).
	Anchor int
	// Context is the start of the paragraph it follows, to re-anchor after the text is edited.
	Context string
}

// Paragraph is one block of the assembled text and where it lives.
type Paragraph struct {
	Page   int
	Start  int
	End    int
	Top    float64
	Bottom float64
	Text   string
}

// Assembled is the joined text with page and paragraph positions.
type Assembled struct {
	Text       string
	PageBreaks []int
	Paragraphs []Paragraph
}

// Lexicon is the set of whole words a document spells, to recognise a word a wrap split.
type Lexicon map[string]struct{}

// ws is the JavaScript \s class (WhiteSpace and LineTerminator code points), so the ported
// regular expressions keep their meaning for Korean text that carries NBSP or ideographic spaces.
const ws = `\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

var (
	spaceRun   = regexp.MustCompile(`[` + ws + `]+`)
	digitRun   = regexp.MustCompile(`\d+`)
	listMarker = regexp.MustCompile(`^(?:[○◦●•·▪■□◆◇◈※▶▷►➢✓✔☞\-–—*][` + ws + `]*|ㅇ[` + ws + `]|\d{1,2}[.)][` + ws + `]|\(\d{1,2}\)|[①-⑳]|[가-하][.)][` + ws + `]|\([가-하]\)|[IVX]{1,4}\.[` + ws + `]|[a-z][.)][` + ws + `])`)
	// sentenceEnd and the other line-end tests use $ without multiline mode, which in Go as in
	// JavaScript matches only at the very end of the text.
	sentenceEnd = regexp.MustCompile(`[.!?。…」』"'’”)\]다요죠음함됨임]$`)
	tocLeader   = regexp.MustCompile(`^(.*?[^` + ws + `])[` + ws + `]*(?:[.·…‥⋯・][` + ws + `]*){3,}(\d{1,4})$`)
	pageNumber  = regexp.MustCompile(`(?i)^(?:[-–—][` + ws + `]*)?\d{1,4}(?:[` + ws + `]*[-–—])?$|^\d{1,4}[` + ws + `]*/[` + ws + `]*\d{1,4}$|^(?:page|p\.)[` + ws + `]*\d{1,4}$|^\d{1,4}[` + ws + `]*쪽$`)
	hangulTail  = regexp.MustCompile(`([가-힣]+)$`)
	hangulHead  = regexp.MustCompile(`^([가-힣]+)`)
	lastWord    = regexp.MustCompile(`([^` + ws + `]+)$`)
	firstWord   = regexp.MustCompile(`^([^` + ws + `]+)`)
	notWordChar = regexp.MustCompile(`[^가-힣A-Za-z0-9]`)
	hyphenEnd   = regexp.MustCompile(`[A-Za-z]-$`)
	lowerStart  = regexp.MustCompile(`^[a-z]`)
	blankLine   = regexp.MustCompile(`\n[` + ws + `]*\n`)
	lineBreak   = regexp.MustCompile(`[` + ws + `]*\n[` + ws + `]*`)
)

// boundStarts are the particles and endings that never start a word. The TypeScript BOUND_START
// pattern is an alternation followed by a lookahead, which RE2 lacks; boundStart tests each
// alternative and the character after it, which is what the backtracking engine decides.
var boundStarts = strings.Split("을 를 은 는 이 가 의 에 에서 에게 께 로 으로 와 과 도 만 까지 부터 처럼 보다 하며 하고 하여 하는 하게 해 했다 했고 한다 한 할 함 된다 된 될 됨 이다 이며 입니다 적 적인 들 들이 들을 들의", " ")

const boundFollow = ".,·)」』”'\""

func boundStart(after string) bool {
	for _, alt := range boundStarts {
		if !strings.HasPrefix(after, alt) {
			continue
		}
		rest := after[len(alt):]
		if rest == "" {
			return true
		}
		r, _ := utf8.DecodeRuneInString(rest)
		if isSpace(r) || strings.ContainsRune(boundFollow, r) {
			return true
		}
	}
	return false
}

var loneWords = func() map[string]bool {
	set := map[string]bool{}
	for _, word := range strings.Split("및 등 또 더 덜 안 못 잘 꼭 곧 좀 참 각 전 후 제 총 약 매 첫 새 옛 온 그 이 저 수 것 줄 때 곳 점 번 개 명 년 월 일 원 분 초 쪽 장 권 회 차 위 나 너 뭐 왜 늘 다 막 즉 및 겸 대 중 내 외", " ") {
		set[word] = true
	}
	return set
}()

// isSpace reports whether r is in the JavaScript \s class.
func isSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// trim is String.prototype.trim: it strips the JavaScript whitespace class from both ends.
func trim(s string) string {
	return strings.TrimFunc(s, isSpace)
}

func endsWithSpace(s string) bool {
	r, size := utf8.DecodeLastRuneInString(s)
	return size > 0 && isSpace(r)
}

func startsWithSpace(s string) bool {
	r, size := utf8.DecodeRuneInString(s)
	return size > 0 && isSpace(r)
}

// clean normalises to NFC, drops zero-width characters and turns control characters into spaces.
func clean(value string) string {
	value = norm.NFC.String(value)
	var b strings.Builder
	b.Grow(len(value))
	for _, r := range value {
		switch {
		case r >= 0x200b && r <= 0x200d, r == 0xfeff, r == 0x00ad:
			continue
		case r <= 0x0008, r >= 0x000b && r <= 0x001f, r == 0x007f:
			b.WriteByte(' ')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// utf16Len is the JavaScript length of s (UTF-16 code units), shared with the citation rules.
func utf16Len(s string) int { return textmatch.UTF16Len(s) }

// sliceUTF16 is String.prototype.slice(from, to) with UTF-16 offsets, never splitting a rune.
func sliceUTF16(s string, from, to int) string {
	var b strings.Builder
	pos := 0
	for _, r := range s {
		width := 1
		if r >= 0x10000 {
			width = 2
		}
		if pos >= to {
			break
		}
		if pos >= from {
			b.WriteRune(r)
		}
		pos += width
	}
	return b.String()
}

// ToLines groups pieces sharing a baseline into lines; a visible gap becomes one space, never a tab.
func ToLines(pieces []Piece) []Line {
	sorted := make([]Piece, 0, len(pieces))
	for _, piece := range pieces {
		piece.Str = clean(piece.Str)
		if piece.Str != "" {
			sorted = append(sorted, piece)
		}
	}
	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if a.Y != b.Y {
			return a.Y < b.Y
		}
		return a.X < b.X
	})
	var rows [][]Piece
	for _, piece := range sorted {
		if n := len(rows); n > 0 {
			row := rows[n-1]
			size := math.Max(math.Max(piece.Size, row[0].Size), 1)
			if math.Abs(row[0].Y-piece.Y) <= size*0.4 {
				rows[n-1] = append(row, piece)
				continue
			}
		}
		rows = append(rows, []Piece{piece})
	}
	lines := make([]Line, 0, len(rows))
	for _, row := range rows {
		sort.SliceStable(row, func(i, j int) bool { return row[i].X < row[j].X })
		var text strings.Builder
		right := row[0].X
		for _, piece := range row {
			gap := piece.X - right
			if text.Len() > 0 && !endsWithSpace(text.String()) && !startsWithSpace(piece.Str) && gap > math.Max(piece.Size, 1)*0.2 {
				text.WriteByte(' ')
			}
			text.WriteString(piece.Str)
			right = math.Max(right, piece.X+piece.Width)
		}
		x := row[0].X
		for _, piece := range row {
			if trim(piece.Str) != "" {
				x = piece.X
				break
			}
		}
		size := row[0].Size
		for _, piece := range row[1:] {
			size = math.Max(size, piece.Size)
		}
		line := Line{
			Text:  trim(spaceRun.ReplaceAllString(text.String(), " ")),
			X:     x,
			Right: right,
			Y:     row[0].Y,
			Size:  size,
		}
		if line.Text != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func submatch(re *regexp.Regexp, s string) string {
	m := re.FindStringSubmatch(s)
	if m == nil {
		return ""
	}
	return m[1]
}

// WrapJoin decides how two soft-wrapped lines meet: "" to rejoin a split word, " " at a word boundary.
// Korean wraps between any two syllables, so a wrap may split a word ("프 / 로그램"). Particles and
// endings never start a word, a lone syllable that is not a word of its own belongs to the next line,
// and a joined form the document spells elsewhere is trusted; anything else keeps the space a word
// boundary needs.
func WrapJoin(before, after string, lexicon Lexicon) string {
	tail := submatch(hangulTail, before)
	head := submatch(hangulHead, after)
	if tail == "" || head == "" || endsWithSpace(before) || startsWithSpace(after) {
		return " "
	}
	if boundStart(after) {
		return ""
	}
	last := submatch(lastWord, before)
	if last == "" {
		last = tail
	}
	first := submatch(firstWord, after)
	if first == "" {
		first = head
	}
	joined := notWordChar.ReplaceAllString(last+first, "")
	headFirst, _ := utf8.DecodeRuneInString(head)
	stem := notWordChar.ReplaceAllString(last, "") + string(headFirst)
	if lexicon.has(joined) || (utf8.RuneCountInString(stem) >= 3 && lexicon.hasPrefix(stem)) {
		return ""
	}
	if last == tail && utf8.RuneCountInString(tail) == 1 && !loneWords[tail] {
		return ""
	}
	return " "
}

func (l Lexicon) has(word string) bool {
	_, ok := l[word]
	return ok
}

func (l Lexicon) hasPrefix(stem string) bool {
	for word := range l {
		if strings.HasPrefix(word, stem) {
			return true
		}
	}
	return false
}

// LexiconOf collects the whole words of the document.
func LexiconOf(lines []Line) Lexicon {
	words := Lexicon{}
	for _, line := range lines {
		for _, word := range spaceRun.Split(line.Text, -1) {
			bare := notWordChar.ReplaceAllString(word, "")
			if utf8.RuneCountInString(bare) >= 2 {
				words[bare] = struct{}{}
			}
		}
	}
	return words
}

// TidyLine keeps a table-of-contents line's title and page, not the leader dots.
func TidyLine(text string) string {
	leader := tocLeader.FindStringSubmatch(text)
	if leader == nil {
		return text
	}
	return leader[1] + " (" + leader[2] + "쪽)"
}

// ToParagraphs joins soft-wrapped lines with a space; spacing, indents, short lines and list markers
// end a paragraph. A nil lexicon means the lines' own words.
func ToParagraphs(lines []Line, lexicon Lexicon) []Block {
	if lexicon == nil {
		lexicon = LexiconOf(lines)
	}
	var blocks []Block
	for start := 0; start < len(lines); {
		end := start + 1
		for end < len(lines) && lines[end].readingGroup == lines[start].readingGroup {
			end++
		}
		blocks = append(blocks, columnParagraphs(lines[start:end], lexicon)...)
		start = end
	}
	return blocks
}

func columnParagraphs(lines []Line, lexicon Lexicon) []Block {
	if len(lines) == 0 {
		return nil
	}
	if lexicon == nil {
		lexicon = LexiconOf(lines)
	}
	var gaps []float64
	for i := 1; i < len(lines); i++ {
		gap := lines[i].Y - lines[i-1].Y
		if gap > 0 && gap < lines[i-1].Size*3 && math.Abs(lines[i].Size-lines[i-1].Size) <= lines[i-1].Size*0.15 {
			gaps = append(gaps, gap)
		}
	}
	sort.Float64s(gaps)
	typical := lines[0].Size * 1.5
	if len(gaps) > 0 {
		typical = gaps[len(gaps)/2]
	}
	rights := make([]float64, len(lines))
	lefts := make([]float64, len(lines))
	for i, line := range lines {
		rights[i] = line.Right
		lefts[i] = line.X
	}
	sort.Float64s(rights)
	sort.Float64s(lefts)
	blockRight := rights[int(math.Floor(float64(len(rights))*0.9))]
	blockLeft := lefts[int(math.Floor(float64(len(lefts))*0.1))]
	var blocks []Block
	var parts []string
	var top, bottom float64
	for i, line := range lines {
		text := TidyLine(line.Text)
		startsNew := i == 0
		if !startsNew {
			previous := lines[i-1]
			startsNew = line.Y-previous.Y > typical*1.45 ||
				math.Abs(line.Size-previous.Size) > previous.Size*0.15 ||
				listMarker.MatchString(text) ||
				tocLeader.MatchString(line.Text) ||
				tocLeader.MatchString(previous.Text) ||
				// A line that stopped short of the column did not wrap: the paragraph ended there.
				previous.Right < blockLeft+(blockRight-blockLeft)*0.8 ||
				(sentenceEnd.MatchString(previous.Text) && line.X > blockLeft+line.Size*0.8)
		}
		if startsNew {
			if len(parts) > 0 {
				blocks = append(blocks, Block{Text: strings.Join(parts, ""), Top: top, Bottom: bottom})
			}
			parts = []string{text}
			top = line.Y - line.Size
		} else {
			last := parts[len(parts)-1]
			// A Latin word hyphenated at the line end rejoins; everything else wraps with a space.
			if hyphenEnd.MatchString(last) && lowerStart.MatchString(text) {
				parts[len(parts)-1] = last[:len(last)-1] + text
			} else {
				parts = append(parts, WrapJoin(last, text, lexicon)+text)
			}
		}
		bottom = line.Y
	}
	if len(parts) > 0 {
		blocks = append(blocks, Block{Text: strings.Join(parts, ""), Top: top, Bottom: bottom})
	}
	kept := blocks[:0]
	for _, block := range blocks {
		if trim(block.Text) != "" {
			kept = append(kept, block)
		}
	}
	return kept
}

func shape(text string) string {
	return trim(spaceRun.ReplaceAllString(digitRun.ReplaceAllString(text, "#"), " "))
}

// DropFurniture removes lines repeated in the top or bottom band of most pages, and bare page
// numbers there.
func DropFurniture(pages []PageLayout) []PageLayout {
	band := func(page PageLayout, line Line) bool {
		return line.Y < page.Height*0.1 || line.Y-line.Size > page.Height*0.9
	}
	seen := map[string]int{}
	for _, page := range pages {
		shapes := map[string]struct{}{}
		for _, line := range page.Lines {
			if band(page, line) {
				shapes[shape(line.Text)] = struct{}{}
			}
		}
		for s := range shapes {
			seen[s]++
		}
	}
	repeated := map[string]bool{}
	for s, count := range seen {
		if count >= 3 && float64(count) >= float64(len(pages))*0.5 {
			repeated[s] = true
		}
	}
	out := make([]PageLayout, len(pages))
	for i, page := range pages {
		lines := make([]Line, 0, len(page.Lines))
		for _, line := range page.Lines {
			if band(page, line) && (repeated[shape(line.Text)] || pageNumber.MatchString(trim(line.Text))) {
				continue
			}
			lines = append(lines, line)
		}
		out[i] = PageLayout{Width: page.Width, Height: page.Height, Lines: lines}
	}
	return out
}

// Assemble joins page paragraphs with blank lines and records where each page and paragraph starts.
func Assemble(pages [][]Block) Assembled {
	var text strings.Builder
	length := 0
	write := func(s string) {
		text.WriteString(s)
		length += utf16Len(s)
	}
	pageBreaks := make([]int, 0, len(pages))
	var paragraphs []Paragraph
	for index, blocks := range pages {
		if length > 0 && len(blocks) > 0 {
			write("\n\n")
		}
		pageBreaks = append(pageBreaks, length)
		for i, block := range blocks {
			if i > 0 {
				write("\n\n")
			}
			start := length
			write(block.Text)
			paragraphs = append(paragraphs, Paragraph{Page: index + 1, Start: start, End: length, Top: block.Top, Bottom: block.Bottom, Text: block.Text})
		}
	}
	return Assembled{Text: text.String(), PageBreaks: pageBreaks, Paragraphs: paragraphs}
}

// KeepImages keeps images that carry content: not tiny, not a full-page background, not a logo on
// most pages.
func KeepImages(placements []Placement, pageCount int) []Placement {
	pagesByHash := map[string]map[int]struct{}{}
	for _, p := range placements {
		pages := pagesByHash[p.Hash]
		if pages == nil {
			pages = map[int]struct{}{}
			pagesByHash[p.Hash] = pages
		}
		pages[p.Page] = struct{}{}
	}
	kept := make([]Placement, 0, len(placements))
	for _, p := range placements {
		area := p.Box.W * p.Box.H
		repeatedOn := len(pagesByHash[p.Hash])
		if min(p.Width, p.Height) >= 48 &&
			area >= 0.01 &&
			area <= 0.85 &&
			!(repeatedOn >= 3 && float64(repeatedOn) >= float64(pageCount)*0.5) {
			kept = append(kept, p)
		}
	}
	return kept
}

// PlaceImages anchors each image after the last paragraph on its page that starts above it;
// otherwise it opens the page.
func PlaceImages(placements []Placement, assembled Assembled, pageHeights []float64) []PlacedImage {
	placed := make([]PlacedImage, 0, len(placements))
	for _, p := range placements {
		top := math.NaN()
		if p.Page >= 1 && p.Page <= len(pageHeights) {
			top = p.Box.Y * pageHeights[p.Page-1]
		}
		index := -1
		for i, paragraph := range assembled.Paragraphs {
			if paragraph.Page < p.Page || (paragraph.Page == p.Page && paragraph.Top < top) {
				index = i
			}
		}
		onPage := index >= 0 && assembled.Paragraphs[index].Page == p.Page
		var anchor int
		switch {
		case onPage:
			anchor = assembled.Paragraphs[index].End
		case p.Page >= 1 && p.Page <= len(assembled.PageBreaks):
			anchor = assembled.PageBreaks[p.Page-1]
		default:
			anchor = utf16Len(assembled.Text)
		}
		context := ""
		if index >= 0 {
			context = sliceUTF16(assembled.Paragraphs[index].Text, 0, 60)
		}
		placed = append(placed, PlacedImage{Placement: p, Paragraph: index, Anchor: anchor, Context: context})
	}
	return placed
}
