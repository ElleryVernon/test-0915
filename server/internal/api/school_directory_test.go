package api

import (
	"context"
	"strings"
	"testing"
)

func TestSchoolDirectorySelection(t *testing.T) {
	h := newAIHarness(t, nil)
	res := h.do("GET", "/api/schools?q=가락", nil)
	if res.Code != 200 || !strings.Contains(res.Body.String(), "송파구") {
		t.Fatal(res.Body.String())
	}
	if r := h.do("POST", "/api/schools/select", map[string]string{"id": "fake"}); r.Code != 400 {
		t.Fatal("accepted fake school")
	}
	if r := h.do("POST", "/api/schools/select", map[string]string{"id": "7010057"}); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	u, err := h.s.q.GetUser(context.Background(), h.student)
	if err != nil || !strings.Contains(u.School, "가락고등학교 · 서울특별시 송파구") {
		t.Fatal("school identity not persisted", err)
	}
}
