package ai

import (
	"context"
	"encoding/json"
	"sort"
	"sync"
)

const responseCaptureLimit = 4

// ModelResponse contains only a completed, decoded model payload. It is not an
// HTTP exchange or proof that a downstream grade validator accepted the payload.
type ModelResponse struct {
	Task        string          `json:"task"`
	DecodedJSON json.RawMessage `json:"decodedJSON"`
}

type responseCaptureKey struct{}

type capturedResponse struct {
	order uint64
	value ModelResponse
}

// ResponseCollector is an explicit offline diagnostic. Request prompts, keys,
// headers, provider envelopes and failed requests are never added to it.
type ResponseCollector struct {
	mu      sync.Mutex
	next    uint64
	entries []capturedResponse
}

// CaptureResponses opts this context into bounded grade-response capture. It
// neither enables logging nor changes normal product calls. Use a fresh context
// for each evaluated answer; nested calls share that answer's four-response cap.
func CaptureResponses(ctx context.Context) (context.Context, *ResponseCollector) {
	c := &ResponseCollector{}
	return context.WithValue(ctx, responseCaptureKey{}, c), c
}

// Responses returns detached JSON copies in request-start order. A failed call
// contributes no entry, so these entries must not be zipped with usage/errors.
func (c *ResponseCollector) Responses() []ModelResponse {
	c.mu.Lock()
	defer c.mu.Unlock()
	result := make([]ModelResponse, len(c.entries))
	for i, entry := range c.entries {
		result[i] = ModelResponse{Task: entry.value.Task, DecodedJSON: append(json.RawMessage(nil), entry.value.DecodedJSON...)}
	}
	return result
}

func responseRecorder(ctx context.Context, task string) func(any) {
	if task != "memoryz_essay_grade" && task != "memoryz_essay_grade_review" {
		return nil
	}
	c, ok := ctx.Value(responseCaptureKey{}).(*ResponseCollector)
	if !ok {
		return nil
	}
	c.mu.Lock()
	order := c.next
	c.next++
	c.mu.Unlock()
	return func(value any) {
		// Encode before returning the provider's mutable map to its caller. JSON
		// is copied again on read, so neither side can mutate captured evidence.
		payload, err := json.Marshal(value)
		if err != nil {
			return
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		c.entries = append(c.entries, capturedResponse{order: order, value: ModelResponse{Task: task, DecodedJSON: payload}})
		sort.Slice(c.entries, func(i, j int) bool { return c.entries[i].order < c.entries[j].order })
		if len(c.entries) > responseCaptureLimit {
			c.entries[responseCaptureLimit] = capturedResponse{}
			c.entries = c.entries[:responseCaptureLimit]
		}
	}
}
