package ai

import (
	"context"
	"log/slog"
	"os"
	"testing"

	"memoryz/server/internal/config"
)

// TestLiveOCR is an opt-in probe against the real provider (one small OCR call, billable):
// MEMORYZ_LIVE_AI=1 with OPENROUTER_API_KEY and OPENROUTER_MODEL in the environment.
func TestLiveOCR(t *testing.T) {
	if os.Getenv("MEMORYZ_LIVE_AI") != "1" {
		t.Skip("set MEMORYZ_LIVE_AI=1 to spend one model call")
	}
	cfg, err := config.Load(os.LookupEnv)
	if err != nil {
		t.Fatal(err)
	}
	p := NewProvider(cfg, cfg.OpenRouterBaseURL, slog.Default())
	img, err := renderOCRImage("MEMORYZ TEST 42")
	if err != nil {
		t.Fatal(err)
	}
	ctx, usage := CaptureUsage(context.Background())
	text, err := ExtractImageText(ctx, p, img, "image/png")
	if err != nil {
		t.Fatalf("live ocr: %v", err)
	}
	t.Logf("ocr=%q usage=%+v", text, usage.Requests())
	if !ocrPattern.MatchString(text) {
		t.Fatalf("ocr read %q", text)
	}
}
