package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"memoryz/server/internal/auth"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/store"
)

func communityData(t *testing.T, r *httptest.ResponseRecorder, status int) map[string]any {
	t.Helper()
	if r.Code != status {
		t.Fatalf("status %d want %d: %s", r.Code, status, r.Body.String())
	}
	return bodyOf(r)["data"].(map[string]any)
}
func TestCommunityLearningSnapshotsAndActions(t *testing.T) {
	h := newAIHarness(t, nil)
	ctx := context.Background()
	var subject string
	if e := h.pool.QueryRow(ctx, `SELECT "subjectId" FROM "Material" WHERE "id"=$1`, h.material).Scan(&subject); e != nil {
		t.Fatal(e)
	}
	_, e := h.pool.Exec(ctx, `INSERT INTO "Question"("id","userId","subjectId","materialId","prompt","options","answer","explanation","citation","past","future") VALUES('cq',$1,$2,$3,'문제',ARRAY['가','나'],1,'원문 해설','원문','','');INSERT INTO "User"("id","name","nickname","role","grade") VALUES('cp','실명','친구','STUDENT','고1');`, pgx.QueryExecModeSimpleProtocol, h.student, subject, h.material)
	if e != nil {
		t.Fatal(e)
	}
	// Only own refs accepted; caller supplied answers are discarded.
	in := map[string]any{"title": "학습 질문", "body": "", "category": "질문", "anonymous": true, "requestId": "post-once", "blocks": []any{map[string]any{"id": "bq", "type": "QUESTION", "refId": "cq", "hidden": true, "payload": map[string]any{"answer": 0, "explanation": "위조"}}}, "sourceRef": map[string]any{"kind": "QUESTION", "questionId": "cq"}}
	p := communityData(t, h.do("POST", "/api/posts", in), 201)
	id := p["id"].(string)
	if tags := p["tags"].(map[string]any); tags["grade"] != nil || tags["examDday"] != nil {
		t.Fatal("implicit private tags", tags)
	}
	blocks := p["blocks"].([]any)
	if blocks[0].(map[string]any)["payload"].(map[string]any)["answer"].(float64) != 1 {
		t.Fatal("snapshot forged")
	}
	if _, err := h.pool.Exec(ctx, `DELETE FROM "Question" WHERE "id"='cq'`); err != nil {
		t.Fatal(err)
	}
	repeated := communityData(t, h.do("POST", "/api/posts", in), 201)
	if repeated["id"] != id {
		t.Fatal("duplicate post")
	}
	first := communityData(t, h.do("POST", "/api/posts/"+id+"/blocks/bq/solve", map[string]any{"selected": 0}), 200)
	again := communityData(t, h.do("POST", "/api/posts/"+id+"/blocks/bq/solve", map[string]any{"selected": 1}), 200)
	if first["correct"] != false || again["correct"] != false {
		t.Fatal("solve aggregation not idempotent")
	}
	var n int
	if e = h.pool.QueryRow(ctx, `SELECT count(*) FROM "Attempt" WHERE "userId"=$1`, h.student).Scan(&n); e != nil || n != 0 {
		t.Fatal("community solve created private attempt", n, e)
	}
	saved := communityData(t, h.do("POST", "/api/posts/"+id+"/blocks/bq/save-question", map[string]any{}), 200)
	again = communityData(t, h.do("POST", "/api/posts/"+id+"/blocks/bq/save-question", map[string]any{}), 200)
	if saved["id"] != again["id"] {
		t.Fatal("question duplicated")
	}
	bootstrap := communityData(t, h.do("GET", "/api/bootstrap", nil), 200)
	found := false
	for _, raw := range bootstrap["questions"].([]any) {
		q := raw.(map[string]any)
		if q["id"] == saved["id"] {
			found = q["savedToNotes"] == true && q["communityPostId"] == id
		}
	}
	if !found {
		t.Fatal("saved review entry absent")
	}
	c := communityData(t, h.do("POST", "/api/posts/"+id+"/comments", map[string]any{"body": "작성자 답글", "requestId": "comment-once"}), 201)
	c2 := communityData(t, h.do("POST", "/api/posts/"+id+"/comments", map[string]any{"body": "작성자 답글", "requestId": "comment-once"}), 201)
	if c["id"] != c2["id"] {
		t.Fatal("duplicate comment")
	}
	rec := h.do("GET", "/api/posts/"+id+"/comments", nil)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	for _, raw := range bodyOf(rec)["data"].([]any) {
		v := raw.(map[string]any)
		if v["authorId"] != nil || v["author"] != "익명 · 글쓴이" {
			t.Fatal("anonymous identity linked", v)
		}
	}
	_, e = h.pool.Exec(ctx, `INSERT INTO "Comment"("id","postId","userId","body") VALUES('answer',$1,'cp','답변'),('answer2',$1,'cp','추가 답변')`, id)
	if e != nil {
		t.Fatal(e)
	}
	for _, cid := range []string{"answer", "answer", "answer2", "answer"} {
		communityData(t, h.do("POST", "/api/posts/"+id+"/accept", map[string]any{"commentId": cid}), 200)
	}
	var points int
	_ = h.pool.QueryRow(ctx, `SELECT "points" FROM "User" WHERE "id"='cp'`).Scan(&points)
	if points != 50 {
		t.Fatal("reward minted twice", points)
	}
	if rec = h.do("POST", "/api/posts/"+id+"/accept", map[string]any{"commentId": c["id"]}); rec.Code != 400 {
		t.Fatal("accepted own", rec.Code)
	}
	communityData(t, h.do("DELETE", "/api/posts/"+id, nil), 200)
	if rec = h.do("GET", "/api/posts/"+id, nil); rec.Code != 404 {
		t.Fatal("deleted post visible")
	}
	if rec = h.do("POST", "/api/posts/"+id+"/blocks/bq/solve", map[string]any{"selected": 1}); rec.Code != 404 {
		t.Fatal("deleted post actionable")
	}
}
func TestCommunityPollCloneScheduleAndPrivacy(t *testing.T) {
	h := newAIHarness(t, nil)
	ctx := context.Background()
	var subject string
	if e := h.pool.QueryRow(ctx, `SELECT "subjectId" FROM "Material" WHERE "id"=$1`, h.material).Scan(&subject); e != nil {
		t.Fatal(e)
	}
	_, e := h.pool.Exec(ctx, `UPDATE "User" SET "grade"='고1' WHERE "id"=$1;INSERT INTO "User"("id","name","nickname","role","grade","school") VALUES('pub','비공개 실명','공개닉','STUDENT','고2','비공개학교');INSERT INTO "Subject"("id","userId","name") VALUES('pubsub','pub','한국사');INSERT INTO "Card"("id","userId","subjectId","front","back","type","diagram","maskedNodeIds") VALUES('owncard',$1,$2,'앞','뒤','BLIND','{"id":"d","nodes":[]}',ARRAY['n']);INSERT INTO "Schedule"("id","userId","title","date","start","end","kind") VALUES('schedule1',$1,'수학','2026-09-16','16:00','17:00','FLEXIBLE'),('school1',$1,'민감학교','2026-09-16','08:00','16:00','FIXED')`, pgx.QueryExecModeSimpleProtocol, h.student, subject)
	if e != nil {
		t.Fatal(e)
	}
	h.s.auth.Invalidate(ctx, h.student)
	blocks := []any{map[string]any{"id": "poll", "type": "POLL", "payload": map[string]any{"question": "투표", "options": []string{"가", "나"}}}, map[string]any{"id": "card", "type": "CARD", "refId": "owncard"}, map[string]any{"id": "schedule", "type": "SCHEDULE", "payload": map[string]any{"rows": []any{map[string]any{"id": "school1"}, map[string]any{"id": "schedule1"}}}}}
	p := communityData(t, h.do("POST", "/api/posts", map[string]any{"title": "공유", "body": "", "category": "자유", "anonymous": false, "blocks": blocks}), 201)
	id := p["id"].(string)
	vote := communityData(t, h.do("POST", "/api/posts/"+id+"/blocks/poll/vote", map[string]any{"selected": 1}), 200)
	if vote["stats"].(map[string]any)["voted"].(float64) != 1 {
		t.Fatal("vote state")
	}
	communityData(t, h.do("POST", "/api/posts/"+id+"/blocks/poll/vote", map[string]any{"selected": 0}), 200)
	c := communityData(t, h.do("POST", "/api/posts/"+id+"/blocks/card/clone", map[string]any{}), 200)
	c2 := communityData(t, h.do("POST", "/api/posts/"+id+"/blocks/card/clone", map[string]any{}), 200)
	if c["id"] != c2["id"] {
		t.Fatal("duplicate clone")
	}
	var bucket string
	var nodes []string
	var diagram []byte
	_ = h.pool.QueryRow(ctx, `SELECT "bucket","maskedNodeIds","diagram" FROM "Card" WHERE "id"=$1`, c["id"]).Scan(&bucket, &nodes, &diagram)
	if bucket != "AGAIN" || len(nodes) != 1 || len(diagram) == 0 {
		t.Fatal("clone lost mask", bucket, nodes, string(diagram))
	}
	sched := communityData(t, h.do("POST", "/api/posts/"+id+"/blocks/schedule/schedule", map[string]any{"date": "2026-09-17"}), 200)
	if sched["created"] != float64(1) || sched["skipped"] != float64(1) {
		t.Fatal(sched)
	}
	communityData(t, h.do("POST", "/api/posts/"+id+"/blocks/schedule/schedule", map[string]any{"date": "2026-09-17"}), 200)
	if r := h.do("POST", "/api/follow", map[string]any{"userId": "pub", "following": true}); r.Code != 403 {
		t.Fatal("grade constraint", r.Code)
	}
	profile := communityData(t, h.do("GET", "/api/community/profiles/pub", nil), 200)
	if profile["name"] != nil || profile["school"] != nil || profile["followers"] != nil {
		t.Fatal("private field leaked")
	}
	_, e = h.pool.Exec(ctx, `INSERT INTO "CommunityPrivacy"("userId","visibility") VALUES('pub','{"grade":false,"subjects":false,"followerCount":false,"cardsDefault":false,"whoCanFollow":"ALL"}')`)
	if e != nil {
		t.Fatal(e)
	}
	for range 2 {
		communityData(t, h.do("POST", "/api/follow", map[string]any{"userId": "pub", "following": true}), 200)
	}
	var count int
	_ = h.pool.QueryRow(ctx, `SELECT count(*) FROM "CommunityFollowEvent" WHERE "userId"=$1`, h.student).Scan(&count)
	if count != 1 {
		t.Fatal("idempotent follow consumed quota", count)
	}
	profile = communityData(t, h.do("GET", "/api/community/profiles/pub", nil), 200)
	if profile["grade"] != nil || len(profile["subjects"].([]any)) != 0 {
		t.Fatal("privacy not enforced")
	}
	communityData(t, h.do("POST", "/api/blocks", map[string]any{"userId": "pub"}), 200)
	if r := h.do("GET", "/api/community/profiles/pub", nil); r.Code != 403 {
		t.Fatal("block bypass")
	}
	_ = h.pool.QueryRow(ctx, `SELECT count(*) FROM "Follow" WHERE "followerId"=$1 OR "followingId"=$1`, h.student).Scan(&count)
	if count != 0 {
		t.Fatal("block retained follow")
	}
}
func TestCommunityRejectsForgedReferencesAndPollDeadline(t *testing.T) {
	h := newAIHarness(t, nil)
	create := func(block any) *httptest.ResponseRecorder {
		return h.do("POST", "/api/posts", map[string]any{"title": "첨부", "body": "", "category": "자유", "anonymous": false, "blocks": []any{block}})
	}
	if r := create(map[string]any{"id": "q", "type": "QUESTION", "refId": "foreign"}); r.Code != 404 {
		t.Fatal(r.Code)
	}
	if r := create(map[string]any{"id": "p", "type": "PHOTO", "payload": map[string]any{"image": "https://private.example/photo.png"}}); r.Code != 400 {
		t.Fatal(r.Code)
	}
	if r := create(map[string]any{"id": "s", "type": "SCHEDULE", "payload": map[string]any{"rows": []any{map[string]any{"date": "2026-09-16", "start": "00:00", "end": "23:59"}}}}); r.Code != 404 {
		t.Fatal(r.Code)
	}
	p := communityData(t, create(map[string]any{"id": "poll", "type": "POLL", "payload": map[string]any{"question": "질문", "options": []string{"가", "나"}}}), 201)
	id := p["id"].(string)
	_, e := h.pool.Exec(context.Background(), `UPDATE "CommunityPost" SET "blocks"=jsonb_set("blocks",'{0,payload,closesAt}','"2000-01-01T00:00:00Z"') WHERE "postId"=$1`, id)
	if e != nil {
		t.Fatal(e)
	}
	if r := h.do("POST", "/api/posts/"+id+"/blocks/poll/vote", map[string]any{"selected": 0}); r.Code != 409 {
		t.Fatal(r.Code, r.Body.String())
	}

}

func TestCommunitySnapshotEditsAndPublicCardPrivacy(t *testing.T) {
	h := newAIHarness(t, nil)
	ctx := context.Background()
	var subject string
	_ = h.pool.QueryRow(ctx, `SELECT "subjectId" FROM "Material" WHERE "id"=$1`, h.material).Scan(&subject)
	_, e := h.pool.Exec(ctx, `INSERT INTO "Card"("id","userId","subjectId","front","back","type") VALUES('retained',$1,$2,'원래 앞','원래 뒤','RELATION')`, h.student, subject)
	if e != nil {
		t.Fatal(e)
	}
	p := communityData(t, h.do("POST", "/api/posts", map[string]any{"title": "카드공유", "body": "본문", "category": "자유", "anonymous": false, "blocks": []any{map[string]any{"id": "retained-block", "type": "CARD", "refId": "retained"}}}), 201)
	if _, e = h.pool.Exec(ctx, `UPDATE "Card" SET "deleted"=true,"front"='원본 변경' WHERE "id"='retained'`); e != nil {
		t.Fatal(e)
	}
	id := p["id"].(string)
	p["body"] = "본문만 수정"
	p = communityData(t, h.do("PATCH", "/api/posts/"+id, p), 200)
	block := p["blocks"].([]any)[0].(map[string]any)
	if block["payload"].(map[string]any)["front"] != "원래 앞" || block["sourceDeleted"] != true {
		t.Fatal("snapshot mutated", block)
	}
	clone := communityData(t, h.do("POST", "/api/posts/"+id+"/blocks/retained-block/clone", map[string]any{}), 200)
	var kind string
	_ = h.pool.QueryRow(ctx, `SELECT "type" FROM "Card" WHERE "id"=$1`, clone["id"]).Scan(&kind)
	if kind != "RELATION" {
		t.Fatal("clone downgraded", kind)
	}
	communityData(t, h.do("PATCH", "/api/community/profile", map[string]any{"visibility": map[string]any{"cardsDefault": true, "grade": false}}), 200)
	_, e = h.pool.Exec(ctx, `INSERT INTO "Card"("id","userId","subjectId","front","back") VALUES('futurecard',$1,$2,'새앞','새뒤')`, h.student, subject)
	if e != nil {
		t.Fatal(e)
	}
	var public bool
	_ = h.pool.QueryRow(ctx, `SELECT "public" FROM "CommunityCard" WHERE "cardId"='futurecard'`).Scan(&public)
	if !public {
		t.Fatal("future card default not applied")
	}
	communityData(t, h.do("PATCH", "/api/community/cards/futurecard", map[string]any{"public": false}), 200)
	if r := h.do("POST", "/api/community/cards/futurecard/clone", map[string]any{}); r.Code != 404 {
		t.Fatal("private card clone accessible")
	}
	communityData(t, h.do("PATCH", "/api/community/cards/futurecard", map[string]any{"public": true}), 200)
	c1 := communityData(t, h.do("POST", "/api/community/cards/futurecard/clone", map[string]any{}), 200)
	c2 := communityData(t, h.do("POST", "/api/community/cards/futurecard/clone", map[string]any{}), 200)
	if c1["id"] != c2["id"] {
		t.Fatal("public clone duplicated")
	}
	own := communityData(t, h.do("GET", "/api/community/profiles/"+h.student, nil), 200)
	if own["isMine"] != true {
		t.Fatal("own profile")
	}
}
func TestCommunityCommentNotificationsAndAnonymousBlock(t *testing.T) {
	h := newAIHarness(t, nil)
	ctx := context.Background()
	_, e := h.pool.Exec(ctx, `INSERT INTO "User"("id","name","nickname","role") VALUES('anon-owner','비공개실명','비공개닉','STUDENT');INSERT INTO "Post"("id","userId","role","category","title","body","anonymous") VALUES('anon-post','anon-owner','STUDENT','질문','질문제목','본문',true)`)
	if e != nil {
		t.Fatal(e)
	}
	for _, req := range []string{"reply-once", "reply-once", "reply-two"} {
		communityData(t, h.do("POST", "/api/posts/anon-post/comments", map[string]any{"body": "첫답변", "requestId": req}), 201)
	}
	var n int
	var href string
	_ = h.pool.QueryRow(ctx, `SELECT count(*),min("href") FROM "Notification" WHERE "userId"='anon-owner' AND "kind"='FIRST_ANSWER'`).Scan(&n, &href)
	if n != 1 || href != "/community?post=anon-post" {
		t.Fatal("first answer notification", n, href)
	}
	var body string
	_ = h.pool.QueryRow(ctx, `SELECT "body" FROM "Notification" WHERE "userId"='anon-owner' AND "kind"='MORE_ANSWERS'`).Scan(&body)
	if body != "답변이 1개 더 왔어요" {
		t.Fatal("more-answers bundle", body)
	}
	communityData(t, h.do("POST", "/api/posts/anon-post/comments", map[string]any{"body": "셋째", "requestId": "reply-three"}), 201)
	_ = h.pool.QueryRow(ctx, `SELECT count(*),max("body") FROM "Notification" WHERE "userId"='anon-owner' AND "kind"='MORE_ANSWERS'`).Scan(&n, &body)
	if n != 1 || body != "답변이 2개 더 왔어요" {
		t.Fatal("more-answers bundle refresh", n, body)
	}
	communityData(t, h.do("POST", "/api/blocks", map[string]any{"postId": "anon-post"}), 200)
	if r := h.do("GET", "/api/posts/anon-post", nil); r.Code != 404 {
		t.Fatal("anonymous author block bypass", r.Code)
	}
}

func TestCommunityFrontier(t *testing.T) {
	h := newAIHarness(t, nil)
	ctx := context.Background()
	peer := "frontier-peer-" + ids.Token(3)
	if _, e := h.pool.Exec(ctx, `INSERT INTO "User"("id","name","nickname","role","grade") VALUES($1,'실명','친구','STUDENT','고3'); UPDATE "User" SET "grade"='고3' WHERE "id"=$2`, pgx.QueryExecModeSimpleProtocol, peer, h.student); e != nil {
		t.Fatal(e)
	}
	peerSession, _, e := h.s.auth.Create(ctx, peer)
	if e != nil {
		t.Fatal(e)
	}
	doAs := func(cookie, method, path string, body any) *httptest.ResponseRecorder {
		var reader io.Reader
		if body != nil {
			raw, _ := json.Marshal(body)
			reader = bytes.NewReader(raw)
		}
		req := httptest.NewRequest(method, path, reader)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Cookie", cookie+"; "+auth.SignedInCookie+"=1")
		rec := httptest.NewRecorder()
		h.handler.ServeHTTP(rec, req)
		return rec
	}
	peerCookie := strings.Split(peerSession, ";")[0]
	p := communityData(t, h.do("POST", "/api/posts", map[string]any{"title": "질문", "body": "본문", "category": "질문", "anonymous": false, "requestId": "rel-post"}), 201)
	post := p["id"].(string)
	c := communityData(t, doAs(peerCookie, "POST", "/api/posts/"+post+"/comments", map[string]any{"body": "이렇게 풀어요", "requestId": "rel-comment"}), 201)
	communityData(t, h.do("POST", "/api/posts/"+post+"/accept", map[string]any{"commentId": c["id"]}), 200)
	if _, e = h.pool.Exec(ctx, `INSERT INTO "Card"("id","userId","subjectId","front","back","type","bucket") VALUES('rel-card',$1,(SELECT "id" FROM "Subject" WHERE "userId"=$2 LIMIT 1),'앞','뒤','CONCEPT','AGAIN'); INSERT INTO "CommunityCard"("cardId","public") VALUES('rel-card',true)`, pgx.QueryExecModeSimpleProtocol, peer, h.student); e != nil {
		t.Fatal(e)
	}
	communityData(t, h.do("POST", "/api/community/cards/rel-card/clone", map[string]any{}), 200)
	profile := communityData(t, h.do("GET", "/api/community/profiles/"+peer, nil), 200)
	relation, ok := profile["relation"].(map[string]any)
	if !ok || relation["answersToMe"] != float64(1) || relation["acceptedForMe"] != float64(1) || relation["cardsICloned"] != float64(1) {
		t.Fatal("relation stats", profile["relation"])
	}
	own := communityData(t, h.do("GET", "/api/community/profiles/"+h.student, nil), 200)
	if _, ok = own["relation"]; ok {
		t.Fatal("own profile must not carry a relation line")
	}
	communityData(t, h.do("PATCH", "/api/community/profile", map[string]any{"nickname": "새닉네임"}), 200)
	if r := h.do("PATCH", "/api/community/profile", map[string]any{"nickname": "또다른닉"}); r.Code != 429 {
		t.Fatal("nickname cooldown", r.Code, r.Body.String())
	}
	communityData(t, h.do("PATCH", "/api/community/profile", map[string]any{"nickname": "새닉네임"}), 200)
	if r := h.do("PATCH", "/api/community/profile", map[string]any{"nickname": "열세글자를넘는닉네임은안돼"}); r.Code != 400 {
		t.Fatal("nickname length", r.Code)
	}
	// The 7-day accept ask and the 21:00 digest materialise on the nudge pass.
	old := time.Now().Add(-8 * 24 * time.Hour)
	if _, e = h.pool.Exec(ctx, `INSERT INTO "Post"("id","userId","role","category","title","body","anonymous","createdAt") VALUES('old-q',$1,'STUDENT','질문','오래된 질문','본문',false,$2); INSERT INTO "CommunityPost"("postId","userId") VALUES('old-q',$1); INSERT INTO "Comment"("id","postId","userId","body") VALUES('old-c','old-q',$3,'답변 있음')`, pgx.QueryExecModeSimpleProtocol, h.student, old, peer); e != nil {
		t.Fatal(e)
	}
	communityData(t, h.do("POST", "/api/follow", map[string]any{"userId": peer, "following": true}), 200)
	year, month, day := time.Now().In(seoul).Date()
	fixed := time.Date(year, month, day, 21, 30, 0, 0, seoul)
	// A same-day Korean answer can have the previous UTC calendar date.
	// Pin this boundary so the digest regression is independent of test time.
	acceptedAt := time.Date(year, month, day, 0, 30, 0, 0, seoul).UTC()
	if _, e = h.pool.Exec(ctx, `UPDATE "CommunityPost" SET "solvedAt"=$2 WHERE "postId"=$1`, post, acceptedAt); e != nil {
		t.Fatal(e)
	}
	h.s.now = func() time.Time { return fixed }
	defer func() { h.s.now = func() time.Time { return time.Now().UTC().Truncate(time.Millisecond) } }()
	if e = h.s.communityNudges(ctx, store.User{ID: h.student, Role: store.RoleSTUDENT}); e != nil {
		t.Fatal(e)
	}
	var kind, digestBody string
	var n int
	_ = h.pool.QueryRow(ctx, `SELECT "kind",count(*) FROM "Notification" WHERE "userId"=$1 AND "kind" IN ('ACCEPT_ASK','FOLLOWING_DIGEST') GROUP BY 1`, h.student).Scan(&kind, &n)
	rows, e := h.pool.Query(ctx, `SELECT "kind","body" FROM "Notification" WHERE "userId"=$1 AND "kind" IN ('ACCEPT_ASK','FOLLOWING_DIGEST')`, h.student)
	if e != nil {
		t.Fatal(e)
	}
	seen := map[string]string{}
	for rows.Next() {
		var k, b string
		if e = rows.Scan(&k, &b); e != nil {
			t.Fatal(e)
		}
		seen[k] = b
	}
	rows.Close()
	if !strings.Contains(seen["ACCEPT_ASK"], "해결") && !strings.Contains(seen["ACCEPT_ASK"], "일 전 질문") {
		t.Fatal("accept-ask nudge", seen)
	}
	if digestBody = seen["FOLLOWING_DIGEST"]; !strings.Contains(digestBody, "채택된 답변 1개") {
		t.Fatal("following digest", seen)
	}
	if e = h.s.communityNudges(ctx, store.User{ID: h.student, Role: store.RoleSTUDENT}); e != nil {
		t.Fatal(e)
	}
	_ = h.pool.QueryRow(ctx, `SELECT count(*) FROM "Notification" WHERE "userId"=$1 AND "kind" IN ('ACCEPT_ASK','FOLLOWING_DIGEST')`, h.student).Scan(&n)
	if n != 2 {
		t.Fatal("nudges must be idempotent", n)
	}
}
