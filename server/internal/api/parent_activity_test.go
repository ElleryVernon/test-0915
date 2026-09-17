package api

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestParentActivityDedupePrivacyAndLink(t *testing.T) {
	h := newAIHarness(t, nil)
	ctx := context.Background()
	now := time.Date(2026, 9, 18, 0, 30, 0, 0, seoul).UTC()
	h.s.now = func() time.Time { return now }
	if _, err := h.pool.Exec(ctx, `INSERT INTO "User"("id","name","nickname","role") VALUES('activity-parent','보호자','보호자','PARENT'); UPDATE "User" SET "privacy"='{"time":true}' WHERE "id"=$1; INSERT INTO "ParentLink"("parentId","studentId","createdAt") VALUES('activity-parent',$1,$2)`, pgx.QueryExecModeSimpleProtocol, h.student, now.Add(-2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	p, err := h.s.q.GetUser(ctx, "activity-parent")
	if err != nil {
		t.Fatal(err)
	}
	count := func(want int) {
		t.Helper()
		if err := h.s.parentActivity(ctx, p); err != nil {
			t.Fatal(err)
		}
		var n int
		if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM "Notification" WHERE "userId"=$1 AND "kind"=$2`, p.ID, notifyChildLearning).Scan(&n); err != nil || n != want {
			t.Fatalf("notices=%d want=%d: %v", n, want, err)
		}
	}
	count(0) // Merely reading a parent page or linking a child is not learning.
	var subject string
	if err := h.pool.QueryRow(ctx, `SELECT "subjectId" FROM "Material" WHERE "id"=$1`, h.material).Scan(&subject); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(ctx, `INSERT INTO "Question"("id","userId","subjectId","materialId","prompt","options","answer","explanation","citation","past","future") VALUES('activity-q',$1,$2,$3,'문제',ARRAY['가','나'],1,'근거','원문','',''); INSERT INTO "Attempt"("id","userId","questionId","answer","correct","score","createdAt") VALUES('activity-a',$1,'activity-q','0',false,0,$4)`, pgx.QueryExecModeSimpleProtocol, h.student, subject, h.material, now.Add(-10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	before := h.s.version(ctx, p.ID)
	results := make(chan error, 5)
	for i := 0; i < 5; i++ {
		go func() { results <- h.s.parentActivity(ctx, p) }()
	}
	for i := 0; i < 5; i++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	count(1)
	if h.s.version(ctx, p.ID) == before {
		t.Fatal("new notice did not invalidate parent bootstrap")
	}
	count(1)
	h.s.now = func() time.Time { return now.Add(24 * time.Hour) }
	count(1) // No repeated daily message without that day's activity.
	if _, err := h.pool.Exec(ctx, `DELETE FROM "Notification" WHERE "userId"=$1 AND "kind"=$2`, p.ID, notifyChildLearning); err != nil {
		t.Fatal(err)
	}
	count(1) // Returning the next day still recovers yesterday's completed work.
	if _, err := h.pool.Exec(ctx, `UPDATE "Attempt" SET "createdAt"=$1 WHERE "id"='activity-a'`, now.Add(24*time.Hour-time.Minute)); err != nil {
		t.Fatal(err)
	}
	count(2)
	if _, err := h.pool.Exec(ctx, `UPDATE "User" SET "privacy"='{"time":false}' WHERE "id"=$1`, h.student); err != nil {
		t.Fatal(err)
	}
	count(0) // Revocation removes even old completion disclosures.
	if _, err := h.pool.Exec(ctx, `UPDATE "User" SET "privacy"='{"time":true}' WHERE "id"=$1; UPDATE "ParentLink" SET "createdAt"=$2 WHERE "studentId"=$1`, pgx.QueryExecModeSimpleProtocol, h.student, now.Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	count(0) // Today's work before a new link does not leak.
	if _, err := h.pool.Exec(ctx, `UPDATE "ParentLink" SET "createdAt"=$2 WHERE "studentId"=$1`, h.student, now.Add(23*time.Hour)); err != nil {
		t.Fatal(err)
	}
	count(1)
	if _, err := h.pool.Exec(ctx, `DELETE FROM "ParentLink" WHERE "studentId"=$1`, h.student); err != nil {
		t.Fatal(err)
	}
	count(0)
	session, _, err := h.s.auth.Create(ctx, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	h.cookie = strings.Split(session, ";")[0]
	if res := h.do("POST", "/api/children/select", map[string]any{"childId": h.student}); res.Code != 404 {
		t.Fatalf("stale notice selected unlinked child %d", res.Code)
	}
	if _, err := h.pool.Exec(ctx, `DELETE FROM "Attempt" WHERE "userId"=$1; INSERT INTO "ParentLink"("parentId","studentId","createdAt") VALUES('activity-parent',$1,$4); INSERT INTO "Card"("id","userId","subjectId","front","back") VALUES('activity-card',$1,$2,'앞면','뒷면'); INSERT INTO "CardReview"("id","userId","cardId","rating","result","createdAt") VALUES('activity-review',$1,'activity-card','GOOD','{}',$3)`, pgx.QueryExecModeSimpleProtocol, h.student, subject, now.Add(24*time.Hour-time.Minute), now.Add(23*time.Hour)); err != nil {
		t.Fatal(err)
	}
	count(1) // A completed card review alone also qualifies.
	boot := communityData(t, h.do("GET", "/api/bootstrap", nil), 200)
	if len(boot["notifications"].([]any)) != 1 {
		t.Fatal("parent feed omitted card completion")
	}
	if _, err := h.pool.Exec(ctx, `UPDATE "User" SET "privacy"='{"time":false}' WHERE "id"=$1`, h.student); err != nil {
		t.Fatal(err)
	}
	boot = communityData(t, h.do("GET", "/api/bootstrap", nil), 200)
	if len(boot["notifications"].([]any)) != 0 {
		t.Fatal("cached feed leaked revoked child activity")
	}
}

func TestParentCommentNoticeAndIndividualRead(t *testing.T) {
	h := newAIHarness(t, nil)
	ctx := context.Background()
	if _, err := h.pool.Exec(ctx, `INSERT INTO "User"("id","name","nickname","role") VALUES('notice-parent','보호자','보호자','PARENT'),('reply-parent','다른 보호자','다른 보호자','PARENT'); INSERT INTO "Post"("id","userId","role","category","title","body") VALUES('parent-post','notice-parent','PARENT','자유','부모 글','부모 본문')`); err != nil {
		t.Fatal(err)
	}
	studentCookie := h.cookie
	peerSession, _, err := h.s.auth.Create(ctx, "reply-parent")
	if err != nil {
		t.Fatal(err)
	}
	h.cookie = strings.Split(peerSession, ";")[0]
	comment := map[string]any{"body": "같이 이야기해요", "requestId": "parent-reply-once"}
	communityData(t, h.do("POST", "/api/posts/parent-post/comments", comment), 201)
	communityData(t, h.do("POST", "/api/posts/parent-post/comments", comment), 201)
	h.cookie = studentCookie
	var title, id string
	if err = h.pool.QueryRow(ctx, `SELECT "id","title" FROM "Notification" WHERE "userId"='notice-parent'`).Scan(&id, &title); err != nil || title != "내 글에 댓글이 달렸어요" {
		t.Fatal(title, err)
	}
	// A different account cannot mark the parent's notice read.
	communityData(t, h.do("PATCH", "/api/notifications", map[string]any{"read": true, "id": id}), 200)
	var read bool
	if err = h.pool.QueryRow(ctx, `SELECT "read" FROM "Notification" WHERE "id"=$1`, id).Scan(&read); err != nil || read {
		t.Fatal("foreign notification changed", err)
	}
	session, _, err := h.s.auth.Create(ctx, "notice-parent")
	if err != nil {
		t.Fatal(err)
	}
	h.cookie = strings.Split(session, ";")[0]
	communityData(t, h.do("PATCH", "/api/notifications", map[string]any{"read": true, "id": id}), 200)
	if err = h.pool.QueryRow(ctx, `SELECT "read" FROM "Notification" WHERE "id"=$1`, id).Scan(&read); err != nil || !read {
		t.Fatal("own notice not read", err)
	}
}
