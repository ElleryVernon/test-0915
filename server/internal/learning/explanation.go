// Package learning carries source-grounded explanations. It never calls a model on reads.
package learning

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
	"unicode/utf16"
)

type Span [2]int
type Node struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Span     Span   `json:"span"`
	Detail   string `json:"detail,omitempty"`
	Group    string `json:"group,omitempty"`
	Value    string `json:"value,omitempty"`
	ParentID string `json:"parentId,omitempty"`
}
type Edge struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Label string `json:"label,omitempty"`
	Loop  bool   `json:"loop,omitempty"`
}
type Cell struct {
	Text   string `json:"text"`
	NodeID string `json:"nodeId"`
}
type Row struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Cells []Cell `json:"cells"`
}
type Mark struct {
	Kind   string   `json:"kind"`
	X      float64  `json:"x"`
	Y      float64  `json:"y"`
	Label  string   `json:"label"`
	NodeID string   `json:"nodeId,omitempty"`
	Slope  *float64 `json:"slope,omitempty"`
}
type Graph struct {
	Expression string       `json:"expression"`
	Samples    [][2]float64 `json:"samples"`
	Marks      []Mark       `json:"marks"`
}
type Diagram struct {
	ID            string            `json:"id"`
	Type          string            `json:"type"`
	Title         string            `json:"title"`
	Nodes         []Node            `json:"nodes"`
	Edges         []Edge            `json:"edges,omitempty"`
	Columns       []string          `json:"columns,omitempty"`
	Rows          []Row             `json:"rows,omitempty"`
	Graph         *Graph            `json:"graph,omitempty"`
	AnswerNodeID  string            `json:"answerNodeId,omitempty"`
	OptionNodeMap map[string]string `json:"optionNodeMap,omitempty"`
	FocusNodeIDs  []string          `json:"focusNodeIds,omitempty"`
}
type Check struct {
	ID          string    `json:"id"`
	NodeID      string    `json:"nodeId"`
	Prompt      string    `json:"prompt"`
	Options     [2]string `json:"options"`
	Answer      int       `json:"answer"`
	Explanation string    `json:"explanation"`
	Span        Span      `json:"span"`
}
type Explanation struct {
	Version       int      `json:"version"`
	Status        string   `json:"status"`
	QuestionID    string   `json:"questionId"`
	Citation      string   `json:"citation"`
	Diagnosis     string   `json:"diagnosis,omitempty"`
	OptionReasons []string `json:"optionReasons"`
	Diagram       *Diagram `json:"diagram,omitempty"`
	MicroChecks   []Check  `json:"microChecks"`
	Source        string   `json:"source"`
	Message       string   `json:"message,omitempty"`
}

func spanText(s string, p Span) (string, bool) {
	u := utf16.Encode([]rune(s))
	if p[0] < 0 || p[1] <= p[0] || p[1] > len(u) {
		return "", false
	}
	if p[0] > 0 && u[p[0]] >= 0xdc00 && u[p[0]] <= 0xdfff {
		return "", false
	}
	if p[1] < len(u) && u[p[1]] >= 0xdc00 && u[p[1]] <= 0xdfff {
		return "", false
	}
	return string(utf16.Decode(u[p[0]:p[1]])), true
}
func span(s, sub string) Span {
	i := strings.Index(s, sub)
	if i < 0 {
		return Span{-1, -1}
	}
	start := len(utf16.Encode([]rune(s[:i])))
	return Span{start, start + len(utf16.Encode([]rune(sub)))}
}
func exact(s, sub string) bool { return strings.TrimSpace(sub) != "" && strings.Contains(s, sub) }
func finite(n float64) bool    { return !math.IsNaN(n) && !math.IsInf(n, 0) }

// Validate is deliberately conservative: extractive labels/details and intact citation text are
// required. Structural validity is not a claim that arbitrary generated reasoning is true.
func Validate(e Explanation, material string, optionCount int) bool {
	if e.Version != 1 || e.Status != "READY" || e.QuestionID == "" || !exact(material, e.Citation) || len(e.Citation) > 48000 || e.Diagram == nil {
		return false
	}
	if len(e.OptionReasons) != optionCount || e.Diagnosis != "" {
		return false
	}
	for _, reason := range e.OptionReasons {
		if reason != "" && !exact(e.Citation, reason) {
			return false
		}
	}
	d := e.Diagram
	if d.ID == "" || len(d.ID) > 120 || d.Title == "" || len([]rune(d.Title)) > 1200 || len(d.Nodes) < 2 || len(d.Nodes) > 12 || len(d.Edges) > 24 {
		return false
	}
	switch d.Type {
	case "FLOW", "COMPARE", "CAUSE", "TIMELINE", "GRAPH", "TREE":
	default:
		return false
	}
	nodes := map[string]Node{}
	for _, n := range d.Nodes {
		text, ok := spanText(e.Citation, n.Span)
		if !ok || n.ID == "" || len(n.ID) > 120 || len([]rune(n.Label)) > 1200 || nodes[n.ID].ID != "" || !exact(text, n.Label) || (n.Detail != "" && !exact(text, n.Detail)) || (n.Value != "" && !exact(text, n.Value)) {
			return false
		}
		nodes[n.ID] = n
	}
	has := func(id string) bool { return nodes[id].ID != "" }
	if d.AnswerNodeID != "" && !has(d.AnswerNodeID) {
		return false
	}
	for _, id := range d.FocusNodeIDs {
		if !has(id) {
			return false
		}
	}
	for k, id := range d.OptionNodeMap {
		var index int
		if _, err := fmt.Sscanf(k, "%d", &index); err != nil || fmt.Sprint(index) != k || index < 0 || index >= optionCount || !has(id) {
			return false
		}
	}
	for _, edge := range d.Edges {
		if !has(edge.From) || !has(edge.To) || edge.From == edge.To || (edge.Loop && d.Type != "CAUSE") || (edge.Label != "" && !exact(e.Citation, edge.Label)) {
			return false
		}
	}
	for _, n := range d.Nodes {
		if n.ParentID != "" && !has(n.ParentID) {
			return false
		}
	}
	if d.Type == "FLOW" || d.Type == "CAUSE" {
		indices := map[string]int{}
		for i, n := range d.Nodes {
			indices[n.ID] = i
		}
		for _, edge := range d.Edges {
			if !edge.Loop && indices[edge.From] >= indices[edge.To] {
				return false
			}
		}
	}
	if d.Type == "TREE" {
		for _, edge := range d.Edges {
			n := nodes[edge.To]
			if n.ParentID != "" && n.ParentID != edge.From {
				return false
			}
			n.ParentID = edge.From
			nodes[n.ID] = n
		}
		for _, n := range d.Nodes {
			seen := map[string]bool{}
			id := n.ID
			depth := 0
			for id != "" {
				if seen[id] || !has(id) {
					return false
				}
				seen[id] = true
				depth++
				if depth > 3 {
					return false
				}
				id = nodes[id].ParentID
			}
		}
	}
	if d.Type == "COMPARE" {
		if len(d.Columns) < 2 || len(d.Columns) > 3 || len(d.Rows) < 1 || len(d.Rows) > 6 {
			return false
		}
		seen := map[string]bool{}
		for _, row := range d.Rows {
			if row.ID == "" || seen[row.ID] || len(row.Cells) != len(d.Columns) {
				return false
			}
			seen[row.ID] = true
			for _, c := range row.Cells {
				n := nodes[c.NodeID]
				text, _ := spanText(e.Citation, n.Span)
				if !has(c.NodeID) || !exact(text, c.Text) {
					return false
				}
			}
		}
	}
	if d.Type == "GRAPH" {
		g := d.Graph
		if g == nil || !exact(e.Citation, g.Expression) || len(g.Samples) < 2 || len(g.Samples) > 200 || len(g.Marks) > 8 {
			return false
		}
		for i, p := range g.Samples {
			if i > 0 && p[0] <= g.Samples[i-1][0] {
				return false
			}
			if !finite(p[0]) || !finite(p[1]) || math.Abs(p[0]) > 1e9 || math.Abs(p[1]) > 1e9 || !graphPoint(g.Expression, p[0], p[1]) {
				return false
			}
		}
		for _, m := range g.Marks {
			if !graphPoint(g.Expression, m.X, m.Y) || (m.Kind == "tangent" && (m.Slope == nil || !graphSlope(g.Expression, m.X, *m.Slope))) || (m.Kind != "point" && m.Kind != "tangent") || !finite(m.X) || !finite(m.Y) || (m.NodeID != "" && !has(m.NodeID)) || (m.Slope != nil && !finite(*m.Slope)) {
				return false
			}
		}
	}
	if len(e.MicroChecks) > 3 {
		return false
	}
	seen := map[string]bool{}
	for _, c := range e.MicroChecks {
		text, ok := spanText(e.Citation, c.Span)
		if !ok || c.ID == "" || seen[c.ID] || !has(c.NodeID) || c.Answer < 0 || c.Answer > 1 || c.Prompt == "" || c.Options[0] == c.Options[1] || !exact(text, c.Options[c.Answer]) || !exact(text, c.Explanation) {
			return false
		}
		seen[c.ID] = true
	}
	return true
}

func Text(id, citation string, options []string) Explanation {
	return Explanation{Version: 1, Status: "TEXT", QuestionID: id, Citation: citation, OptionReasons: make([]string, len(options)), MicroChecks: []Check{}, Source: "text", Message: "이 문제는 원문과 글 해설로 확인해 주세요."}
}

// Resolve uses validated generated metadata. Rule metadata is always re-derived so an old
// cached heuristic cannot outlive a stricter rule. Legacy grouping is limited to an audited pair.
// It does not infer a learner's misconception from speed or a selected option.
func Resolve(id, citation, material string, options []string, answer int, raw []byte) Explanation {
	fallback := Text(id, citation, options)
	if len(raw) > 0 {
		var e Explanation
		if json.Unmarshal(raw, &e) == nil && e.QuestionID == id && e.Source == "generated" && Validate(e, material, len(options)) {
			return e
		}
	}
	if !exact(material, citation) {
		fallback.Message = "자료가 바뀌어 기존 인용을 다시 확인해 주세요."
		return fallback
	}
	if e, ok := comparison(id, material, options, answer); ok {
		return e
	}
	return fallback
}

var sentences = regexp.MustCompile(`[^.!?\n]+[.!?]?`)
var subject = regexp.MustCompile(`^([가-힣A-Za-z0-9· ]{1,24}?)(은|는)\s+`)

func comparison(id, material string, options []string, answer int) (Explanation, bool) {
	// This legacy rule is intentionally restricted to the audited 광종/성종 policy comparison.
	// A grammatical subject match alone does not establish that two things are comparable:
	// concepts, hormones, conjunctive subjects and other entities must use generated metadata
	// or the existing text explanation. Never truncate a subject to its last word.
	if len([]rune(material)) > 3000 {
		return Explanation{}, false
	}
	type fact struct{ who, text string }
	facts := []fact{}
	groups := []string{}
	for _, line := range sentences.FindAllString(material, -1) {
		line = strings.TrimSpace(line)
		m := subject.FindStringSubmatch(line)
		if len(m) == 0 || len([]rune(line)) > 160 {
			continue
		}
		who := ""
		switch strings.TrimSpace(m[1]) {
		case "광종", "고려 광종":
			who = "광종"
		case "성종", "고려 성종":
			who = "성종"
		default:
			return Explanation{}, false
		}
		known := false
		for _, g := range groups {
			if g == who {
				known = true
			}
		}
		if !known {
			groups = append(groups, who)
		}
		facts = append(facts, fact{who, line})
	}
	if len(groups) != 2 || len(facts) < 2 || len(facts) > 6 {
		return Explanation{}, false
	}
	d := &Diagram{ID: id + "-source-compare-v2", Type: "COMPARE", Title: "대상별 원문 비교", Columns: []string{"대상", "원문 근거"}, OptionNodeMap: map[string]string{}}
	e := Explanation{Version: 1, Status: "READY", QuestionID: id, Citation: material, OptionReasons: make([]string, len(options)), Diagram: d, MicroChecks: []Check{}, Source: "rule"}
	for i, f := range facts {
		a, b := fmt.Sprintf("subject-%d", i), fmt.Sprintf("fact-%d", i)
		p := span(material, f.text)
		whoStart := strings.Index(f.text, f.who)
		whoSpan := Span{p[0] + len(utf16.Encode([]rune(f.text[:whoStart]))), p[0] + len(utf16.Encode([]rune(f.text[:whoStart+len(f.who)])))}
		d.Nodes = append(d.Nodes, Node{ID: a, Label: f.who, Span: whoSpan}, Node{ID: b, Label: f.text, Span: p, Group: f.who})
		d.Rows = append(d.Rows, Row{ID: fmt.Sprint(i), Label: f.who, Cells: []Cell{{Text: f.who, NodeID: a}, {Text: f.text, NodeID: b}}})
	}
	// Only policy names discriminate these entities. Common prose (e.g. 실시, 일정하게)
	// and entity-name mentions do not establish an option's relation to a specific fact.
	terms := []string{"노비안검법", "과거제", "시무 28조", "12목"}
	for j, opt := range options {
		matched := map[int]bool{}
		owners := map[string]bool{}
		for _, term := range terms {
			if !strings.Contains(opt, term) {
				continue
			}
			for i, f := range facts {
				if strings.Contains(f.text, term) {
					matched[i] = true
					owners[f.who] = true
				}
			}
		}
		// A compound option combining policies from different kings has no single source node.
		if len(owners) != 1 {
			continue
		}
		candidate := -1
		for i := range facts {
			if matched[i] {
				candidate = i
				break
			}
		}
		if candidate < 0 {
			continue
		}
		f := facts[candidate]
		nodeID := fmt.Sprintf("fact-%d", candidate)
		d.OptionNodeMap[fmt.Sprint(j)] = nodeID
		if j == answer {
			d.AnswerNodeID = nodeID
			d.FocusNodeIDs = []string{nodeID}
			checkAnswer := 0
			if groups[1] == f.who {
				checkAnswer = 1
			}
			e.MicroChecks = append(e.MicroChecks, Check{ID: id + "-subject-check", NodeID: nodeID, Prompt: "다음 원문 내용의 주체는 누구인가요?\n" + strings.TrimSpace(subject.ReplaceAllString(f.text, "")), Options: [2]string{groups[0], groups[1]}, Answer: checkAnswer, Explanation: f.text, Span: span(material, f.text)})
		}
	}
	// A question must have at least one answer option grounded in the grouped facts.
	if d.AnswerNodeID == "" || !Validate(e, material, len(options)) {
		return Explanation{}, false
	}
	return e, true
}

// No general expression evaluation: these polynomial forms are verified numerically. Other
// formulas fall back to text rather than drawing unverified model-generated coordinates.
func polynomial(expression string) (int, bool) {
	e := strings.ReplaceAll(strings.ReplaceAll(expression, " ", ""), "²", "^2")
	e = strings.ReplaceAll(e, "³", "^3")
	switch e {
	case "y=x", "f(x)=x":
		return 1, true
	case "y=x^2", "f(x)=x^2":
		return 2, true
	case "y=x^3", "f(x)=x^3":
		return 3, true
	}
	return 0, false
}
func graphPoint(expression string, x, y float64) bool {
	p, ok := polynomial(expression)
	return ok && finite(x) && finite(y) && math.Abs(x) <= 10000 && math.Abs(math.Pow(x, float64(p))-y) <= 1e-6*math.Max(1, math.Abs(y))
}
func graphSlope(expression string, x, slope float64) bool {
	p, ok := polynomial(expression)
	return ok && finite(slope) && math.Abs(float64(p)*math.Pow(x, float64(p-1))-slope) <= 1e-6*math.Max(1, math.Abs(slope))
}
