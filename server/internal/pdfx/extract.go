package pdfx

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"image/png"
	"math"
	"strings"
	"sync"

	"github.com/klippa-app/go-pdfium"
	"github.com/klippa-app/go-pdfium/enums"
	"github.com/klippa-app/go-pdfium/references"
	"github.com/klippa-app/go-pdfium/requests"
	"github.com/klippa-app/go-pdfium/responses"
	"github.com/klippa-app/go-pdfium/structs"
	"github.com/klippa-app/go-pdfium/webassembly"
)

const (
	// MaxImages is how many content images an extraction keeps, in page order.
	MaxImages = 40
	// MaxOCRPages caps how many pages without a text layer are sent to the OCR callback.
	MaxOCRPages = 12
	// ImageEdge is the longest side of an encoded image.
	ImageEdge = 1600
	// MaxBytes is the largest PDF Extract accepts; uploads.ts refuses bigger files too.
	MaxBytes = 10_000_000

	ocrDPI            = 150
	webpQuality       = 82
	maxObjectsPerPage = 50_000
	maxFormDepth      = 8
	// maxImagePixels bounds the decode of one embedded image; bigger ones are left out rather
	// than risk the 1 GiB instance.
	maxImagePixels = 40_000_000
	// mimeWebP is the media type of every encoded image.
	mimeWebP = "image/webp"

	// MethodText, MethodOCR and MethodMixed say how the text was produced.
	MethodText  = "pdf-text"
	MethodOCR   = "pdf-ocr"
	MethodMixed = "pdf-mixed"
)

// Warning texts, byte-identical to the TypeScript extractor.
const (
	warningNoTextLayer = "글자 층이 없는 스캔 PDF예요. 본문을 직접 입력하거나 페이지를 사진으로 올려 주세요."
	warningUnreadPages = "%d쪽은 이미지로만 되어 있어 본문에 넣지 못했어요."
)

var (
	// ErrEmpty is returned for an empty input.
	ErrEmpty = errors.New("pdfx: empty PDF")
	// ErrTooLarge is returned when the input exceeds MaxBytes.
	ErrTooLarge = errors.New("pdfx: PDF larger than 10 MB")

	errTooManyObjects = errors.New("pdfx: too many page objects")
)

// Options tunes one extraction.
type Options struct {
	// OCR turns a rendered page (PNG) into text. It is only called for pages without a text
	// layer, at most MaxOCRPages of them; an error aborts the extraction.
	OCR func(ctx context.Context, png []byte) (string, error)
}

// Image is an embedded image with where it belongs in the text.
type Image struct {
	Page      int
	Order     int
	Paragraph int
	Anchor    int
	Box       Box
	Width     int
	Height    int
	Mime      string
	Context   string
	Data      []byte
}

// Extraction is the result of reading a PDF.
type Extraction struct {
	Text       string
	Pages      int
	PageBreaks []int
	Images     []Image
	Method     string
	Warning    string
}

// Config sizes the pdfium WebAssembly worker pool. Every worker is a pdfium instance with its own
// heap, so keep the pool small on a 1 vCPU / 1 GiB instance.
type Config struct {
	MinIdle  int
	MaxIdle  int
	MaxTotal int
}

// DefaultConfig is the production pool: at most two concurrent extractions per process.
var DefaultConfig = Config{MinIdle: 1, MaxIdle: 2, MaxTotal: 2}

// Extractor owns one lazily created pdfium pool.
type Extractor struct {
	cfg  Config
	mu   sync.Mutex
	pool pdfium.Pool
	err  error
}

// New returns an Extractor whose pool is created on first use (or by Warm).
func New(cfg Config) *Extractor {
	if cfg.MaxTotal <= 0 {
		cfg.MaxTotal = DefaultConfig.MaxTotal
	}
	if cfg.MaxIdle <= 0 {
		cfg.MaxIdle = min(DefaultConfig.MaxIdle, cfg.MaxTotal)
	}
	cfg.MinIdle = max(0, min(cfg.MinIdle, cfg.MaxIdle))
	return &Extractor{cfg: cfg}
}

// Default is the process-wide extractor used by Extract and Warm.
var Default = New(DefaultConfig)

// Extract reads a PDF with the default extractor.
func Extract(ctx context.Context, data []byte, opts Options) (*Extraction, error) {
	return Default.Extract(ctx, data, opts)
}

// Warm creates the default pool now (compiling the WebAssembly module takes a few seconds), so the
// first upload does not pay for it.
func Warm() error {
	return Default.Warm()
}

// Warm creates the pool now.
func (e *Extractor) Warm() error {
	_, err := e.getPool()
	return err
}

// Close releases the pool; a later Extract creates a new one.
func (e *Extractor) Close() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.pool == nil {
		return nil
	}
	err := e.pool.Close()
	e.pool, e.err = nil, nil
	return err
}

func (e *Extractor) getPool() (pdfium.Pool, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.pool != nil || e.err != nil {
		return e.pool, e.err
	}
	pool, err := webassembly.Init(webassembly.Config{
		MinIdle:  e.cfg.MinIdle,
		MaxIdle:  e.cfg.MaxIdle,
		MaxTotal: e.cfg.MaxTotal,
	})
	if err != nil {
		e.err = fmt.Errorf("pdfx: init pdfium: %w", err)
		return nil, e.err
	}
	e.pool = pool
	return pool, nil
}

// Extract reads a PDF. It waits for a free pdfium worker until ctx ends, and stops early when ctx
// is cancelled.
func (e *Extractor) Extract(ctx context.Context, data []byte, opts Options) (*Extraction, error) {
	if len(data) == 0 {
		return nil, ErrEmpty
	}
	if len(data) > MaxBytes {
		return nil, ErrTooLarge
	}
	pool, err := e.getPool()
	if err != nil {
		return nil, err
	}
	instance, err := pool.GetInstanceWithContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("pdfx: acquire pdfium worker: %w", err)
	}
	defer instance.Close()
	doc, err := instance.OpenDocument(&requests.OpenDocument{File: &data})
	if err != nil {
		return nil, fmt.Errorf("pdfx: open document: %w", err)
	}
	j := &job{ctx: ctx, inst: instance, doc: doc.Document, opts: opts}
	defer instance.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document})
	return j.run()
}

// job is one extraction on one pdfium instance.
type job struct {
	ctx  context.Context
	inst pdfium.Pdfium
	doc  references.FPDF_DOCUMENT
	opts Options
}

// candidate is a painted image with its encoded pixels when it may be kept.
type candidate struct {
	Placement
	data []byte
}

func (j *job) run() (*Extraction, error) {
	count, err := j.inst.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: j.doc})
	if err != nil {
		return nil, fmt.Errorf("pdfx: page count: %w", err)
	}
	pages := count.PageCount
	layouts := make([]PageLayout, 0, pages)
	var placements []candidate
	for index := 0; index < pages; index++ {
		if err := j.ctx.Err(); err != nil {
			return nil, err
		}
		layout, images, err := j.page(index)
		if err != nil {
			return nil, fmt.Errorf("pdfx: page %d: %w", index+1, err)
		}
		layouts = append(layouts, layout)
		placements = append(placements, images...)
	}
	furnished := DropFurniture(layouts)
	var all []Line
	for _, layout := range furnished {
		all = append(all, layout.Lines...)
	}
	lexicon := LexiconOf(all)
	blocks := make([][]Block, len(furnished))
	for i, layout := range furnished {
		blocks[i] = ToParagraphs(layout.Lines, lexicon)
	}
	// Pages without a text layer: OCR when possible, otherwise say so.
	var empty []int
	for i, page := range blocks {
		n := 0
		for _, block := range page {
			n += utf16Len(spaceRun.ReplaceAllString(block.Text, ""))
		}
		if n < 16 {
			empty = append(empty, i+1)
		}
	}
	read := 0
	if j.opts.OCR != nil && len(empty) > 0 {
		// jitter: none — serial within one upload, capped at MaxOCRPages under pdfSlot and the AI semaphore; uploads.go passes 429/5xx/deadline errors on [site server/internal/pdfx/extract.go:261]
		for _, number := range empty[:min(len(empty), MaxOCRPages)] {
			if err := j.ctx.Err(); err != nil {
				return nil, err
			}
			shot, err := j.screenshot(number)
			if err != nil {
				return nil, fmt.Errorf("pdfx: render page %d: %w", number, err)
			}
			raw, err := j.opts.OCR(j.ctx, shot)
			if err != nil {
				return nil, fmt.Errorf("pdfx: ocr page %d: %w", number, err)
			}
			text := trim(clean(raw))
			if text == "" {
				continue
			}
			var page []Block
			for i, part := range blankLine.Split(text, -1) {
				part = trim(lineBreak.ReplaceAllString(part, " "))
				if part != "" {
					page = append(page, Block{Text: part, Top: float64(i), Bottom: float64(i)})
				}
			}
			blocks[number-1] = page
			read++
		}
	}
	assembled := Assemble(blocks)
	all2 := make([]Placement, len(placements))
	for i, c := range placements {
		all2[i] = c.Placement
	}
	kept := KeepImages(all2, pages)
	if len(kept) > MaxImages {
		kept = kept[:MaxImages]
	}
	heights := make([]float64, len(layouts))
	for i, layout := range layouts {
		heights[i] = layout.Height
	}
	pixels := map[[2]int][]byte{}
	for _, c := range placements {
		if c.data != nil {
			pixels[[2]int{c.Page, c.Order}] = c.data
		}
	}
	var images []Image
	for _, placed := range PlaceImages(kept, assembled, heights) {
		data := pixels[[2]int{placed.Page, placed.Order}]
		if data == nil {
			continue
		}
		images = append(images, Image{
			Page:      placed.Page,
			Order:     placed.Order,
			Paragraph: placed.Paragraph,
			Anchor:    placed.Anchor,
			Box:       placed.Box,
			Width:     placed.Width,
			Height:    placed.Height,
			Mime:      mimeWebP,
			Context:   placed.Context,
			Data:      data,
		})
	}
	unread := len(empty) - read
	warning := ""
	switch {
	case trim(assembled.Text) == "":
		warning = warningNoTextLayer
	case unread > 0:
		warning = fmt.Sprintf(warningUnreadPages, unread)
	}
	method := MethodMixed
	switch {
	case read == 0:
		method = MethodText
	case read == pages:
		method = MethodOCR
	}
	return &Extraction{
		Text:       assembled.Text,
		Pages:      pages,
		PageBreaks: assembled.PageBreaks,
		Images:     images,
		Method:     method,
		Warning:    warning,
	}, nil
}

// frame maps pdfium's user space (origin bottom-left, unrotated) to the viewport the layout rules
// expect (origin top-left, /Rotate applied), exactly as pdf.js's viewport transform does.
type frame struct {
	rot                      int
	left, bottom, right, top float64
	width, height            float64
}

func (f frame) point(x, y float64) (float64, float64) {
	switch f.rot {
	case 1:
		return y - f.bottom, x - f.left
	case 2:
		return f.right - x, y - f.bottom
	case 3:
		return f.top - y, f.right - x
	default:
		return x - f.left, f.top - y
	}
}

// rect maps a user-space rectangle to its viewport bounding box.
func (f frame) rect(left, bottom, right, top float64) (minX, minY, maxX, maxY float64) {
	minX, minY = math.Inf(1), math.Inf(1)
	maxX, maxY = math.Inf(-1), math.Inf(-1)
	for _, corner := range [4][2]float64{{left, bottom}, {right, bottom}, {left, top}, {right, top}} {
		x, y := f.point(corner[0], corner[1])
		minX, maxX = math.Min(minX, x), math.Max(maxX, x)
		minY, maxY = math.Min(minY, y), math.Max(maxY, y)
	}
	return minX, minY, maxX, maxY
}

func (j *job) frame(page requests.Page) (frame, error) {
	var f frame
	if rotation, err := j.inst.FPDFPage_GetRotation(&requests.FPDFPage_GetRotation{Page: page}); err == nil {
		f.rot = int(rotation.PageRotation) & 3
	}
	if bbox, err := j.inst.FPDF_GetPageBoundingBox(&requests.FPDF_GetPageBoundingBox{Page: page}); err == nil {
		f.left, f.bottom, f.right, f.top = float64(bbox.Rect.Left), float64(bbox.Rect.Bottom), float64(bbox.Rect.Right), float64(bbox.Rect.Top)
	} else {
		// No usable box: the rotated page size with the origin at the corner.
		size, err := j.inst.GetPageSize(&requests.GetPageSize{Page: page})
		if err != nil {
			return frame{}, err
		}
		f.right, f.top = size.Width, size.Height
		if f.rot%2 == 1 {
			f.right, f.top = size.Height, size.Width
		}
	}
	f.width, f.height = f.right-f.left, f.top-f.bottom
	if f.rot%2 == 1 {
		f.width, f.height = f.height, f.width
	}
	if f.width <= 0 || f.height <= 0 {
		return frame{}, errors.New("empty page box")
	}
	return f, nil
}

func (j *job) page(index int) (PageLayout, []candidate, error) {
	loaded, err := j.inst.FPDF_LoadPage(&requests.FPDF_LoadPage{Document: j.doc, Index: index})
	if err != nil {
		return PageLayout{}, nil, err
	}
	defer j.inst.FPDF_ClosePage(&requests.FPDF_ClosePage{Page: loaded.Page})
	page := requests.Page{ByReference: &loaded.Page}
	f, err := j.frame(page)
	if err != nil {
		return PageLayout{}, nil, err
	}
	pieces, err := j.pieces(page, f)
	if err != nil {
		return PageLayout{}, nil, err
	}
	images, err := j.images(page, f, index+1)
	if err != nil {
		return PageLayout{}, nil, err
	}
	return PageLayout{Width: f.width, Height: f.height, Lines: ToLines(pieces)}, images, nil
}

// textRun accumulates consecutive characters of one text piece, in user space.
type textRun struct {
	text   strings.Builder
	angle  float64
	size   float64
	dx, dy float64 // reading direction
	ox, oy float64 // origin of the first character
	px, py float64 // origin of the previous character
	s0, s1 float64 // extent along the direction, relative to the origin
	end    float64 // where the previous character's advance ended
}

func (r *textRun) piece(f frame) Piece {
	x, y := f.point(r.ox+r.dx*r.s0, r.oy+r.dy*r.s0)
	return Piece{Str: r.text.String(), X: x, Y: y, Width: r.s1 - r.s0, Size: r.size}
}

// pieces builds the text runs pdf.js would have produced. pdfium reports one box per character, so
// consecutive characters that share a baseline, size and direction form a run; pdfium's own
// generated spaces and line breaks (empty boxes) are skipped and the gaps are re-derived from the
// pen advance, with pdf.js's thresholds: a gap of 0.102-0.6 em becomes a space inside the run, a
// bigger one (or a backward jump, a vertical shift, a font change) starts a new run, the
// 0.102-0.6 em gap then written as a leading space like pdf.js's whitespace item.
func (j *job) pieces(page requests.Page, f frame) ([]Piece, error) {
	structured, err := j.inst.GetPageTextStructured(&requests.GetPageTextStructured{
		Page:                   page,
		Mode:                   requests.GetPageTextStructuredModeChars,
		CollectFontInformation: true,
	})
	if err != nil {
		return nil, err
	}
	if len(structured.Chars) == 0 {
		return nil, nil
	}
	textPage, err := j.inst.FPDFText_LoadPage(&requests.FPDFText_LoadPage{Page: page})
	if err != nil {
		return nil, err
	}
	defer j.inst.FPDFText_ClosePage(&requests.FPDFText_ClosePage{TextPage: textPage.TextPage})
	var pieces []Piece
	var run *textRun
	flush := func() {
		if run != nil {
			pieces = append(pieces, run.piece(f))
			run = nil
		}
	}
	for i, ch := range structured.Chars {
		if ch.Text == "" {
			continue
		}
		tight := ch.PointPosition
		if tight.Right == tight.Left && tight.Top == tight.Bottom {
			continue // generated by pdfium: whitespace or a line break, not a glyph
		}
		size := 0.0
		if ch.FontInformation != nil {
			size = ch.FontInformation.RenderedSize
			if size <= 0 {
				size = ch.FontInformation.Size
			}
		}
		if size <= 0 {
			size = math.Abs(tight.Top - tight.Bottom)
		}
		if size <= 0 {
			size = 10
		}
		ox, oy := tight.Left, tight.Bottom
		if origin, err := j.inst.FPDFText_GetCharOrigin(&requests.FPDFText_GetCharOrigin{TextPage: textPage.TextPage, Index: i}); err == nil {
			ox, oy = origin.X, origin.Y
		}
		angle := ch.Angle
		dx, dy := math.Cos(angle), math.Sin(angle)
		advance := j.advance(textPage.TextPage, i, ox, oy, dx, dy, tight)
		if run != nil {
			previous := run.size
			sameStyle := math.Abs(angle-run.angle) < 1e-3 && math.Abs(size-previous) <= 0.01*math.Max(size, previous)
			shift := -(ox-run.px)*run.dy + (oy-run.py)*run.dx
			gap := (ox-run.ox)*run.dx + (oy-run.oy)*run.dy - run.end
			space := false
			switch {
			case gap < -0.2*previous, math.Abs(shift) > previous:
				flush()
			default:
				space = gap >= 0.102*previous
				if gap > 0.6*previous || !sameStyle || math.Abs(shift) > 0.25*previous {
					flush()
				}
			}
			if space {
				if run == nil {
					run = &textRun{angle: angle, size: size, dx: dx, dy: dy, ox: ox, oy: oy, s0: math.Inf(1), s1: math.Inf(-1)}
				}
				run.text.WriteByte(' ')
			}
		}
		if run == nil {
			run = &textRun{angle: angle, size: size, dx: dx, dy: dy, ox: ox, oy: oy, s0: math.Inf(1), s1: math.Inf(-1)}
		}
		s := (ox-run.ox)*run.dx + (oy-run.oy)*run.dy
		run.s0 = math.Min(run.s0, s)
		run.s1 = math.Max(run.s1, s+advance)
		run.end = s + advance
		run.px, run.py = ox, oy
		run.text.WriteString(ch.Text)
	}
	flush()
	return pieces, nil
}

// advance is how far the pen moves for a character, in user space along its reading direction:
// the loose character box is the advance box (font ascent/descent by glyph width) transformed by
// the character matrix, so for skewed (synthetic italic) text its horizontal spread is shrunk by
// the shear before it stands in for the advance. Without a loose box the tight box's right edge
// serves.
func (j *job) advance(textPage references.FPDF_TEXTPAGE, index int, ox, oy, dx, dy float64, tight responses.CharPosition) float64 {
	loose, err := j.inst.FPDFText_GetLooseCharBox(&requests.FPDFText_GetLooseCharBox{TextPage: textPage, Index: index})
	if err != nil || loose.Rect.Right == loose.Rect.Left {
		return math.Max(0, (tight.Right-ox)*dx+(tight.Top-oy)*dy)
	}
	left, bottom, right, top := float64(loose.Rect.Left), float64(loose.Rect.Bottom), float64(loose.Rect.Right), float64(loose.Rect.Top)
	if matrix, err := j.inst.FPDFText_GetMatrix(&requests.FPDFText_GetMatrix{TextPage: textPage, Index: index}); err == nil {
		a, b, c, d := float64(matrix.Matrix.A), float64(matrix.Matrix.B), float64(matrix.Matrix.C), float64(matrix.Matrix.D)
		if math.Abs(b) < 1e-6 && math.Abs(c) > 1e-6 && d != 0 && a > 0 {
			return math.Max(0, (right-left)-math.Abs(c/d)*(top-bottom))
		}
	}
	lo, hi := math.Inf(1), math.Inf(-1)
	for _, corner := range [4][2]float64{{left, bottom}, {right, bottom}, {left, top}, {right, top}} {
		s := (corner[0]-ox)*dx + (corner[1]-oy)*dy
		lo, hi = math.Min(lo, s), math.Max(hi, s)
	}
	return math.Max(0, hi-lo)
}

// images walks the page objects (into form XObjects) in paint order and records every image.
func (j *job) images(page requests.Page, f frame, number int) ([]candidate, error) {
	count, err := j.inst.FPDFPage_CountObjects(&requests.FPDFPage_CountObjects{Page: page})
	if err != nil {
		return nil, err
	}
	var out []candidate
	order := 0
	visited := 0
	var visit func(object references.FPDF_PAGEOBJECT, depth int) error
	visit = func(object references.FPDF_PAGEOBJECT, depth int) error {
		visited++
		if visited > maxObjectsPerPage {
			return errTooManyObjects
		}
		kind, err := j.inst.FPDFPageObj_GetType(&requests.FPDFPageObj_GetType{PageObject: object})
		if err != nil {
			return nil
		}
		switch kind.Type {
		case enums.FPDF_PAGEOBJ_FORM:
			if depth >= maxFormDepth {
				return nil
			}
			children, err := j.inst.FPDFFormObj_CountObjects(&requests.FPDFFormObj_CountObjects{PageObject: object})
			if err != nil {
				return nil
			}
			for k := 0; k < children.Count; k++ {
				child, err := j.inst.FPDFFormObj_GetObject(&requests.FPDFFormObj_GetObject{PageObject: object, Index: uint64(k)})
				if err != nil {
					continue
				}
				if err := visit(child.PageObject, depth+1); err != nil {
					return err
				}
			}
		case enums.FPDF_PAGEOBJ_IMAGE:
			if err := j.ctx.Err(); err != nil {
				return err
			}
			c, ok := j.image(object, page, f, number, order)
			if ok {
				order++
				out = append(out, c)
			}
		}
		return nil
	}
	for i := 0; i < count.Count; i++ {
		object, err := j.inst.FPDFPage_GetObject(&requests.FPDFPage_GetObject{Page: page, Index: i})
		if err != nil {
			continue
		}
		if err := visit(object.PageObject, 0); err != nil {
			if errors.Is(err, errTooManyObjects) {
				break
			}
			return nil, err
		}
	}
	return out, nil
}

// image records one painted image: its box on the page, native size and a hash of its stored bytes
// (the same picture on many pages shares them), and encodes its pixels when the size and area
// filters could keep it.
func (j *job) image(object references.FPDF_PAGEOBJECT, page requests.Page, f frame, number, order int) (candidate, bool) {
	width, height := j.pixelSize(object, page)
	if width <= 0 || height <= 0 {
		return candidate{}, false
	}
	bounds, err := j.inst.FPDFPageObj_GetBounds(&requests.FPDFPageObj_GetBounds{PageObject: object})
	if err != nil {
		return candidate{}, false
	}
	minX, minY, maxX, maxY := f.rect(float64(bounds.Left), float64(bounds.Bottom), float64(bounds.Right), float64(bounds.Top))
	box := Box{
		X: math.Max(0, minX/f.width),
		Y: math.Max(0, minY/f.height),
		W: (maxX - minX) / f.width,
		H: (maxY - minY) / f.height,
	}
	hash := fmt.Sprintf("object:%d:%d", number, order)
	if raw, err := j.inst.FPDFImageObj_GetImageDataRaw(&requests.FPDFImageObj_GetImageDataRaw{ImageObject: object}); err == nil {
		sum := sha1.Sum(raw.Data)
		hash = fmt.Sprintf("%dx%d:%s", width, height, hex.EncodeToString(sum[:]))
	}
	c := candidate{Placement: Placement{Page: number, Order: order, Box: box, Width: width, Height: height, Hash: hash}}
	area := box.W * box.H
	if min(width, height) < 48 || area < 0.01 || area > 0.85 || width*height > maxImagePixels {
		return c, true // KeepImages drops it; no need to decode
	}
	if img := j.render(object, page, width, height); img != nil {
		c.data = encodeWebP(img)
	}
	return c, true
}

func (j *job) pixelSize(object references.FPDF_PAGEOBJECT, page requests.Page) (int, int) {
	if size, err := j.inst.FPDFImageObj_GetImagePixelSize(&requests.FPDFImageObj_GetImagePixelSize{ImageObject: object}); err == nil && size.Width > 0 && size.Height > 0 {
		return int(size.Width), int(size.Height)
	}
	if meta, err := j.inst.FPDFImageObj_GetImageMetadata(&requests.FPDFImageObj_GetImageMetadata{ImageObject: object, Page: page}); err == nil {
		return int(meta.ImageMetadata.Width), int(meta.ImageMetadata.Height)
	}
	return 0, 0
}

// render rasterises an image object at its native size (capped to ImageEdge) with its mask and
// colour space applied. FPDFImageObj_GetRenderedBitmap sizes its output from the object's matrix,
// so the matrix is swapped for the wanted pixel size and put back afterwards; the decoded bitmap
// is the fallback.
func (j *job) render(object references.FPDF_PAGEOBJECT, page requests.Page, width, height int) *rgbaImage {
	scale := math.Min(1, ImageEdge/float64(max(width, height)))
	target := [2]int{int(math.Round(float64(width) * scale)), int(math.Round(float64(height) * scale))}
	if target[0] < 1 || target[1] < 1 {
		return nil
	}
	if matrix, err := j.inst.FPDFPageObj_GetMatrix(&requests.FPDFPageObj_GetMatrix{PageObject: object}); err == nil {
		sized := structs.FPDF_FS_MATRIX{A: float32(target[0]), D: float32(target[1])}
		if _, err := j.inst.FPDFPageObj_SetMatrix(&requests.FPDFPageObj_SetMatrix{PageObject: object, Transform: sized}); err == nil {
			rendered, err := j.inst.FPDFImageObj_GetRenderedBitmap(&requests.FPDFImageObj_GetRenderedBitmap{Document: j.doc, Page: page, ImageObject: object})
			j.inst.FPDFPageObj_SetMatrix(&requests.FPDFPageObj_SetMatrix{PageObject: object, Transform: matrix.Matrix})
			if err == nil {
				img := j.bitmap(rendered.Bitmap)
				j.inst.FPDFBitmap_Destroy(&requests.FPDFBitmap_Destroy{Bitmap: rendered.Bitmap})
				if img != nil {
					return img
				}
			}
		}
	}
	decoded, err := j.inst.FPDFImageObj_GetBitmap(&requests.FPDFImageObj_GetBitmap{ImageObject: object})
	if err != nil {
		return nil
	}
	img := j.bitmap(decoded.Bitmap)
	j.inst.FPDFBitmap_Destroy(&requests.FPDFBitmap_Destroy{Bitmap: decoded.Bitmap})
	if img == nil {
		return nil
	}
	return downscale(img, ImageEdge)
}

// bitmap copies a pdfium bitmap out of WebAssembly memory as straight-alpha RGBA.
func (j *job) bitmap(bitmap references.FPDF_BITMAP) *rgbaImage {
	width, err := j.inst.FPDFBitmap_GetWidth(&requests.FPDFBitmap_GetWidth{Bitmap: bitmap})
	if err != nil {
		return nil
	}
	height, err := j.inst.FPDFBitmap_GetHeight(&requests.FPDFBitmap_GetHeight{Bitmap: bitmap})
	if err != nil {
		return nil
	}
	stride, err := j.inst.FPDFBitmap_GetStride(&requests.FPDFBitmap_GetStride{Bitmap: bitmap})
	if err != nil {
		return nil
	}
	format, err := j.inst.FPDFBitmap_GetFormat(&requests.FPDFBitmap_GetFormat{Bitmap: bitmap})
	if err != nil {
		return nil
	}
	buffer, err := j.inst.FPDFBitmap_GetBuffer(&requests.FPDFBitmap_GetBuffer{Bitmap: bitmap})
	if err != nil {
		return nil
	}
	return rgbaFromBitmap(buffer.Buffer, width.Width, height.Height, stride.Stride, format.Format)
}

// screenshot renders a page for OCR as PNG.
func (j *job) screenshot(number int) ([]byte, error) {
	rendered, err := j.inst.RenderPageInDPI(&requests.RenderPageInDPI{
		Page: requests.Page{ByIndex: &requests.PageByIndex{Document: j.doc, Index: number - 1}},
		DPI:  ocrDPI,
	})
	if err != nil {
		return nil, err
	}
	defer rendered.Cleanup()
	img := rendered.Result.RenderedImage
	if img == nil {
		return nil, errors.New("no image rendered")
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
