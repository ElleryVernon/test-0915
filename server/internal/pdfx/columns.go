package pdfx

import (
	"math"
	"sort"
	"strings"
	"unicode/utf8"
)

// readingLines preserves a sustained two-column prose layout before baseline
// grouping. Without this step equally high lines from different columns become
// a single sentence. Short labels/tables alone cannot establish a column gutter.
// Wide headings divide the page into bands, each read left then right.
func readingLines(pieces []Piece, width, height float64) []Line {
	gutter, ok := proseGutter(pieces, width, height)
	if !ok {
		return ToLines(pieces)
	}
	var spanners []Piece
	for _, p := range pieces {
		if p.X < gutter-width*0.12 && p.X+p.Width > gutter+width*0.12 {
			spanners = append(spanners, p)
		}
	}
	sort.SliceStable(spanners, func(i, j int) bool { return spanners[i].Y < spanners[j].Y })
	var out []Line
	group := 0
	appendGroup := func(items []Piece) {
		lines := ToLines(items)
		if len(lines) == 0 {
			return
		}
		group++
		for i := range lines {
			lines[i].readingGroup = group
		}
		out = append(out, lines...)
	}
	appendColumns := func(items []Piece) {
		var left, right []Piece
		for _, p := range items {
			if p.X+p.Width/2 < gutter {
				left = append(left, p)
			} else {
				right = append(right, p)
			}
		}
		appendGroup(left)
		appendGroup(right)
	}
	remaining := append([]Piece(nil), pieces...)
	for _, spanning := range spanners {
		var before, row, after []Piece
		for _, p := range remaining {
			tolerance := math.Max(p.Size, spanning.Size) * 0.4
			switch {
			case p.Y < spanning.Y-tolerance:
				before = append(before, p)
			case p.Y > spanning.Y+tolerance:
				after = append(after, p)
			default:
				row = append(row, p)
			}
		}
		appendColumns(before)
		appendGroup(row)
		remaining = after
	}
	appendColumns(remaining)
	return out
}

func proseGutter(pieces []Piece, width, height float64) (float64, bool) {
	if width <= 0 || height <= 0 {
		return 0, false
	}
	var prose []Piece
	for _, p := range pieces {
		if p.Y < height*0.12 || p.Y > height*0.92 {
			continue
		}
		if p.Width >= width*0.2 && utf8.RuneCountInString(p.Str) >= 32 && len(strings.Fields(p.Str)) >= 4 {
			prose = append(prose, p)
		}
	}
	best, bestScore := 0.0, math.Inf(-1)
	for step := 35; step <= 65; step++ {
		x := width * float64(step) / 100
		left, right, cross := 0, 0, 0
		for _, p := range prose {
			switch {
			case p.X+p.Width <= x:
				left++
			case p.X >= x:
				right++
			default:
				cross++
			}
		}
		// At least six long lines on each side and no more than a small
		// minority of crossing prose: retain the old path for ambiguous pages.
		if left < 6 || right < 6 || cross*5 > left+right {
			continue
		}
		score := float64(min(left, right)*4-cross*8) - math.Abs(float64(step)-50)*0.1
		if score > bestScore {
			best, bestScore = x, score
		}
	}
	return best, bestScore > math.Inf(-1)
}
