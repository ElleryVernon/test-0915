package pdfx

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"
)

// Construct a real minimal PDF with synthetic, non-copyrighted prose. This tests
// the complete PDFium -> pieces -> column order -> paragraph integration.
func TestPDFTwoColumns(t *testing.T) {
	var stream strings.Builder
	stream.WriteString("BT /F1 9 Tf\n")
	for i := 0; i < 8; i++ {
		fmt.Fprintf(&stream, "1 0 0 1 45 %d Tm (Enzymes lower activation energy for reaction step %d) Tj\n", 650-i*14, i)
		fmt.Fprintf(&stream, "1 0 0 1 325 %d Tm (Equilibrium remains unchanged by the catalyst step %d) Tj\n", 650-i*14, i)
	}
	stream.WriteString("ET")
	objects := []string{"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", stream.Len(), stream.String())}
	var pdf bytes.Buffer
	pdf.WriteString("%PDF-1.4\n")
	offsets := []int{0}
	for i, obj := range objects {
		offsets = append(offsets, pdf.Len())
		fmt.Fprintf(&pdf, "%d 0 obj\n%s\nendobj\n", i+1, obj)
	}
	xref := pdf.Len()
	fmt.Fprintf(&pdf, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))
	for _, off := range offsets[1:] {
		fmt.Fprintf(&pdf, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&pdf, "trailer << /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), xref)
	result, err := Extract(context.Background(), pdf.Bytes(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Diagnostics) != 1 || !result.Diagnostics[0].TwoColumns {
		t.Fatalf("column diagnostics missing: %+v", result.Diagnostics)
	}
	leftEnd := strings.Index(result.Text, "reaction step 7")
	rightStart := strings.Index(result.Text, "Equilibrium remains")
	if leftEnd < 0 || rightStart < leftEnd {
		t.Fatalf("PDF prose interleaved: %s", result.Text)
	}
	if strings.Count(result.Text, "Enzymes lower") != 8 || strings.Count(result.Text, "Equilibrium remains") != 8 {
		t.Fatalf("text lost: %s", result.Text)
	}
}

func TestReadingColumns(t *testing.T) {
	var pieces []Piece
	for i := 0; i < 8; i++ {
		pieces = append(pieces, piece(fmt.Sprintf("Left column sentence continues across line %d", i), 50, 150+float64(i)*14, 220, 10))
		pieces = append(pieces, piece(fmt.Sprintf("Right column has a separate sentence line %d", i), 330, 150+float64(i)*14, 220, 10))
	}
	// Full-width title is read first, followed by all left-column prose.
	pieces = append(pieces, piece("A full width chapter heading preceding both columns", 50, 90, 500, 16))
	lines := readingLines(pieces, 600, 800)
	if len(lines) != 17 {
		t.Fatalf("got %d lines, want separate column lines", len(lines))
	}
	if !strings.HasPrefix(lines[1].Text, "Left") || !strings.HasPrefix(lines[8].Text, "Left") || !strings.HasPrefix(lines[9].Text, "Right") {
		t.Fatalf("interleaved columns: %v", texts(lines))
	}
	blocks := ToParagraphs(lines, nil)
	if len(blocks) != 3 || strings.Contains(blocks[1].Text, "Right") || strings.Contains(blocks[2].Text, "Left") {
		t.Fatalf("paragraphs crossed columns: %v", blockTexts(blocks))
	}
	// A page-spanning heading between two column sections restores top-to-bottom
	// order between bands rather than putting both left sections first.
	pieces = append(pieces, piece("A second full width heading between column sections", 50, 300, 500, 16))
	pieces = append(pieces, piece("Lower left column prose continues here after heading", 50, 340, 220, 10))
	pieces = append(pieces, piece("Lower right column prose continues after the heading", 330, 340, 220, 10))
	lines = readingLines(pieces, 600, 800)
	if !strings.HasPrefix(lines[17].Text, "A second") || !strings.HasPrefix(lines[18].Text, "Lower left") || !strings.HasPrefix(lines[19].Text, "Lower right") {
		t.Fatalf("spanning heading order: %v", texts(lines))
	}
}

func TestReadingColumnsNegativeControls(t *testing.T) {
	var single []Piece
	for i := 0; i < 20; i++ {
		single = append(single, piece("Single column prose stretches across the page and must remain in its original sequence", 50, 150+float64(i)*14, 500, 10))
	}
	if _, ok := proseGutter(single, 600, 800); ok {
		t.Fatal("single column falsely split")
	}
	// A chemistry diagram's isolated labels and an ordinary table do not prove
	// that the page has two prose columns.
	var labels []Piece
	for i := 0; i < 20; i++ {
		labels = append(labels, piece("CH3", 50, 150+float64(i)*14, 40, 10), piece("Carbon", 330, 150+float64(i)*14, 40, 10))
	}
	if _, ok := proseGutter(labels, 600, 800); ok {
		t.Fatal("diagram labels falsely establish columns")
	}
	if len(readingLines(labels, 600, 800)) != 20 {
		t.Fatal("label-only page changed baseline layout")
	}
}
