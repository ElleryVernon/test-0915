// corpus-audit runs the same PDFium extractor used by uploads against a local
// directory. It never calls a model, contacts the API, or writes to a database.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"memoryz/server/internal/pdfx"
)

type glyphs struct {
	Replacement int `json:"replacement"`
	PrivateUse  int `json:"privateUse"`
	Control     int `json:"control"`
}
type page struct {
	Number int    `json:"page"`
	Start  int    `json:"startUTF16"`
	End    int    `json:"endUTF16"`
	Chars  int    `json:"chars"`
	Glyphs glyphs `json:"glyphs"`
	Text   string `json:"text"`
}
type image struct {
	Page      int      `json:"page"`
	Order     int      `json:"order"`
	Width     int      `json:"width"`
	Height    int      `json:"height"`
	Bytes     int      `json:"bytes"`
	Anchor    int      `json:"anchorUTF16"`
	Paragraph int      `json:"paragraph"`
	Box       pdfx.Box `json:"box"`
	Mime      string   `json:"mime"`
}
type record struct {
	File                 string                 `json:"file"`
	SHA256               string                 `json:"sha256"`
	Bytes                int                    `json:"bytes"`
	DurationMS           int64                  `json:"durationMs"`
	Error                string                 `json:"error,omitempty"`
	PageCount            int                    `json:"pageCount"`
	Chars                int                    `json:"chars"`
	UTF16                int                    `json:"utf16"`
	Glyphs               glyphs                 `json:"glyphs"`
	Method               string                 `json:"method"`
	Warning              string                 `json:"warning"`
	SparsePages          []int                  `json:"sparsePages"`
	Images               []image                `json:"images"`
	TextPath             string                 `json:"textPath,omitempty"`
	PagesPath            string                 `json:"pagesPath,omitempty"`
	Diagnostics          []pdfx.PageDiagnostics `json:"diagnostics"`
	ImagesOmittedByLimit int                    `json:"imagesOmittedByLimit"`
}
type report struct {
	Version    int            `json:"version"`
	StartedAt  string         `json:"startedAt"`
	GoVersion  string         `json:"goVersion"`
	Extractor  string         `json:"extractor"`
	OCR        string         `json:"ocr"`
	Limits     map[string]int `json:"limits"`
	WarmupMS   int64          `json:"warmupMs"`
	DurationMS int64          `json:"durationMs"`
	Files      []record       `json:"files"`
}

func main() {
	input := flag.String("input", "../.unlazy/university-learning/corpus", "local input directory")
	output := flag.String("output", "../.unlazy/university-learning/extraction/current", "local output directory; full text must remain untracked")
	match := flag.String("match", "", "optional filename substring")
	timeout := flag.Duration("timeout", 3*time.Minute, "per-document extraction timeout")
	flag.Parse()
	if err := run(*input, *output, *match, *timeout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(input, output, match string, timeout time.Duration) error {
	started := time.Now()
	var paths []string
	if err := filepath.WalkDir(input, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.EqualFold(filepath.Ext(path), ".pdf") && strings.Contains(d.Name(), match) {
			paths = append(paths, path)
		}
		return nil
	}); err != nil {
		return err
	}
	if len(paths) == 0 {
		return fmt.Errorf("no PDFs found in %s", input)
	}
	sort.Strings(paths)
	if err := os.MkdirAll(output, 0700); err != nil {
		return err
	}
	r := report{Version: 1, StartedAt: started.UTC().Format(time.RFC3339), GoVersion: runtime.Version(), Extractor: "memoryz/server/internal/pdfx (production PDFium WASM)", OCR: "disabled: no model calls; sparse pages reported", Limits: map[string]int{"maxBytes": pdfx.MaxBytes, "maxImages": pdfx.MaxImages, "maxOCRPages": pdfx.MaxOCRPages, "imageEdge": pdfx.ImageEdge, "timeoutMs": int(timeout.Milliseconds())}}
	extractor := pdfx.New(pdfx.Config{MinIdle: 1, MaxIdle: 1, MaxTotal: 1})
	defer extractor.Close()
	warm := time.Now()
	if err := extractor.Warm(); err != nil {
		return err
	}
	r.WarmupMS = time.Since(warm).Milliseconds()
	errors := 0
	for i, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(input, path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		item := record{File: filepath.ToSlash(rel), SHA256: hex.EncodeToString(sum[:]), Bytes: len(data), Images: []image{}, SparsePages: []int{}}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		start := time.Now()
		result, extractErr := extractor.Extract(ctx, data, pdfx.Options{})
		cancel()
		item.DurationMS = time.Since(start).Milliseconds()
		if extractErr != nil {
			item.Error = extractErr.Error()
			errors++
		} else {
			item.PageCount = result.Pages
			item.Chars = utf8.RuneCountInString(result.Text)
			item.Method = result.Method
			item.Warning = result.Warning
			item.Diagnostics = result.Diagnostics
			item.ImagesOmittedByLimit = result.ImagesOmittedByLimit
			item.Glyphs = countGlyphs(result.Text)
			units := utf16.Encode([]rune(result.Text))
			item.UTF16 = len(units)
			pages := make([]page, 0, result.Pages)
			if len(result.PageBreaks) != result.Pages {
				return fmt.Errorf("%s: invalid page break count", rel)
			}
			for index, from := range result.PageBreaks {
				to := len(units)
				if index+1 < len(result.PageBreaks) {
					to = result.PageBreaks[index+1]
				}
				if from < 0 || to < from || to > len(units) {
					return fmt.Errorf("%s: invalid page offsets", rel)
				}
				text := string(utf16.Decode(units[from:to]))
				pages = append(pages, page{index + 1, from, to, utf8.RuneCountInString(text), countGlyphs(text), text})
				nonspace := 0
				for _, c := range text {
					if !unicode.IsSpace(c) {
						nonspace++
					}
				}
				if nonspace < 16 {
					item.SparsePages = append(item.SparsePages, index+1)
				}
			}
			for _, img := range result.Images {
				item.Images = append(item.Images, image{img.Page, img.Order, img.Width, img.Height, len(img.Data), img.Anchor, img.Paragraph, img.Box, img.Mime})
			}
			stem := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)) + "-" + item.SHA256[:10]
			item.TextPath = stem + ".txt"
			item.PagesPath = stem + ".pages.json"
			if err := os.WriteFile(filepath.Join(output, item.TextPath), []byte(result.Text), 0600); err != nil {
				return err
			}
			if err := writeJSON(filepath.Join(output, item.PagesPath), pages); err != nil {
				return err
			}
		}
		r.Files = append(r.Files, item)
		r.DurationMS = time.Since(started).Milliseconds()
		if err := writeJSON(filepath.Join(output, "audit.json"), r); err != nil {
			return err
		}
		fmt.Printf("[%d/%d] %s: pages=%d chars=%d images=%d replacement=%d private=%d ms=%d error=%q\n", i+1, len(paths), rel, item.PageCount, item.Chars, len(item.Images), item.Glyphs.Replacement, item.Glyphs.PrivateUse, item.DurationMS, item.Error)
	}
	if errors > 0 {
		return fmt.Errorf("audit completed with %d extraction failures; inspect audit.json", errors)
	}
	fmt.Printf("CORPUS_AUDIT_OK files=%d durationMs=%d\n", len(r.Files), r.DurationMS)
	return nil
}

func countGlyphs(s string) glyphs {
	var n glyphs
	for _, r := range s {
		switch {
		case r == unicode.ReplacementChar:
			n.Replacement++
		case unicode.Is(unicode.Co, r):
			n.PrivateUse++
		case unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t':
			n.Control++
		}
	}
	return n
}
func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0600)
}
