package api

import (
	"context"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
)

func commentActor(t *testing.T, h *aiHarness, id, role string) *aiHarness {
	t.Helper()
	if _, err := h.pool.Exec(context.Background(), `INSERT INTO "User"("id","name","nickname","role") VALUES($1,$1,$1,$2)`, id, role); err != nil {
		t.Fatal(err)
	}
	cookie, _, err := h.s.auth.Create(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	actor := *h
	actor.student, actor.cookie = id, strings.Split(cookie, ";")[0]
	return &actor
}

func commentPost(t *testing.T, h *aiHarness) string {
	t.Helper()
	return communityData(t, h.do("POST", "/api/posts", map[string]any{"title": "댓글 점검", "body": "격리된 검증 글", "category": "질문", "anonymous": true}), 201)["id"].(string)
}

func commentRows(t *testing.T, h *aiHarness, postID string) map[string]map[string]any {
	t.Helper()
	rec := h.do("GET", "/api/posts/"+postID+"/comments", nil)
	commentStatus(t, rec, 200)
	rows := map[string]map[string]any{}
	for _, raw := range bodyOf(rec)["data"].([]any) {
		row := raw.(map[string]any)
		rows[row["id"].(string)] = row
	}
	return rows
}

func commentStatus(t *testing.T, rec *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("status %d want %d: %s", rec.Code, want, rec.Body.String())
	}
}

func TestCommunityCommentActionsLifecycle(t *testing.T) {
	h := newAIHarness(t, nil)
	peer := commentActor(t, h, "comment-peer", "STUDENT")
	post := commentPost(t, h)
	base := "/api/posts/" + post + "/comments"
	created := communityData(t, peer.do("POST", base, map[string]any{"body": "원래 답변", "requestId": "comment-key", "block": map[string]any{"id": "comment-math", "type": "MATH", "payload": map[string]any{"text": "x^2+1"}}}), 201)
	id := created["id"].(string)
	path := base + "/" + id
	reply := communityData(t, h.do("POST", base, map[string]any{"body": "기존 답글", "parentId": id}), 201)["id"].(string)
	rows := commentRows(t, h, post)
	if rows[reply]["isPostAuthor"] != true || rows[reply]["authorId"] != nil || rows[reply]["author"] != "익명 · 글쓴이" {
		t.Fatal("anonymous post author", rows[reply])
	}
	if rows[id]["isPostAuthor"] != false || rows[id]["isMine"] != false || rows[id]["deleted"] != false {
		t.Fatal(rows[id])
	}
	commentStatus(t, h.do("PATCH", path, map[string]any{"body": "다른 사람의 수정"}), 403)
	commentStatus(t, h.do("DELETE", path, nil), 403)
	commentStatus(t, peer.do("PATCH", path, map[string]any{}), 400)
	commentStatus(t, peer.do("PATCH", path, map[string]any{"body": strings.Repeat("가", 2001)}), 400)
	edit := communityData(t, peer.do("PATCH", path, map[string]any{"body": "  수정한 답변  "}), 200)
	if edit["body"] != "수정한 답변" || edit["editedAt"] == nil {
		t.Fatal(edit)
	}
	again := communityData(t, peer.do("PATCH", path, map[string]any{"body": "수정한 답변"}), 200)
	if again["editedAt"] != edit["editedAt"] {
		t.Fatal("repeated save changed timestamp", edit, again)
	}
	rows = commentRows(t, peer, post)
	if rows[id]["block"].(map[string]any)["id"] != "comment-math" || rows[id]["body"] != "수정한 답변" || rows[id]["isMine"] != true {
		t.Fatal("edit lost attachment", rows[id])
	}
	// Empty body is allowed only while the existing attachment supplies content.
	communityData(t, peer.do("PATCH", path, map[string]any{"body": " "}), 200)
	if commentRows(t, h, post)[id]["block"] == nil {
		t.Fatal("blank edit removed block")
	}
	communityData(t, h.do("POST", "/api/posts/"+post+"/accept", map[string]any{"commentId": id}), 200)
	communityData(t, h.do("POST", path+"/like", map[string]any{"liked": true}), 200)
	communityData(t, peer.do("DELETE", path, nil), 200)
	communityData(t, peer.do("DELETE", path, nil), 200)
	rows = commentRows(t, h, post)
	deleted := rows[id]
	if deleted["deleted"] != true || deleted["body"] != "" || deleted["author"] != "삭제된 댓글" || deleted["accepted"] != true || deleted["likes"] != float64(0) || deleted["liked"] != false || deleted["isMine"] != false || deleted["isPostAuthor"] != false {
		t.Fatal("redaction", deleted)
	}
	for _, field := range []string{"block", "authorId", "editedAt"} {
		if _, ok := deleted[field]; ok {
			t.Fatal("private deleted field", field, deleted)
		}
	}
	if rows[reply]["body"] != "기존 답글" || rows[reply]["parentId"] != id {
		t.Fatal("reply lost", rows[reply])
	}
	communityData(t, h.do("POST", base, map[string]any{"body": "삭제 뒤 대화 이어가기", "parentId": id}), 201)
	commentStatus(t, peer.do("PATCH", path, map[string]any{"body": "복구 시도"}), 404)
	commentStatus(t, h.do("POST", path+"/like", map[string]any{"liked": true}), 404)
	commentStatus(t, h.do("POST", "/api/posts/"+post+"/accept", map[string]any{"commentId": id}), 404)
	commentStatus(t, h.do("POST", "/api/posts/"+post+"/blocks/comment-math/clone", map[string]any{}), 404)
	// Request replay never recovers the original source text after a deletion.
	replay := communityData(t, peer.do("POST", base, map[string]any{"body": "원래 답변", "requestId": "comment-key"}), 201)
	if replay["body"] != "" || replay["id"] != id {
		t.Fatal("replay exposed deleted text", replay)
	}
	var body string
	var block []byte
	var points, rewards, likes int
	if err := h.pool.QueryRow(context.Background(), `SELECT c."body",cc."block",u."points",(SELECT count(*) FROM "CommunityReward" WHERE "postId"=$1),(SELECT count(*) FROM "CommentLike" WHERE "commentId"=$2) FROM "Comment" c JOIN "CommunityComment" cc ON cc."commentId"=c."id" JOIN "User" u ON u."id"=c."userId" WHERE c."id"=$2`, post, id).Scan(&body, &block, &points, &rewards, &likes); err != nil {
		t.Fatal(err)
	}
	if body != "" || len(block) != 0 || points != 50 || rewards != 1 || likes != 0 {
		t.Fatal("delete persistence/reward", body, len(block), points, rewards, likes)
	}
}

func TestCommunityCommentActionsLikesAndLegacy(t *testing.T) {
	h := newAIHarness(t, nil)
	peer := commentActor(t, h, "comment-peer", "STUDENT")
	post := commentPost(t, h)
	ctx := context.Background()
	// Old comments can have no CommunityComment row, including ones imported before v8.
	if _, err := h.pool.Exec(ctx, `INSERT INTO "Comment"("id","postId","userId","body") VALUES('legacy-comment',$1,$2,'이전 댓글')`, post, peer.student); err != nil {
		t.Fatal(err)
	}
	path := "/api/posts/" + post + "/comments/legacy-comment"
	commentStatus(t, h.do("POST", path+"/like", map[string]any{}), 400)
	commentStatus(t, peer.do("PATCH", path, map[string]any{"body": "  "}), 400)
	communityData(t, peer.do("PATCH", path, map[string]any{"body": strings.Repeat("가", 2000)}), 200)
	// Simultaneous retries must create one row and one stable desired state.
	var wg sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- h.do("POST", path+"/like", map[string]any{"liked": true}) }()
	}
	wg.Wait()
	close(results)
	for rec := range results {
		result := communityData(t, rec, 200)
		if result["likes"] != float64(1) || result["liked"] != true {
			t.Fatal(result)
		}
	}
	result := communityData(t, peer.do("POST", path+"/like", map[string]any{"liked": true}), 200)
	if result["likes"] != float64(2) {
		t.Fatal(result)
	}
	for i := 0; i < 2; i++ {
		result = communityData(t, h.do("POST", path+"/like", map[string]any{"liked": false}), 200)
		if result["likes"] != float64(1) || result["liked"] != false {
			t.Fatal(result)
		}
	}
	if row := commentRows(t, peer, post)["legacy-comment"]; row["likes"] != float64(1) || row["liked"] != true || row["editedAt"] == nil {
		t.Fatal(row)
	}
	communityData(t, peer.do("DELETE", path, nil), 200)
	if row := commentRows(t, h, post)["legacy-comment"]; row["deleted"] != true {
		t.Fatal(row)
	}
}

func TestCommunityCommentActionsAccess(t *testing.T) {
	h := newAIHarness(t, nil)
	peer := commentActor(t, h, "comment-peer", "STUDENT")
	other := commentActor(t, h, "comment-other", "STUDENT")
	parent := commentActor(t, h, "comment-parent", "PARENT")
	post := commentPost(t, h)
	base := "/api/posts/" + post + "/comments"
	id := communityData(t, peer.do("POST", base, map[string]any{"body": "동료 댓글"}), 201)["id"].(string)
	path := base + "/" + id
	anon := *h
	anon.cookie = ""
	for _, tc := range []struct {
		method, path string
		body         any
	}{
		{"PATCH", path, map[string]any{"body": "바꾸기"}}, {"DELETE", path, nil}, {"POST", path + "/like", map[string]any{"liked": true}},
	} {
		commentStatus(t, anon.do(tc.method, tc.path, tc.body), 401)
		commentStatus(t, parent.do(tc.method, tc.path, tc.body), 403)
	}
	commentStatus(t, other.do("PATCH", path, map[string]any{"body": "바꾸기"}), 403)
	commentStatus(t, other.do("DELETE", path, nil), 403)
	foreignPost := commentPost(t, h)
	commentStatus(t, peer.do("PATCH", "/api/posts/"+foreignPost+"/comments/"+id, map[string]any{"body": "바꾸기"}), 404)
	ctx := context.Background()
	for _, reverse := range []bool{false, true} {
		from, to := other.student, peer.student
		if reverse {
			from, to = to, from
		}
		if _, err := h.pool.Exec(ctx, `INSERT INTO "Block"("userId","blockedId") VALUES($1,$2)`, from, to); err != nil {
			t.Fatal(err)
		}
		if _, ok := commentRows(t, other, post)[id]; ok {
			t.Fatal("blocked comment visible")
		}
		commentStatus(t, other.do("POST", path+"/like", map[string]any{"liked": true}), 404)
		commentStatus(t, other.do("PATCH", path, map[string]any{"body": "수정"}), 404)
		commentStatus(t, other.do("DELETE", path, nil), 404)
		commentStatus(t, other.do("POST", base, map[string]any{"body": "차단 대화", "parentId": id}), 404)
		if _, err := h.pool.Exec(ctx, `DELETE FROM "Block" WHERE "userId"=$1 AND "blockedId"=$2`, from, to); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.pool.Exec(ctx, `UPDATE "User" SET "suspended"=true WHERE "id"=$1`, peer.student); err != nil {
		t.Fatal(err)
	}
	h.s.auth.Invalidate(ctx, peer.student)
	if _, ok := commentRows(t, other, post)[id]; ok {
		t.Fatal("suspended comment visible")
	}
	commentStatus(t, other.do("POST", path+"/like", map[string]any{"liked": true}), 404)
	commentStatus(t, other.do("POST", base, map[string]any{"body": "정지 대화", "parentId": id}), 404)
	commentStatus(t, peer.do("DELETE", path, nil), 403)
	commentStatus(t, peer.do("PATCH", path, map[string]any{"body": "정지 수정"}), 403)
	commentStatus(t, peer.do("POST", path+"/like", map[string]any{"liked": true}), 403)
	// A block against the post's author protects all comment routes too.
	if _, err := h.pool.Exec(ctx, `INSERT INTO "Block"("userId","blockedId") VALUES($1,$2)`, other.student, h.student); err != nil {
		t.Fatal(err)
	}
	commentStatus(t, other.do("POST", path+"/like", map[string]any{"liked": true}), 404)
	commentStatus(t, other.do("GET", base, nil), 404)
}

func TestCommunityCommentActionsParentBoardAndReplyDepth(t *testing.T) {
	h := newAIHarness(t, nil)
	parent := commentActor(t, h, "comment-parent", "PARENT")
	peer := commentActor(t, h, "comment-parent-peer", "PARENT")
	post := commentPost(t, parent)
	base := "/api/posts/" + post + "/comments"
	id := communityData(t, peer.do("POST", base, map[string]any{"body": "학부모 댓글"}), 201)["id"].(string)
	path := base + "/" + id
	communityData(t, peer.do("PATCH", path, map[string]any{"body": "학부모 수정"}), 200)
	communityData(t, parent.do("POST", path+"/like", map[string]any{"liked": true}), 200)
	reply := communityData(t, parent.do("POST", base, map[string]any{"body": "답글", "parentId": id}), 201)["id"].(string)
	commentStatus(t, parent.do("POST", base, map[string]any{"body": "두 단계 답글", "parentId": reply}), 400)
	commentStatus(t, parent.do("POST", base, map[string]any{"body": "없는 답글", "parentId": "missing"}), 404)
	communityData(t, peer.do("DELETE", path, nil), 200)
	if rows := commentRows(t, parent, post); rows[id]["deleted"] != true || rows[reply]["parentId"] != id {
		t.Fatal(rows)
	}
	communityData(t, parent.do("POST", base, map[string]any{"body": "계속 답글", "parentId": id}), 201)
	commentStatus(t, h.do("GET", base, nil), 403)
	commentStatus(t, parent.do("POST", "/api/posts/"+post+"/accept", map[string]any{"commentId": id}), 403)
	// Deleting old metadata-free rows is also compatible.
	if _, err := h.pool.Exec(context.Background(), `INSERT INTO "Comment"("id","postId","userId","body") VALUES('legacy-delete',$1,$2,'이전 삭제')`, pgx.QueryExecModeSimpleProtocol, post, peer.student); err != nil {
		t.Fatal(err)
	}
	communityData(t, peer.do("DELETE", base+"/legacy-delete", nil), 200)
	if commentRows(t, parent, post)["legacy-delete"]["deleted"] != true {
		t.Fatal("legacy redaction absent")
	}
}
