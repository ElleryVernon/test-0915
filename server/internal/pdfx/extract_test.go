package pdfx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/bits"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"golang.org/x/text/unicode/norm"
)

const fixtureDir = "../../../tests/fixtures/pdf"

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(fixtureDir, name+".pdf"))
	if err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	return data
}

// fold prepares text for the parity ratio: NFC, whitespace runs collapsed, trimmed.
func fold(s string) []rune {
	return []rune(trim(spaceRun.ReplaceAllString(norm.NFC.String(s), " ")))
}

// lcsLength is the bit-parallel LCS length (Crochemore, Iliopoulos, Pinzon and Reid).
func lcsLength(a, b []rune) int {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	words := (len(b) + 63) / 64
	match := map[rune][]uint64{}
	for j, r := range b {
		v := match[r]
		if v == nil {
			v = make([]uint64, words)
			match[r] = v
		}
		v[j/64] |= 1 << (j % 64)
	}
	v := make([]uint64, words)
	for i := range v {
		v[i] = ^uint64(0)
	}
	none := make([]uint64, words)
	for _, r := range a {
		m := match[r]
		if m == nil {
			m = none
		}
		var carry uint64
		for w := 0; w < words; w++ {
			u := v[w] & m[w]
			sum, c := bits.Add64(v[w], u, carry)
			carry = c
			v[w] = sum | (v[w] - u)
		}
	}
	zeros := 0
	for w := 0; w < words; w++ {
		n := 64
		if w == words-1 && len(b)%64 != 0 {
			n = len(b) % 64
		}
		mask := ^uint64(0)
		if n < 64 {
			mask = 1<<uint(n) - 1
		}
		zeros += n - bits.OnesCount64(v[w]&mask)
	}
	return zeros
}

// similarity is the diff ratio 2*matches/(len a + len b) over folded text.
func similarity(a, b string) float64 {
	ra, rb := fold(a), fold(b)
	if len(ra)+len(rb) == 0 {
		return 1
	}
	return 2 * float64(lcsLength(ra, rb)) / float64(len(ra)+len(rb))
}

func TestSimilarity(t *testing.T) {
	if s := similarity("가나다 라마", "가나다 라마"); s != 1 {
		t.Fatalf("identical = %v", s)
	}
	if s := similarity("abcdef", "abcxef"); s < 0.83 || s > 0.84 {
		t.Fatalf("one substitution = %v", s)
	}
	if s := similarity("abc", "xyz"); s != 0 {
		t.Fatalf("disjoint = %v", s)
	}
	if s := similarity("가  나\n다", "가 나 다"); s != 1 {
		t.Fatalf("whitespace folded = %v", s)
	}
	if s := similarity(norm.NFD.String("한글"), "한글"); s != 1 {
		t.Fatalf("NFC folded = %v", s)
	}
	long := strings.Repeat("가나다라마바사아자차카타파하 ", 2000)
	start := time.Now()
	if s := similarity(long, long+"끝"); s < 0.99 {
		t.Fatalf("long = %v", s)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("similarity took %s", d)
	}
}

// utf16Index is String.prototype.indexOf: the UTF-16 offset of sub in s, or -1.
func utf16Index(s, sub string) int {
	i := strings.Index(s, sub)
	if i < 0 {
		return -1
	}
	return utf16Len(s[:i])
}

func pageOf(r *Extraction, phrase string) int {
	at := utf16Index(r.Text, phrase)
	n := 0
	for _, start := range r.PageBreaks {
		if start <= at {
			n++
		}
	}
	return n
}

var (
	fixtureDocumentOK bool
	fixtureScannedOK  bool
)

func TestFixtureDocument(t *testing.T) {
	// fixture: a printed Korean document comes out as clean paragraphs with pages and located figures
	start := time.Now()
	result, err := Extract(context.Background(), fixture(t, "document"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("document.pdf: %d pages in %s", result.Pages, time.Since(start))
	text := result.Text
	if result.Pages != 3 {
		t.Fatalf("pages = %d", result.Pages)
	}
	if result.Method != MethodText {
		t.Fatalf("method = %q", result.Method)
	}
	if result.Warning != "" {
		t.Fatalf("warning = %q", result.Warning)
	}
	if regexp.MustCompile(`-- \d+ of \d+ --`).MatchString(text) || strings.Contains(text, "\t") {
		t.Fatal("page markers or tabs")
	}
	if strings.Contains(text, "검증 자료") || regexp.MustCompile(`(?m)^- \d+ -$`).MatchString(text) {
		t.Fatal("running header or footer kept")
	}
	if !strings.Contains(text, "I. 공모 개요 (2쪽)") || !strings.Contains(text, "II. 선정 절차 (3쪽)") {
		t.Fatalf("table of contents not tidied:\n%s", text)
	}
	if !strings.Contains(text, "함께 제공하는 프로그램이다. 선정된 팀은") || !strings.Contains(text, "시제품을 시험하며, 마지막") {
		t.Fatalf("a wrapped paragraph did not read as one:\n%s", text)
	}
	if !strings.Contains(text, "\n\n○ 모집 대상: 창업 3년 이내의 기후테크 기업\n\n○ 지원 내용") {
		t.Fatalf("list items not separate:\n%s", text)
	}
	if len(result.PageBreaks) != 3 {
		t.Fatalf("pageBreaks = %v", result.PageBreaks)
	}
	if got := [3]int{pageOf(result, "2023. 11."), pageOf(result, "이 사업은"), pageOf(result, "서류와 발표로")}; got != [3]int{1, 2, 3} {
		t.Fatalf("pages of phrases = %v", got)
	}
	var placed [][2]string
	for _, image := range result.Images {
		placed = append(placed, [2]string{fmt.Sprint(image.Page), sliceUTF16(image.Context, 0, 9)})
	}
	want := [][2]string{{"2", "이 사업은 기후 "}, {"3", "서류와 발표로 두"}}
	if fmt.Sprint(placed) != fmt.Sprint(want) {
		t.Fatalf("images = %v, want %v (the chart and the diagram, after the paragraphs that introduce them; no logo or icon)", placed, want)
	}
	for _, image := range result.Images {
		if image.Mime != mimeWebP || len(image.Data) < 12 || string(image.Data[8:12]) != "WEBP" {
			t.Fatalf("image %d is not WebP", image.Page)
		}
		if image.Paragraph < 0 {
			t.Fatalf("image on page %d has paragraph %d", image.Page, image.Paragraph)
		}
		if image.Width == 0 || image.Height == 0 || image.Box.W <= 0 || image.Box.H <= 0 {
			t.Fatalf("image geometry %+v", image)
		}
		before := sliceUTF16(text, 0, image.Anchor)
		at := strings.LastIndex(before, image.Context)
		if at < 0 || strings.Contains(before[at:], "\n\n") {
			t.Fatalf("image on page %d is not anchored at the end of the paragraph it follows", image.Page)
		}
		if !strings.HasPrefix(sliceUTF16(text, image.Anchor, 1<<30), "\n\n") {
			t.Fatalf("image on page %d is not between two paragraphs", image.Page)
		}
	}
	expected, err := os.ReadFile("testdata/document.ts.txt")
	if err != nil {
		t.Fatal(err)
	}
	ratio := similarity(string(expected), text)
	t.Logf("similarity to the TypeScript text: %.4f", ratio)
	if ratio < 0.98 {
		t.Fatalf("similarity %.4f < 0.98\n--- go ---\n%s\n--- ts ---\n%s", ratio, text, expected)
	}
	fixtureDocumentOK = true
}

func TestFixtureScanned(t *testing.T) {
	// fixture: a page without a text layer is OCR-read when a reader is given, and reported otherwise
	bare, err := Extract(context.Background(), fixture(t, "scanned"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if bare.Pages != 2 || bare.Method != MethodText {
		t.Fatalf("pages=%d method=%q", bare.Pages, bare.Method)
	}
	if bare.Warning != "1쪽은 이미지로만 되어 있어 본문에 넣지 못했어요." {
		t.Fatalf("warning = %q", bare.Warning)
	}
	if fmt.Sprint(bare.PageBreaks) != "[0 0]" {
		t.Fatalf("pageBreaks = %v", bare.PageBreaks)
	}
	if !strings.Contains(bare.Text, "둘째 쪽") {
		t.Fatalf("text = %q", bare.Text)
	}
	var calls []int
	read, err := Extract(context.Background(), fixture(t, "scanned"), Options{OCR: func(ctx context.Context, png []byte) (string, error) {
		calls = append(calls, len(png))
		if len(png) < 8 || string(png[1:4]) != "PNG" {
			t.Errorf("OCR input is not PNG")
		}
		return "광합성은 빛에너지를 화학 에너지로 바꾸는 과정이다.\n\n엽록체의 틸라코이드에서 명반응이 일어난다.", nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 {
		t.Fatalf("OCR called %d times, want only the page without text", len(calls))
	}
	if read.Method != MethodMixed || read.Warning != "" {
		t.Fatalf("method=%q warning=%q", read.Method, read.Warning)
	}
	if !strings.HasPrefix(read.Text, "광합성은 빛에너지를") {
		t.Fatalf("text = %q", read.Text)
	}
	if !strings.HasPrefix(sliceUTF16(read.Text, read.PageBreaks[1], 1<<30), "둘째 쪽") {
		t.Fatalf("page 2 start = %q", sliceUTF16(read.Text, read.PageBreaks[1], 1<<30))
	}
	if len(read.PageBreaks) != 2 || read.PageBreaks[1] == 0 {
		t.Fatalf("pageBreaks = %v", read.PageBreaks)
	}
	// The OCR text is split into paragraphs at blank lines, line breaks inside one become spaces.
	if !strings.Contains(read.Text, "과정이다.\n\n엽록체의") {
		t.Fatalf("OCR paragraphs = %q", read.Text)
	}
	// An OCR failure fails the extraction; an empty OCR result leaves the warning.
	boom := errors.New("boom")
	if _, err := Extract(context.Background(), fixture(t, "scanned"), Options{OCR: func(context.Context, []byte) (string, error) { return "", boom }}); !errors.Is(err, boom) {
		t.Fatalf("OCR error not propagated: %v", err)
	}
	empty, err := Extract(context.Background(), fixture(t, "scanned"), Options{OCR: func(context.Context, []byte) (string, error) { return " \n ", nil }})
	if err != nil {
		t.Fatal(err)
	}
	if empty.Method != MethodText || empty.Warning != bare.Warning {
		t.Fatalf("empty OCR: method=%q warning=%q", empty.Method, empty.Warning)
	}
	// The scan itself is a content image on page 1, before any text.
	if len(bare.Images) != 1 || bare.Images[0].Page != 1 || bare.Images[0].Paragraph != -1 || bare.Images[0].Anchor != 0 || bare.Images[0].Context != "" {
		t.Fatalf("images = %+v", bare.Images)
	}
	fixtureScannedOK = true
}

func TestFixtureVerified(t *testing.T) {
	if !fixtureDocumentOK || !fixtureScannedOK {
		t.Fatalf("fixtures: document=%v scanned=%v", fixtureDocumentOK, fixtureScannedOK)
	}
	fmt.Println("PDFX_FIXTURES_OK")
}

func TestLimits(t *testing.T) {
	if _, err := Extract(context.Background(), nil, Options{}); !errors.Is(err, ErrEmpty) {
		t.Fatalf("empty: %v", err)
	}
	if _, err := Extract(context.Background(), make([]byte, MaxBytes+1), Options{}); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("too large: %v", err)
	}
	if _, err := Extract(context.Background(), []byte("not a pdf at all"), Options{}); err == nil {
		t.Fatal("garbage opened")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Extract(cancelled, fixture(t, "document"), Options{}); err == nil {
		t.Fatal("cancelled context extracted")
	}
}

// TestPoolCost measures what the WebAssembly pool costs: module compilation at first use, a fresh
// worker per extraction (the default pool does not reuse workers, so memory returns after each job).
func TestPoolCost(t *testing.T) {
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	e := New(Config{MinIdle: 0, MaxIdle: 1, MaxTotal: 1})
	start := time.Now()
	if err := e.Warm(); err != nil {
		t.Fatal(err)
	}
	warm := time.Since(start)
	runtime.GC()
	runtime.ReadMemStats(&after)
	data := fixture(t, "document")
	start = time.Now()
	if _, err := e.Extract(context.Background(), data, Options{}); err != nil {
		t.Fatal(err)
	}
	first := time.Since(start)
	start = time.Now()
	if _, err := e.Extract(context.Background(), data, Options{}); err != nil {
		t.Fatal(err)
	}
	second := time.Since(start)
	var peak runtime.MemStats
	runtime.ReadMemStats(&peak)
	if err := e.Close(); err != nil {
		t.Fatal(err)
	}
	t.Logf("PDFX_POOL warm=%s heap+%.1fMB sys=%.1fMB extract1=%s extract2=%s sysAfter=%.1fMB", warm, float64(after.HeapAlloc-before.HeapAlloc)/1e6, float64(after.Sys)/1e6, first, second, float64(peak.Sys)/1e6)
}

type sampleExpectation struct {
	PageBreaks []int `json:"pageBreaks"`
	Images     []struct {
		Page      int    `json:"page"`
		Order     int    `json:"order"`
		Paragraph int    `json:"paragraph"`
		Anchor    int    `json:"anchor"`
		Context   string `json:"context"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
	} `json:"images"`
}

func TestSample(t *testing.T) {
	dir := os.Getenv("PDFX_SAMPLE_DIR")
	if dir == "" {
		t.Skip("PDFX_SAMPLE_DIR not set")
	}
	data, err := os.ReadFile(filepath.Join(dir, "sample.pdf"))
	if err != nil {
		t.Fatal(err)
	}
	expected, err := os.ReadFile(filepath.Join(dir, "sample.ts.txt"))
	if err != nil {
		t.Fatal(err)
	}
	var meta sampleExpectation
	if raw, err := os.ReadFile(filepath.Join(dir, "sample.ts.json")); err != nil {
		t.Fatal(err)
	} else if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	result, err := Extract(context.Background(), data, Options{})
	if err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(start)
	t.Logf("sample: %d pages, %d images, %d chars in %s", result.Pages, len(result.Images), utf16Len(result.Text), elapsed)
	if elapsed >= 20*time.Second {
		t.Fatalf("took %s", elapsed)
	}
	if result.Pages != 18 || len(result.PageBreaks) != 18 {
		t.Fatalf("pages=%d pageBreaks=%d", result.Pages, len(result.PageBreaks))
	}
	if result.Warning != "" || result.Method != MethodText {
		t.Fatalf("warning=%q method=%q", result.Warning, result.Method)
	}
	if regexp.MustCompile(`-- \d+ of \d+ --`).MatchString(result.Text) || strings.Contains(result.Text, "\t") {
		t.Fatal("page markers or tabs")
	}
	leader := regexp.MustCompile(`(?m)(?:[.·…‥⋯・][` + ws + `]*){3,}\d{1,4}$`)
	if m := leader.FindString(result.Text); m != "" {
		t.Fatalf("leader dots kept: %q", m)
	}
	if len(result.Images) < 5 {
		t.Fatalf("images = %d", len(result.Images))
	}
	cover, seventh := false, false
	for _, image := range result.Images {
		if image.Page == 1 {
			cover = true
		}
		if image.Page == 7 && strings.Contains(image.Context, "사업 목적 활동 예시") {
			seventh = true
		}
		if image.Mime != mimeWebP || len(image.Data) < 12 || string(image.Data[8:12]) != "WEBP" {
			t.Fatalf("image on page %d is not WebP", image.Page)
		}
	}
	if !cover {
		t.Fatal("no cover graphic on page 1")
	}
	if !seventh {
		var contexts []string
		for _, image := range result.Images {
			if image.Page == 7 {
				contexts = append(contexts, image.Context)
			}
		}
		t.Fatalf("page 7 image is not after the 사업 목적 활동 예시 paragraph: %q", contexts)
	}
	// Every image the TypeScript kept is placed after a paragraph with the same start.
	matched := 0
	for _, want := range meta.Images {
		for _, image := range result.Images {
			if image.Page == want.Page && sliceUTF16(image.Context, 0, 12) == sliceUTF16(want.Context, 0, 12) {
				matched++
				break
			}
		}
	}
	t.Logf("image placements matching the TypeScript ones: %d/%d", matched, len(meta.Images))
	if dump := os.Getenv("PDFX_SAMPLE_DUMP"); dump != "" {
		if err := os.WriteFile(dump, []byte(result.Text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	ratio := similarity(string(expected), result.Text)
	t.Logf("similarity to the TypeScript text: %.4f", ratio)
	if ratio < 0.97 {
		t.Fatalf("similarity %.4f < 0.97", ratio)
	}
	fmt.Printf("PDFX_SAMPLE_OK pages=%d images=%d similarity=%.4f\n", result.Pages, len(result.Images), ratio)
}
