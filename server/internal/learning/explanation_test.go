package learning

import (
	"encoding/json"
	"testing"
)

const historySource = "고려 광종은 노비안검법을 실시하여 불법으로 노비가 된 사람들을 양인으로 해방하였다. 광종은 과거제를 실시하여 유교적 소양을 갖춘 인재를 관리로 선발하였다. 성종은 최승로의 시무 28조를 수용하여 유교 정치 이념을 통치에 반영하였다. 성종은 전국에 12목을 설치하고 지방관을 파견하였다."

var historyOptions = []string{"전국에 12목 설치", "노비안검법과 과거제 실시", "시무 28조 수용", "훈민정음 창제", "대동법 전국 확대"}

func TestLegacyComparisonAndHonestFallback(t *testing.T) {
	e := Resolve("q", "고려 광종은 노비안검법을 실시하여 불법으로 노비가 된 사람들을 양인으로 해방하였다.", historySource, historyOptions, 1, nil)
	if e.Status != "READY" || e.Source != "rule" || len(e.Diagram.Nodes) != 8 || len(e.MicroChecks) != 1 || !Validate(e, historySource, 5) {
		t.Fatalf("grounded legacy comparison: %+v", e)
	}
	for _, n := range e.Diagram.Nodes {
		txt, ok := spanText(e.Citation, n.Span)
		if !ok || !exact(txt, n.Label) {
			t.Fatal("not source grounded", n)
		}
	}
	raw, _ := json.Marshal(e)
	if got := Resolve("q", e.Citation, historySource, historyOptions, 1, raw); got.Diagram.ID != e.Diagram.ID {
		t.Fatal("cached metadata changed")
	}
	for _, source := range []string{"물은 액체다.", "자료를 새 내용으로 수정했습니다."} {
		got := Resolve("q", "물은 액체다.", source, historyOptions, 1, nil)
		if got.Status != "TEXT" || got.Diagram != nil || len(got.MicroChecks) != 0 {
			t.Fatal("unsupported diagram invented")
		}
	}
}
func TestUTF16GroundingAndInvalidMetadata(t *testing.T) {
	s := "😀 광종 성종"
	e := Explanation{Version: 1, Status: "READY", QuestionID: "q", Citation: s, Source: "generated", OptionReasons: []string{"", ""}, MicroChecks: []Check{}, Diagram: &Diagram{ID: "d", Type: "TREE", Title: "대상", Nodes: []Node{{ID: "a", Label: "광종", Span: Span{3, 5}}, {ID: "b", Label: "성종", Span: Span{6, 8}, ParentID: "a"}}}}
	if !Validate(e, s, 2) {
		t.Fatal("UTF16 valid control rejected")
	}
	raw, _ := json.Marshal(e)
	mutations := []func(*Explanation){
		func(x *Explanation) { x.Diagram.Nodes[0].Span = Span{1, 5} },
		func(x *Explanation) { x.Diagram.Nodes[0].Label = "세종" },
		func(x *Explanation) { x.Diagram.Nodes[1].ID = "a" },
		func(x *Explanation) { x.Diagram.Nodes[0].ParentID = "b" },
		func(x *Explanation) { x.Diagram.AnswerNodeID = "missing" },
		func(x *Explanation) { x.Diagram.OptionNodeMap = map[string]string{"9": "a"} },
		func(x *Explanation) { x.Diagram.Edges = []Edge{{From: "a", To: "missing"}} },
		func(x *Explanation) { x.Diagnosis = "찍어서 틀렸어요" },
		func(x *Explanation) { x.Citation = "세종이 훈민정음을 창제" },
		func(x *Explanation) {
			x.MicroChecks = []Check{{ID: "c", NodeID: "a", Span: Span{3, 5}, Prompt: "왕은?", Options: [2]string{"세종", "성종"}, Answer: 0, Explanation: "광종"}}
		},
	}
	for i, mutate := range mutations {
		var x Explanation
		_ = json.Unmarshal(raw, &x)
		mutate(&x)
		if Validate(x, s, 2) {
			t.Errorf("mutation %d incorrectly accepted", i)
		}
	}
}
func TestSixTypesAndGraphNumbers(t *testing.T) {
	for _, kind := range []string{"FLOW", "COMPARE", "CAUSE", "TIMELINE", "GRAPH", "TREE"} {
		t.Run(kind, func(t *testing.T) {
			citation := "y=x^2 접선"
			e := Explanation{Version: 1, Status: "READY", QuestionID: "q", Citation: citation, Source: "generated", OptionReasons: []string{"", ""}, MicroChecks: []Check{}, Diagram: &Diagram{ID: "d", Type: kind, Title: "원문", Nodes: []Node{{ID: "a", Label: "y=x^2", Span: Span{0, 5}}, {ID: "b", Label: "접선", Span: Span{6, 8}}}, Edges: []Edge{{From: "a", To: "b"}}}}
			switch kind {
			case "COMPARE":
				e.Diagram.Columns = []string{"개념", "설명"}
				e.Diagram.Rows = []Row{{ID: "r", Label: "개념", Cells: []Cell{{Text: "y=x^2", NodeID: "a"}, {Text: "접선", NodeID: "b"}}}}
			case "GRAPH":
				slope := 2.0
				e.Diagram.Graph = &Graph{Expression: "y=x^2", Samples: [][2]float64{{-1, 1}, {0, 0}, {1, 1}}, Marks: []Mark{{Kind: "tangent", X: 1, Y: 1, Slope: &slope, Label: "접선", NodeID: "b"}}}
			case "TREE":
				e.Diagram.Nodes[1].ParentID = "a"
			}
			if !Validate(e, citation, 2) {
				t.Fatal("valid type rejected")
			}
			if kind == "GRAPH" {
				e.Diagram.Graph.Samples[0][1] = 99
				if Validate(e, citation, 2) {
					t.Fatal("invented graph value accepted")
				}
			}
		})
	}
}

func TestLegacyRuleRejectsUnrelatedConceptsAndMixedOptions(t *testing.T) {
	homeostasis := "항상성은 외부 환경이 변해도 체내 환경을 일정하게 유지하는 성질이다. 혈당량이 증가하면 이자에서 인슐린이 분비된다. 혈당량이 감소하면 글루카곤이 분비된다. 인슐린과 글루카곤은 길항작용을 한다."
	options := []string{"체내 환경을 일정하게 유지한다", "체온을 일정하게 높인다", "혈당량을 항상 증가시킨다"}
	got := Resolve("homeostasis", "항상성은 외부 환경이 변해도 체내 환경을 일정하게 유지하는 성질이다.", homeostasis, options, 0, nil)
	if got.Status != "TEXT" || got.Diagram != nil {
		t.Fatal("unrelated concepts compared", got)
	}
	conjunctive := "광종과 성종은 과거제를 실시하였다. 성종은 12목을 설치하였다."
	if got := Resolve("conjunction", conjunctive, conjunctive, []string{"과거제", "12목"}, 0, nil); got.Status != "TEXT" {
		t.Fatal("conjunctive subject truncated")
	}
	options = []string{"노비안검법과 과거제 실시", "노비안검법과 12목 설치", "유교적 소양을 갖춘 인재", "전국에 12목 설치"}
	e := Resolve("q", historySource, historySource, options, 0, nil)
	if e.Status != "READY" {
		t.Fatal("valid paired control refused")
	}
	if _, ok := e.Diagram.OptionNodeMap["1"]; ok {
		t.Fatal("mixed policy option assigned to first hit")
	}
	if _, ok := e.Diagram.OptionNodeMap["2"]; ok {
		t.Fatal("generic shared prose mapped")
	}
	if e.Diagram.OptionNodeMap["3"] != "fact-3" {
		t.Fatal("discriminating policy did not map")
	}
	// Old cached rule data is no longer authoritative, even when its spans are literal.
	e.QuestionID = "homeostasis"
	e.Citation = homeostasis
	e.Diagram.Nodes = []Node{{ID: "a", Label: "항상성", Span: span(homeostasis, "항상성")}, {ID: "b", Label: "글루카곤", Span: span(homeostasis, "글루카곤")}}
	e.Diagram.Type = "FLOW"
	e.Diagram.Rows = nil
	e.Diagram.Columns = nil
	e.Diagram.OptionNodeMap = nil
	e.Diagram.AnswerNodeID = "a"
	e.Diagram.FocusNodeIDs = nil
	e.MicroChecks = []Check{}
	e.OptionReasons = make([]string, 3)
	raw, _ := json.Marshal(e)
	if got := Resolve("homeostasis", homeostasis, homeostasis, []string{"일정하게", "인슐린", "글루카곤"}, 0, raw); got.Status != "TEXT" {
		t.Fatal("old rule metadata survived stricter admission")
	}
}
