package api

import (
	"context"
	"memoryz/server/internal/config"
	"net/http"
	"testing"
)

func TestAccountOnboardingLifecycle(t *testing.T) {
	h := newAIHarness(t, func(c *config.Config) { c.DemoMode = true })
	ctx := context.Background()
	if _, err := h.pool.Exec(ctx, `INSERT INTO "AccountOnboarding" ("userId") VALUES ($1)`, h.student); err != nil {
		t.Fatal(err)
	}
	check := func(method, path string, body any, want int) map[string]any {
		t.Helper()
		r := h.do(method, path, body)
		if r.Code != want {
			t.Fatalf("%s %s got %d want %d: %s", method, path, r.Code, want, r.Body.String())
		}
		return bodyOf(r)
	}
	boot := check("GET", "/api/bootstrap", nil, 200)["data"].(map[string]any)
	if boot["demo"] != false || boot["profile"].(map[string]any)["onboardingRequired"] != true {
		t.Fatalf("incorrect account flags: demo=%v", boot["demo"])
	}
	check("POST", "/api/subjects", map[string]any{"name": "Premature"}, 409)
	check("PATCH", "/api/onboarding", map[string]any{"role": "ADMIN", "step": 1}, 400)
	check("PATCH", "/api/onboarding", map[string]any{"role": "STUDENT", "step": 1}, 200)
	state := check("GET", "/api/onboarding", nil, 200)["data"].(map[string]any)
	if state["draft"].(map[string]any)["step"] != float64(1) {
		t.Fatal("draft step not durable")
	}
	check("PATCH", "/api/onboarding", map[string]any{"role": "STUDENT", "step": 2, "nickname": "A"}, 400)
	// Completion cannot bypass grade or nickname validation.
	check("PATCH", "/api/onboarding", map[string]any{"role": "STUDENT", "step": 2, "nickname": "학습시작", "complete": true}, 400)
	check("PATCH", "/api/onboarding", map[string]any{"role": "STUDENT", "step": 2, "nickname": "학습시작", "grade": "고1", "school": "가짜학교", "schoolId": "fake", "complete": true}, 400)
	check("PATCH", "/api/onboarding", map[string]any{"role": "STUDENT", "step": 2, "nickname": "학습시작", "grade": "N수/기타", "school": "", "complete": true}, 200)
	boot = check("GET", "/api/bootstrap", nil, 200)["data"].(map[string]any)
	p := boot["profile"].(map[string]any)
	if p["onboardingRequired"] != false || p["nickname"] != "학습시작" || p["grade"] != "N수/기타" {
		t.Fatalf("completion not reflected: %v", p)
	}
	check("POST", "/api/subjects", map[string]any{"name": "내 첫 과목", "semester": "2026년 2학기", "icon": "book", "color": "orange"}, 201)
	// Retry or another tab cannot mutate the role after completion.
	check("PATCH", "/api/onboarding", map[string]any{"role": "PARENT", "step": 2, "nickname": "다른이름", "complete": true}, 200)
	u, err := h.s.q.GetUser(ctx, h.student)
	if err != nil || string(u.Role) != "STUDENT" || u.Nickname != "학습시작" {
		t.Fatal("completed role/profile changed", err)
	}
}

func TestParentOnboardingWithoutChild(t *testing.T) {
	h := newAIHarness(t, nil)
	ctx := context.Background()
	if _, err := h.pool.Exec(ctx, `INSERT INTO "AccountOnboarding" ("userId") VALUES ($1)`, h.student); err != nil {
		t.Fatal(err)
	}
	// A name collision must not consume setup or change the role.
	if _, err := h.pool.Exec(ctx, `INSERT INTO "User"("id","name","nickname","role") VALUES('onboarding-taken','taken','중복닉네임','STUDENT')`); err != nil {
		t.Fatal(err)
	}
	r := h.do(http.MethodPatch, "/api/onboarding", map[string]any{"role": "PARENT", "step": 2, "nickname": "중복닉네임", "complete": true})
	if r.Code != 409 {
		t.Fatalf("conflict: %d %s", r.Code, r.Body.String())
	}
	r = h.do(http.MethodPatch, "/api/onboarding", map[string]any{"role": "PARENT", "step": 2, "nickname": "응원하는부모", "complete": true})
	if r.Code != 200 {
		t.Fatalf("parent: %d %s", r.Code, r.Body.String())
	}
	u, err := h.s.q.GetUser(ctx, h.student)
	if err != nil || string(u.Role) != "PARENT" {
		t.Fatal("parent role not persisted", err)
	}
	r = h.do(http.MethodGet, "/api/bootstrap", nil)
	if r.Code != 200 {
		t.Fatal("parent bootstrap", r.Code, r.Body.String())
	}
	r = h.do(http.MethodPost, "/api/subjects", map[string]any{"name": "no"})
	if r.Code != 403 {
		t.Fatalf("parent student boundary: %d", r.Code)
	}
}
