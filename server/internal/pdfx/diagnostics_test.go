package pdfx

import (
	"strings"
	"testing"
)

func TestSymbolWarningPreservesOCRWarnings(t *testing.T) {
	for _, base := range []string{"", warningNoTextLayer, "2쪽은 이미지로만 되어 있어 본문에 넣지 못했어요."} {
		for _, flagged := range []PageDiagnostics{{UnmappedCharacters: 1}, {ControlCharacters: 1}, {ReplacementCharacters: 1}, {PrivateUseCharacters: 1}} {
			got := withSymbolWarning(base, []PageDiagnostics{flagged, flagged})
			if !strings.HasPrefix(got, base) || strings.Count(got, warningScientificSymbols) != 1 {
				t.Fatalf("existing warning lost or symbol warning duplicated: %q", got)
			}
		}
	}
}

func TestCleanTextAndVectorPathsDoNotClaimGlyphFailure(t *testing.T) {
	// Many PDFs use vector paths for borders. Geometry alone is not evidence
	// that a scientific symbol was lost or a picture was understood.
	for _, d := range [][]PageDiagnostics{nil, {{RawCharacters: 100, VectorPaths: 50, ImageObjects: 3}}} {
		if got := withSymbolWarning("", d); got != "" {
			t.Fatalf("unfounded symbol warning: %q", got)
		}
	}
}
