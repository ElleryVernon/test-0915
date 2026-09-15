// Package textmatch ports the pure text rules of src/lib/server/algorithms.ts:
// NFKC normalization with JavaScript whitespace folding, and the citation
// guard that keeps generated study items grounded in their source text.
package textmatch

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// MinCitationLen is the shortest normalized citation HasCitation accepts,
// measured like JavaScript's String.length (UTF-16 code units), as the TS
// `needle.length >= 8`.
const MinCitationLen = 8

// Normalized is the TS `text.normalize('NFKC').replace(/\s+/g, ' ').trim()`:
// NFKC first, then every run of JavaScript whitespace becomes one space and
// leading and trailing whitespace is dropped.
func Normalized(s string) string {
	s = norm.NFKC.String(s)
	var b strings.Builder
	b.Grow(len(s))
	pendingSpace := false
	for _, r := range s {
		if isJSSpace(r) {
			pendingSpace = true
			continue
		}
		if pendingSpace && b.Len() > 0 {
			b.WriteByte(' ')
		}
		pendingSpace = false
		b.WriteRune(r)
	}
	return b.String()
}

// isJSSpace reports whether r is in the ECMAScript `\s` class: WhiteSpace
// (TAB, VT, FF, ZWNBSP and every Space_Separator) plus LineTerminator
// (LF, CR, LS, PS). It differs from unicode.IsSpace, which includes U+0085 NEL
// and excludes U+FEFF.
func isJSSpace(r rune) bool {
	switch r {
	case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x2028, 0x2029, 0xFEFF:
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

// UTF16Len is JavaScript's String.length for s: one unit per BMP rune, two per
// supplementary rune. The TS rules measure text with it.
func UTF16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// HasCitation is the TS hasCitation(): the normalized citation is at least
// MinCitationLen long and appears verbatim in the normalized source.
func HasCitation(source, citation string) bool {
	needle := Normalized(citation)
	return UTF16Len(needle) >= MinCitationLen && strings.Contains(Normalized(source), needle)
}
