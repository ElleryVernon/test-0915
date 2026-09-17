package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"sync"

	"memoryz/server/internal/ai"
	"memoryz/server/internal/config"
	"memoryz/server/internal/planner"
)

var executableFingerprint struct {
	once sync.Once
	hash string
	err  error
}

// A skill version can remain unchanged while its implementation is edited.
// Fingerprint the executable once so resumes require the same frozen program.
func currentBinarySHA256() (string, error) {
	executableFingerprint.once.Do(func() {
		path, err := os.Executable()
		if err != nil {
			executableFingerprint.err = err
			return
		}
		f, err := os.Open(path)
		if err != nil {
			executableFingerprint.err = err
			return
		}
		defer f.Close()
		h := sha256.New()
		if _, err := io.Copy(h, f); err != nil {
			executableFingerprint.err = err
			return
		}
		executableFingerprint.hash = hex.EncodeToString(h.Sum(nil))
	})
	return executableFingerprint.hash, executableFingerprint.err
}

// loadProductCheckpoints only reads completed local product evidence. A caller
// must additionally compare each Result.InputHash with its queued Case hash.
// Infrastructure failures are deliberately absent from the returned map; a
// terminal quality refusal remains present so resuming cannot improve its score
// by silently generating another answer.
func loadProductCheckpoints(path string, cfg *config.Config, inputHash string, count int) (map[string]Result, error) {
	if cfg == nil || strings.TrimSpace(inputHash) == "" || count < 1 {
		return nil, fmt.Errorf("checkpoint: invalid expected configuration")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("checkpoint: read report: %w", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, fmt.Errorf("checkpoint: decode report: %w", err)
	}
	// Presence matters: absent false/zero/empty metadata must not masquerade as
	// an explicit match to the current configuration.
	for _, key := range []string{"checkpointVersion", "binarySHA256", "judgeEnabled", "model", "productionQualityReview", "productionReviewModel", "reasoningEffort", "providerOrder", "structuredMode", "inputHash", "requestedCount", "productBudgetMs", "results"} {
		value, exists := fields[key]
		if !exists || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, fmt.Errorf("checkpoint: missing required %s", key)
		}
	}
	var report struct {
		CheckpointVersion       int               `json:"checkpointVersion"`
		BinarySHA256            string            `json:"binarySHA256"`
		JudgeEnabled            bool              `json:"judgeEnabled"`
		Model                   string            `json:"model"`
		ProductionQualityReview bool              `json:"productionQualityReview"`
		ProductionReviewModel   string            `json:"productionReviewModel"`
		ReasoningEffort         string            `json:"reasoningEffort"`
		ProviderOrder           []string          `json:"providerOrder"`
		StructuredMode          string            `json:"structuredMode"`
		InputHash               string            `json:"inputHash"`
		RequestedCount          int               `json:"requestedCount"`
		ProductBudgetMs         int64             `json:"productBudgetMs"`
		Results                 []json.RawMessage `json:"results"`
	}
	if err := json.Unmarshal(raw, &report); err != nil {
		return nil, fmt.Errorf("checkpoint: decode metadata: %w", err)
	}
	binaryHash, err := currentBinarySHA256()
	if err != nil {
		return nil, fmt.Errorf("checkpoint: fingerprint executable: %w", err)
	}
	checks := []struct {
		name  string
		match bool
	}{
		{"checkpointVersion", report.CheckpointVersion == 1},
		{"binarySHA256", report.BinarySHA256 == binaryHash},
		{"judgeEnabled", !report.JudgeEnabled},
		{"model", report.Model == cfg.OpenRouterModel},
		{"productionQualityReview", report.ProductionQualityReview == cfg.AIQualityReview},
		{"productionReviewModel", report.ProductionReviewModel == cfg.OpenRouterQualityModel},
		{"reasoningEffort", report.ReasoningEffort == cfg.OpenRouterEffort},
		{"providerOrder", slices.Equal(report.ProviderOrder, cfg.OpenRouterProviderOrder)},
		{"structuredMode", report.StructuredMode == cfg.OpenRouterStructuredMode},
		{"inputHash", report.InputHash == inputHash},
		{"requestedCount", report.RequestedCount == count},
		{"productBudgetMs", report.ProductBudgetMs == ai.RequestTimeout.Milliseconds()},
	}
	for _, check := range checks {
		if !check.match {
			return nil, fmt.Errorf("checkpoint: %s mismatch", check.name)
		}
	}
	kept := make(map[string]Result, len(report.Results))
	seen := make(map[string]bool, len(report.Results))
	for index, rawResult := range report.Results {
		// Shadow this bookkeeping field so a resumed snapshot still returns the
		// original evidence with CheckpointReused at its zero value. The caller
		// owns marking which rows it actually reuses.
		var saved struct {
			Result
			CheckpointReused json.RawMessage `json:"checkpointReused"`
		}
		if err := json.Unmarshal(rawResult, &saved); err != nil {
			return nil, fmt.Errorf("checkpoint: result %d: %w", index, err)
		}
		r := saved.Result
		base, suffix, hasSuffix := strings.Cut(r.Task, "/")
		if strings.TrimSpace(r.CaseID) == "" || (base == "grade" && (!hasSuffix || strings.TrimSpace(suffix) == "")) || (base != "grade" && hasSuffix) {
			return nil, fmt.Errorf("checkpoint: result %d has invalid case/task key", index)
		}
		skill, exists := ai.Skills[ai.Kind(base)]
		if !exists || (base != "quiz" && base != "essay" && base != "cards" && base != "grade") {
			return nil, fmt.Errorf("checkpoint: unknown task %q", r.Task)
		}
		key := r.CaseID + "--" + r.Task
		if seen[key] {
			return nil, fmt.Errorf("checkpoint: duplicate result %q", key)
		}
		seen[key] = true
		if r.SkillVersion != skill.Version {
			return nil, fmt.Errorf("checkpoint: skill version mismatch for %s", key)
		}
		if r.Judge != nil {
			return nil, fmt.Errorf("checkpoint: offline judgment in product result %s", key)
		}
		if r.InfrastructureError {
			continue
		}
		if strings.TrimSpace(r.Error) == "" && !usableCheckpointOutput(r.Output, base, count) {
			return nil, fmt.Errorf("checkpoint: no usable output or explicit error for %s", key)
		}
		kept[key] = r
	}
	return kept, nil
}

// This is a shape check, not a second quality judgment. Scores, failures, usage,
// and content are returned unchanged. Semantic failures stay in the denominator.
func usableCheckpointOutput(output any, task string, count int) bool {
	if output == nil {
		return false
	}
	raw, err := json.Marshal(output)
	if err != nil {
		return false
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || len(object) == 0 {
		return false
	}
	if task == "grade" {
		var grade planner.GradeResult
		return len(object["score"]) > 0 && !bytes.Equal(object["score"], []byte("null")) && json.Unmarshal(raw, &grade) == nil && grade.Score >= 0 && grade.Score <= 100 && strings.TrimSpace(grade.Feedback) != ""
	}
	var items ai.Items
	if json.Unmarshal(raw, &items) != nil {
		return false
	}
	switch task {
	case "quiz":
		if len(items.Questions) != count {
			return false
		}
		for _, q := range items.Questions {
			if strings.TrimSpace(q.Prompt) == "" || len(q.Options) != 5 || q.Answer < 0 || q.Answer >= 5 || strings.TrimSpace(q.Explanation) == "" || strings.TrimSpace(q.Citation) == "" {
				return false
			}
		}
	case "essay":
		if len(items.Essays) != count {
			return false
		}
		for _, e := range items.Essays {
			if strings.TrimSpace(e.Prompt) == "" || strings.TrimSpace(e.ModelAnswer) == "" || strings.TrimSpace(e.Citation) == "" {
				return false
			}
		}
	case "cards":
		if len(items.Cards) != count {
			return false
		}
		for _, c := range items.Cards {
			if strings.TrimSpace(c.Front) == "" || strings.TrimSpace(c.Back) == "" || strings.TrimSpace(c.Citation) == "" {
				return false
			}
		}
	default:
		return false
	}
	return true
}
