package api

import (
	"context"
	"net/http/httptest"
	"testing"
)

func TestCommunitySchoolAndActivityIsolation(t *testing.T) {
	h := newAIHarness(t, nil)
	ctx := context.Background()
	if _, err := h.pool.Exec(ctx, `UPDATE "User" SET "school"='가람고' WHERE "id"=$1`, h.student); err != nil {
		t.Fatal(err)
	}
	create := func(scope string) string {
		t.Helper()
		rec := h.do("POST", "/api/posts", map[string]any{"title": "범위 점검", "body": "검증 전용 글", "category": "자유", "anonymous": true, "scope": scope})
		if rec.Code != 201 {
			t.Fatal(rec.Code, rec.Body.String())
		}
		return bodyOf(rec)["data"].(map[string]any)["id"].(string)
	}
	public := create("all")
	school := create("school")
	if _, err := h.pool.Exec(ctx, `INSERT INTO "User" ("id","name","nickname","role","school") VALUES ('other-school','다른 학교','친구','STUDENT','나래고'); INSERT INTO "Post" ("id","userId","role","category","title","body","school") VALUES ('foreign-post','other-school','STUDENT','자유','다른 학교 글','내용','나래고')`); err != nil {
		t.Fatal(err)
	}
	list := func(path string) []any {
		t.Helper()
		rec := h.do("GET", path, nil)
		if rec.Code != 200 {
			t.Fatal(rec.Code, rec.Body.String())
		}
		return bodyOf(rec)["data"].([]any)
	}
	for _, tc := range []struct{ path, id string }{{"/api/posts", public}, {"/api/posts?scope=school", school}} {
		rows := list(tc.path)
		if len(rows) != 1 || rows[0].(map[string]any)["id"] != tc.id {
			t.Fatalf("%s: %#v", tc.path, rows)
		}
	}
	mine := list("/api/posts?mine=1")
	if len(mine) != 2 {
		t.Fatalf("anonymous own activity: %#v", mine)
	}
	for _, row := range mine {
		if row.(map[string]any)["authorId"] != "" {
			t.Fatal("anonymous author exposed")
		}
	}
	for _, path := range []string{"/api/posts/foreign-post/comments", "/api/posts/foreign-post/like", "/api/posts/foreign-post/save"} {
		method := "POST"
		if path == "/api/posts/foreign-post/comments" {
			method = "GET"
		}
		if rec := h.do(method, path, nil); rec.Code != 404 {
			t.Fatal(path, rec.Code, rec.Body.String())
		}
	}
	if rec := h.do("POST", "/api/posts/"+school+"/save", nil); rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	if rows := list("/api/posts?saved=1"); len(rows) != 1 || rows[0].(map[string]any)["id"] != school {
		t.Fatal(rows)
	}
	if rec := h.do("PATCH", "/api/profile", map[string]any{"school": ""}); rec.Code != 200 {
		t.Fatal("clear registered school", rec.Code, rec.Body.String())
	}
	if rows := list("/api/posts?mine=1"); len(rows) != 1 || rows[0].(map[string]any)["id"] != public {
		t.Fatal("old school remains visible", rows)
	}
	if rec := h.do("GET", "/api/posts/"+school+"/comments", nil); rec.Code != 404 {
		t.Fatal("old school detail remains accessible", rec.Code)
	}
	if rec := h.do("GET", "/api/posts?scope=school", nil); rec.Code != 400 {
		t.Fatal("missing school", rec.Code)
	}
	if rec := h.do("POST", "/api/posts", map[string]any{"title": "학교 없음", "body": "작성 불가", "category": "자유", "anonymous": true, "scope": "school"}); rec.Code != 400 {
		t.Fatal("write without school", rec.Code)
	}
}

func TestCommunityInboxOnlyListsActualAccessibleConversations(t *testing.T) {
	h := newAIHarness(t, nil)
	ctx := context.Background()
	for _, id := range []string{"peer-one", "peer-two", "no-conversation"} {
		if _, err := h.pool.Exec(ctx, `INSERT INTO "User" ("id","name","nickname","role") VALUES ($1,$1,$1,'STUDENT')`, id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.pool.Exec(ctx, `INSERT INTO "Message" ("id","senderId","recipientId","body","createdAt") VALUES ('old',$1,'peer-one','이전',now()-interval '2 hours'),('new','peer-one',$1,'최신',now()),('second',$1,'peer-two','다른 대화',now()-interval '1 hour')`, h.student); err != nil {
		t.Fatal(err)
	}
	rows := func(rec *httptest.ResponseRecorder) []any {
		t.Helper()
		if rec.Code != 200 {
			t.Fatal(rec.Code, rec.Body.String())
		}
		return bodyOf(rec)["data"].([]any)
	}
	inbox := rows(h.do("GET", "/api/messages?inbox=1", nil))
	if len(inbox) != 2 || inbox[0].(map[string]any)["body"] != "최신" {
		t.Fatal(inbox)
	}
	if _, err := h.pool.Exec(ctx, `INSERT INTO "Block" ("userId","blockedId") VALUES ($1,'peer-one')`, h.student); err != nil {
		t.Fatal(err)
	}
	inbox = rows(h.do("GET", "/api/messages?inbox=1", nil))
	if len(inbox) != 1 || inbox[0].(map[string]any)["id"] != "peer-two" {
		t.Fatal(inbox)
	}
	if rec := h.do("GET", "/api/messages?peer=1&userId=peer-one", nil); rec.Code != 403 {
		t.Fatal(rec.Code)
	}
	if rec := h.do("GET", "/api/messages?peer=1&userId=no-conversation", nil); rec.Code != 200 {
		t.Fatal(rec.Code)
	}
}
