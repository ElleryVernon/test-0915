package pdfx

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"
)

func selectionFixture() []byte {
	objects := []string{"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>"}
	for i := 0; i < 3; i++ {
		objects = append(objects, fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 9 0 R >> >> /Contents %d 0 R >>", 6+i))
	}
	for _, label := range []string{"First excluded page", "Second selected page", "Third selected page"} {
		stream := "BT /F1 12 Tf 40 650 Td (" + label + ") Tj ET\n50 400 150 100 re S"
		objects = append(objects, fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(stream), stream))
	}
	objects = append(objects, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
	var pdf bytes.Buffer
	pdf.WriteString("%PDF-1.4\n")
	offsets := []int{0}
	for i, obj := range objects {
		offsets = append(offsets, pdf.Len())
		fmt.Fprintf(&pdf, "%d 0 obj\n%s\nendobj\n", i+1, obj)
	}
	xref := pdf.Len()
	fmt.Fprintf(&pdf, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&pdf, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&pdf, "trailer << /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), xref)
	return pdf.Bytes()
}

func TestSelectPagesRetainsTextAndVectorDrawings(t *testing.T) {
	original := selectionFixture()
	before := append([]byte(nil), original...)
	selected, err := SelectPages(context.Background(), original, []int{2, 3})
	if err != nil {
		t.Fatal(err)
	}
	out, err := Extract(context.Background(), selected, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if out.Pages != 2 || strings.Contains(out.Text, "excluded") || !strings.Contains(out.Text, "Second selected") || !strings.Contains(out.Text, "Third selected") {
		t.Fatalf("incorrect subset: %#v", out)
	}
	if out.Diagnostics[0].VectorPaths == 0 || out.Diagnostics[1].VectorPaths == 0 {
		t.Fatal("vector drawings lost")
	}
	if !bytes.Equal(before, original) {
		t.Fatal("original was changed")
	}
	for _, pages := range [][]int{nil, {}, {0}, {4}, {2, 2}, {3, 1}} {
		if _, err := SelectPages(context.Background(), original, pages); err == nil {
			t.Fatalf("invalid selection accepted: %v", pages)
		}
	}
}
