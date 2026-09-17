package ai

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
)

type occlusionStub struct {
	output any
	err    error
	calls  int
}

func (s *occlusionStub) JSON(_ context.Context, prompt string, _ map[string]any, name string, image *Image) (any, error) {
	s.calls++
	if image == nil || len(image.Data) == 0 || name != "memoryz_occlusion_preview" || !strings.Contains(prompt, "실제로 보이는") {
		return nil, errors.New("missing grounded vision contract")
	}
	return s.output, s.err
}
func validOcclusionRaw() map[string]any {
	return map[string]any{"regions": []any{map[string]any{"x": float64(10), "y": float64(20), "width": float64(20), "height": float64(5), "answer": "미토콘드리아"}}}
}

func TestOcclusionVisionPreview(t *testing.T) {
	p := &occlusionStub{output: validOcclusionRaw()}
	result, err := SuggestOcclusion(context.Background(), p, []byte("image bytes"), "image/png")
	if err != nil || len(result.Regions) != 1 || result.Regions[0].Answer != "미토콘드리아" || p.calls != 1 {
		t.Fatalf("%+v %v calls %d", result, err, p.calls)
	}
	p.output = map[string]any{"regions": []any{}}
	result, err = SuggestOcclusion(context.Background(), p, []byte("image"), "image/png")
	if err != nil || len(result.Regions) != 0 {
		t.Fatalf("empty image should have no invented masks: %+v %v", result, err)
	}
}
func TestOcclusionRejectsMalformedOrUnusableRegions(t *testing.T) {
	for name, change := range map[string]func(map[string]any){
		"negative":           func(r map[string]any) { r["x"] = -1.0 },
		"outside image":      func(r map[string]any) { r["x"] = 99.0 },
		"zero area":          func(r map[string]any) { r["width"] = 0.0 },
		"whole page":         func(r map[string]any) { r["width"] = 90.0; r["height"] = 80.0; r["y"] = 0.0 },
		"nan":                func(r map[string]any) { r["x"] = math.NaN() },
		"infinity":           func(r map[string]any) { r["x"] = math.Inf(1) },
		"missing coordinate": func(r map[string]any) { delete(r, "height") },
		"text coordinate":    func(r map[string]any) { r["height"] = "5" },
		"blank label":        func(r map[string]any) { r["answer"] = " " },
		"long label":         func(r map[string]any) { r["answer"] = strings.Repeat("가", 201) },
	} {
		t.Run(name, func(t *testing.T) {
			raw := validOcclusionRaw()
			change(raw["regions"].([]any)[0].(map[string]any))
			if _, err := validateOcclusion(raw); err == nil {
				t.Fatal("unsafe region accepted")
			}
		})
	}
	for _, raw := range []any{nil, map[string]any{}, map[string]any{"regions": nil}, map[string]any{"regions": make([]any, 13)}} {
		if _, err := validateOcclusion(raw); err == nil {
			t.Fatal("invalid list accepted")
		}
	}
	raw := validOcclusionRaw()
	raw["regions"] = append(raw["regions"].([]any), raw["regions"].([]any)[0])
	if _, err := validateOcclusion(raw); err == nil {
		t.Fatal("duplicate region accepted")
	}
}
func TestOcclusionFailureDoesNotRetryOrInventMasks(t *testing.T) {
	failure := errors.New("provider failed")
	p := &occlusionStub{err: failure}
	if _, err := SuggestOcclusion(context.Background(), p, []byte("image"), "image/png"); !errors.Is(err, failure) || p.calls != 1 {
		t.Fatalf("%v calls %d", err, p.calls)
	}
	if _, err := SuggestOcclusion(context.Background(), p, nil, "image/png"); err == nil || p.calls != 1 {
		t.Fatal("empty file contacted model")
	}
	if _, err := SuggestOcclusion(context.Background(), p, []byte("image"), "text/plain"); err == nil || p.calls != 1 {
		t.Fatal("text file contacted model")
	}
}
