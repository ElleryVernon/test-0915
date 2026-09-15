package ai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"memoryz/server/internal/apierr"
)

type leakedFixture struct {
	Source string          `json:"source"`
	Leaked json.RawMessage `json:"leaked"`
	Clean  json.RawMessage `json:"clean"`
}

func loadLeaked(t *testing.T) (string, any, any) {
	t.Helper()
	raw, err := os.ReadFile("testdata/leaked-cards.json")
	if err != nil {
		t.Fatal(err)
	}
	var f leakedFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	var leaked, clean any
	_ = json.Unmarshal(f.Leaked, &leaked)
	_ = json.Unmarshal(f.Clean, &clean)
	return f.Source, leaked, clean
}

func statusOf(err error) int {
	var e *apierr.Error
	if errors.As(err, &e) {
		return e.Status
	}
	return 0
}

// fakeModel answers each request from a queue and records the prompts it received.
type fakeModel struct {
	calls   atomic.Int32
	prompts []string
	answers []any
}

func (f *fakeModel) provider(t *testing.T) *Provider {
	return testProvider(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.Unmarshal(raw, &body)
		n := int(f.calls.Add(1)) - 1
		f.prompts = append(f.prompts, body.Messages[1].Content)
		answer := f.answers[len(f.answers)-1]
		if n < len(f.answers) {
			answer = f.answers[n]
		}
		args, _ := json.Marshal(answer)
		quoted, _ := json.Marshal(string(args))
		_, _ = io.WriteString(w, `{"id":"gen-`+string(rune('a'+n))+`","model":"openai/gpt-5.6-luna","provider":"OpenAI","choices":[{"finish_reason":"stop","message":{"tool_calls":[{"function":{"name":"memoryz_cards","arguments":`+string(quoted)+`}}]}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.001,"completion_tokens_details":{"reasoning_tokens":2}}}`)
	})
}

func TestPromptsAreModeSpecific(t *testing.T) {
	source := "나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다. 칼륨 이온이 세포 밖으로 나가면 재분극이 일어난다."
	cards := generationPrompt(KindCards, 3, source, "")
	quiz := generationPrompt(KindQuiz, 3, source, "")
	essay := generationPrompt(KindEssay, 3, source, "")
	for _, banned := range []string{"5지선다", "distractors", "keywords", "options", "answer"} {
		if strings.Contains(cards, banned) {
			t.Fatalf("cards prompt still carries %q", banned)
		}
	}
	for _, banned := range []string{"front", "back", "distractors", "modelAnswer", "플래시카드"} {
		if strings.Contains(quiz, banned) {
			t.Fatalf("quiz prompt still carries %q", banned)
		}
	}
	for _, banned := range []string{"5지선다", "front", "back", "options", "past", "플래시카드"} {
		if strings.Contains(essay, banned) {
			t.Fatalf("essay prompt still carries %q", banned)
		}
	}
	for _, want := range []string{"front", "back", "정답:", "CONCEPT", "RELATION", "COMPARISON", "citation", "<source>"} {
		if !strings.Contains(cards, want) {
			t.Fatalf("cards prompt lacks %q", want)
		}
	}
	for _, want := range []string{"options", "answer", "explanation", "past", "future", "번호나 기호 없이"} {
		if !strings.Contains(quiz, want) {
			t.Fatalf("quiz prompt lacks %q", want)
		}
	}
	for _, want := range []string{"keywords", "distractors", "modelAnswer", "원인부터 결과"} {
		if !strings.Contains(essay, want) {
			t.Fatalf("essay prompt lacks %q", want)
		}
	}
	if !strings.HasPrefix(cards, Instructions(KindCards)) || !strings.Contains(cards, "정확히 3개") {
		t.Fatalf("skill header and count: %s", cards[:80])
	}
	corrected := generationPrompt(KindCards, 3, source, errFormatLeak.Message)
	if !strings.Contains(corrected, "<previous_attempt_problem>") || !strings.Contains(corrected, errFormatLeak.Message) {
		t.Fatal("the second attempt must carry the refusal reason")
	}
	if strings.Contains(cards, "<previous_attempt_problem>") {
		t.Fatal("the first attempt carries no feedback block")
	}
}

func TestLeakedCloudResultRefused(t *testing.T) {
	source, leaked, clean := loadLeaked(t)
	if _, err := parseItems(leaked, KindCards, 3, source); statusOf(err) != 422 || !errors.Is(err, errFormatLeak) {
		t.Fatalf("the cloud result that mixed quiz and essay text into card backs must be refused: %v", err)
	}
	items, err := parseItems(clean, KindCards, 3, source)
	if err != nil || len(items.Cards) != 3 {
		t.Fatalf("negative control: the clean fixture must pass: %v", err)
	}
	// Each guard on its own.
	card := func(front, back string) any {
		return map[string]any{"items": []any{map[string]any{"front": front, "back": back, "type": "CONCEPT", "citation": "칼륨 이온이 세포 밖으로 이동하여 재분극이 일어난다."}}}
	}
	if _, err := parseItems(card("재분극이란?", "정답: ② 칼륨 이온이 나간다."), KindCards, 1, source); !errors.Is(err, errFormatLeak) {
		t.Fatalf("answer header: %v", err)
	}
	if _, err := parseItems(card("재분극이란?", "칼륨 이온이 나간다.\n1. 첫째\n2. 둘째"), KindCards, 1, source); !errors.Is(err, errFormatLeak) {
		t.Fatalf("enumerated list: %v", err)
	}
	if _, err := parseItems(card("재분극", "재분극"), KindCards, 1, source); !errors.Is(err, errSameSides) {
		t.Fatalf("same sides: %v", err)
	}
	two := map[string]any{"items": []any{
		map[string]any{"front": "재분극이란?", "back": "칼륨 이온이 나간다.", "type": "CONCEPT", "citation": "칼륨 이온이 세포 밖으로 이동하여 재분극이 일어난다."},
		map[string]any{"front": "재분극이란 ?", "back": "칼륨 이온이 세포 밖으로 나간다.", "type": "RELATION", "citation": "칼륨 이온이 세포 밖으로 이동하여 재분극이 일어난다."},
	}}
	if _, err := parseItems(two, KindCards, 2, source); !errors.Is(err, errDuplicateItems) {
		t.Fatalf("duplicate fronts: %v", err)
	}
	quiz := func(options []any, explanation string) any {
		return map[string]any{"items": []any{map[string]any{"prompt": "탈분극을 일으키는 이온은?", "options": options, "answer": 0, "explanation": explanation, "citation": "나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.", "past": "세포막", "future": "막전위"}}}
	}
	options := func(opts ...string) string {
		list := make([]any, len(opts))
		for i, o := range opts {
			list[i] = o
		}
		got, err := parseItems(quiz(list, "나트륨 이온이 유입됩니다."), KindQuiz, 1, source)
		if err != nil {
			return "ERR " + err.Error()
		}
		return strings.Join(got.Questions[0].Options, "|")
	}
	// A consistent marker family, in order, is stripped.
	for _, set := range [][]string{
		{"① 나트륨", "② 칼륨", "③ 칼슘", "④ 염소", "⑤ 마그네슘"},
		{"1. 나트륨", "2. 칼륨", "3. 칼슘", "4. 염소", "5. 마그네슘"},
		{"(1) 나트륨", "(2) 칼륨", "(3) 칼슘", "(4) 염소", "(5) 마그네슘"},
		{"0) 나트륨", "1) 칼륨", "2) 칼슘", "3) 염소", "4) 마그네슘"},
		{"A) 나트륨", "B) 칼륨", "C) 칼슘", "D) 염소", "E) 마그네슘"},
		{"가. 나트륨", "나. 칼륨", "다. 칼슘", "라. 염소", "마. 마그네슘"},
	} {
		if got := options(set...); got != "나트륨|칼륨|칼슘|염소|마그네슘" {
			t.Fatalf("markers of one family are stripped: %v → %s", set, got)
		}
	}
	// Anything else is content and stays: decimals, names, mixed or out-of-order markers.
	for _, set := range [][]string{
		{"0.5", "1.5", "2.5", "3.5", "4.5"},
		{"1.0", "2.0", "3.0", "4.0", "5.0"},
		{"E. coli는 원핵생물이다", "효모는 진핵생물이다", "곰팡이는 균류다", "바이러스는 세포가 없다", "짚신벌레는 원생생물이다"},
		{"① 나트륨", "2. 칼륨", "C) 칼슘", "라. 염소", "(5) 마그네슘"},
		{"② 나트륨", "① 칼륨", "③ 칼슘", "④ 염소", "⑤ 마그네슘"},
	} {
		if got := options(set...); got != strings.Join(set, "|") {
			t.Fatalf("content is not cut: %v → %s", set, got)
		}
	}
	if _, err := parseItems(quiz([]any{"① 나트륨", "② 나트륨", "③ 칼슘", "④ 염소", "⑤ 마그네슘"}, "나트륨 이온이 유입됩니다."), KindQuiz, 1, source); !errors.Is(err, errDuplicateOpts) {
		t.Fatalf("options equal after stripping are duplicates: %v", err)
	}
	// A decimal or a name at the start of prose lines is not a list.
	if _, err := parseItems(card("재분극 뒤 막전위는?", "1.5배 가까이 회복된다.\n2.0 이상은 과분극이다."), KindCards, 1, source); err != nil {
		t.Fatalf("decimals are not list markers: %v", err)
	}
	if _, err := parseItems(quiz([]any{"나트륨", "칼륨", "칼슘", "염소", "마그네슘"}, "정답: ① 나트륨 이온이 유입됩니다."), KindQuiz, 1, source); !errors.Is(err, errFormatLeak) {
		t.Fatalf("answer header in explanation: %v", err)
	}
	essay := func(keywords []any, modelAnswer string) any {
		return map[string]any{"items": []any{map[string]any{"prompt": "탈분극 과정을 설명하세요.", "keywords": keywords, "distractors": []any{"항체", "호르몬", "광합성", "효소"}, "modelAnswer": modelAnswer, "citation": "나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다."}}}
	}
	if _, err := parseItems(essay([]any{"자극", "나트륨 이온", "유입", "탈분극"}, "역치 이상의 자극이 오면 나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다."), KindEssay, 1, source); err != nil {
		t.Fatalf("keywords present in the model answer pass: %v", err)
	}
	if _, err := parseItems(essay([]any{"자극", "나트륨 이온", "유입", "재분극"}, "역치 이상의 자극이 오면 나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다."), KindEssay, 1, source); !errors.Is(err, errKeywordMissing) {
		t.Fatalf("a keyword absent from the model answer is refused: %v", err)
	}
}

func TestSelfCorrection(t *testing.T) {
	source, leaked, clean := loadLeaked(t)
	// A leaked first answer is corrected by one more call that carries the reason.
	model := &fakeModel{answers: []any{leaked, clean}}
	items, err := GenerateItems(context.Background(), model.provider(t), source, KindCards, 3)
	if err != nil || len(items.Cards) != 3 {
		t.Fatalf("second attempt must succeed: %v", err)
	}
	if model.calls.Load() != 2 || !strings.Contains(model.prompts[1], errFormatLeak.Message) || strings.Contains(model.prompts[0], "<previous_attempt_problem>") {
		t.Fatalf("exactly two calls, the second with feedback: calls=%d", model.calls.Load())
	}
	// A clean first answer costs one call.
	model = &fakeModel{answers: []any{clean}}
	if _, err := GenerateItems(context.Background(), model.provider(t), source, KindCards, 3); err != nil || model.calls.Load() != 1 {
		t.Fatalf("clean answer: %v calls=%d", err, model.calls.Load())
	}
	// Two bad answers end with the validator's refusal and never a third call.
	model = &fakeModel{answers: []any{leaked, leaked}}
	_, err = GenerateItems(context.Background(), model.provider(t), source, KindCards, 3)
	if statusOf(err) != 422 || model.calls.Load() != 2 {
		t.Fatalf("bounded retry: %v calls=%d", err, model.calls.Load())
	}
	// The recorded stages stay LOAD_CONTEXT/GENERATE/VALIDATE with the retry inside GENERATE.
	rt := NewRuntime(KindCards, nil)
	model = &fakeModel{answers: []any{leaked, clean}}
	if _, err := GenerateItems(WithRuntime(context.Background(), rt), model.provider(t), source, KindCards, 3); err != nil {
		t.Fatal(err)
	}
	stages := []string{}
	for _, s := range rt.Steps {
		stages = append(stages, s.Stage+":"+s.Status)
	}
	if strings.Join(stages, ",") != "LOAD_CONTEXT:COMPLETED,GENERATE:COMPLETED,VALIDATE:COMPLETED" {
		t.Fatalf("stages: %v", stages)
	}
}

// TestProviderParity pins the request body to the Next.js provider (server/testdata/reference/provider.ts).
func TestProviderParity(t *testing.T) {
	var body map[string]any
	p := testProvider(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		if r.Header.Get("X-OpenRouter-Title") != "Memoryz" || r.Header.Get("Content-Type") != "application/json" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = io.WriteString(w, `{"id":"gen-1","model":"openai/gpt-5.6-luna","provider":"Amazon Bedrock","choices":[{"finish_reason":"stop","message":{"tool_calls":[{"function":{"name":"memoryz_ocr","arguments":"{\"text\":\"hi\"}"}}]}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}`)
	})
	if _, err := p.JSON(context.Background(), "the prompt", object(map[string]any{"text": str(0, 10)}, "text"), "memoryz_ocr", nil); err != nil {
		t.Fatal(err)
	}
	keys := []string{}
	for k := range body {
		keys = append(keys, k)
	}
	sortStrings(keys)
	if strings.Join(keys, ",") != "max_tokens,messages,model,provider,reasoning,tool_choice,tools" {
		t.Fatalf("request keys: %v", keys)
	}
	if body["model"] != "openai/gpt-5.6-luna" || body["max_tokens"] != float64(16384) {
		t.Fatalf("model/max_tokens: %v %v", body["model"], body["max_tokens"])
	}
	reasoning := body["reasoning"].(map[string]any)
	if reasoning["effort"] != "high" || reasoning["exclude"] != true {
		t.Fatalf("reasoning: %v", reasoning)
	}
	messages := body["messages"].([]any)
	system := messages[0].(map[string]any)
	if len(messages) != 2 || system["role"] != "system" || !strings.HasPrefix(system["content"].(string), "You are a source-grounded educational assistant.") || messages[1].(map[string]any)["content"] != "the prompt" {
		t.Fatalf("messages: %v", messages)
	}
	tool := body["tools"].([]any)[0].(map[string]any)
	fn := tool["function"].(map[string]any)
	if tool["type"] != "function" || fn["name"] != "memoryz_ocr" || fn["strict"] != true || fn["description"] != "Return the requested JSON object." || fn["parameters"].(map[string]any)["additionalProperties"] != false {
		t.Fatalf("tool: %v", tool)
	}
	if body["tool_choice"].(map[string]any)["function"].(map[string]any)["name"] != "memoryz_ocr" {
		t.Fatalf("tool_choice: %v", body["tool_choice"])
	}
	provider := body["provider"].(map[string]any)
	order := provider["order"].([]any)
	if len(order) != 2 || order[0] != "openai/fast" || order[1] != "amazon-bedrock/us-east-1" || provider["allow_fallbacks"] != false || provider["require_parameters"] != true {
		t.Fatalf("provider routing: %v", provider)
	}
}

func TestUsageCapture(t *testing.T) {
	model := &fakeModel{answers: []any{map[string]any{"text": "hi"}}}
	p := model.provider(t)
	ctx, usage := CaptureUsage(context.Background())
	if _, err := p.JSON(ctx, "p", object(map[string]any{"text": str(0, 10)}, "text"), "memoryz_cards", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := p.JSON(ctx, "p", object(map[string]any{"text": str(0, 10)}, "text"), "memoryz_cards", nil); err != nil {
		t.Fatal(err)
	}
	requests := usage.Requests()
	if len(requests) != 2 {
		t.Fatalf("two calls recorded: %d", len(requests))
	}
	u := requests[0]
	if u.Model != "openai/gpt-5.6-luna" || u.Provider != "OpenAI" || u.RequestID != "gen-a" || u.PromptTokens != 10 || u.CompletionTokens != 5 || u.ReasoningTokens != 2 || u.Cost == nil || *u.Cost != 0.001 || u.DurationMs < 0 {
		t.Fatalf("usage: %+v", u)
	}
	// A context without a collector records nothing and still works.
	if _, err := p.JSON(context.Background(), "p", object(map[string]any{"text": str(0, 10)}, "text"), "memoryz_cards", nil); err != nil {
		t.Fatal(err)
	}
	if len(usage.Requests()) != 2 {
		t.Fatal("the collector only sees calls made with its context")
	}
	img, err := renderOCRImage("MEMORYZ TEST 42")
	if err != nil || len(img) < 100 || string(img[1:4]) != "PNG" {
		t.Fatalf("ocr image: %d bytes %v", len(img), err)
	}
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// TestDuplicateKeyKeepsMeaning: only spacing and trailing punctuation fold; case and inner
// punctuation carry meaning in high-school content (genotypes, element symbols, decimals).
func TestDuplicateKeyKeepsMeaning(t *testing.T) {
	source, _, _ := loadLeaked(t)
	pair := func(a, b string) error {
		raw := map[string]any{"items": []any{
			map[string]any{"front": a, "back": "첫째 카드의 답이다.", "type": "CONCEPT", "citation": "칼륨 이온이 세포 밖으로 이동하여 재분극이 일어난다."},
			map[string]any{"front": b, "back": "둘째 카드의 답이다.", "type": "RELATION", "citation": "칼륨 이온이 세포 밖으로 이동하여 재분극이 일어난다."},
		}}
		_, err := parseItems(raw, KindCards, 2, source)
		return err
	}
	for _, distinct := range [][2]string{
		{"유전자형이 AA인 개체의 형질은?", "유전자형이 aa인 개체의 형질은?"},
		{"CO", "Co"},
		{"pH가 1.0인 용액의 성질은?", "pH가 10인 용액의 성질은?"},
		{"1.5배", "15배"},
	} {
		if err := pair(distinct[0], distinct[1]); err != nil {
			t.Fatalf("%q and %q are different items: %v", distinct[0], distinct[1], err)
		}
	}
	for _, same := range [][2]string{
		{"재분극이란?", "재분극이란 ?"},
		{"재분극이란?", "재분극이란"},
		{"재분극이란？", "재분극이란."},
	} {
		if err := pair(same[0], same[1]); !errors.Is(err, errDuplicateItems) {
			t.Fatalf("%q and %q ask the same thing: %v", same[0], same[1], err)
		}
	}
}

// TestRetryNeedsBudget: the one self-correction call starts only with retryBudget left before the
// handler's deadline; the control with time left still corrects.
func TestRetryNeedsBudget(t *testing.T) {
	source, leaked, clean := loadLeaked(t)
	short, cancel := context.WithTimeout(context.Background(), retryBudget/2)
	defer cancel()
	model := &fakeModel{answers: []any{leaked, clean}}
	if _, err := GenerateItems(short, model.provider(t), source, KindCards, 3); !errors.Is(err, errFormatLeak) || model.calls.Load() != 1 {
		t.Fatalf("no budget: want the first refusal after one call, got %v after %d calls", err, model.calls.Load())
	}
	long, cancelLong := context.WithTimeout(context.Background(), retryBudget*2)
	defer cancelLong()
	model = &fakeModel{answers: []any{leaked, clean}}
	if _, err := GenerateItems(long, model.provider(t), source, KindCards, 3); err != nil || model.calls.Load() != 2 {
		t.Fatalf("with budget: want a corrected answer after two calls, got %v after %d calls", err, model.calls.Load())
	}
}
