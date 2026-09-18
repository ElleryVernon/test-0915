package api

import (
	"context"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"memoryz/server/internal/store"
)

func directMessageUser(t *testing.T, h *aiHarness, id, role string) *aiHarness {
	t.Helper()
	ctx := context.Background()
	if _, err := h.pool.Exec(ctx, `INSERT INTO "User"("id","name","nickname","role") VALUES($1,$1,$1,$2)`, id, role); err != nil {
		t.Fatal(err)
	}
	cookie, _, err := h.s.auth.Create(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	copy := *h
	copy.student = id
	copy.cookie = strings.Split(cookie, ";")[0]
	return &copy
}
func directMessageList(t *testing.T, r *httptest.ResponseRecorder) []any {
	t.Helper()
	if r.Code != 200 {
		t.Fatalf("list: %d %s", r.Code, r.Body.String())
	}
	return bodyOf(r)["data"].([]any)
}
func directMessageSend(t *testing.T, h *aiHarness, peer, body, key string) map[string]any {
	t.Helper()
	return communityData(t, h.do("POST", "/api/messages", map[string]any{"userId": peer, "body": body, "requestId": key}), 201)
}
func directMessageStatus(t *testing.T, r *httptest.ResponseRecorder, want int) {
	t.Helper()
	if r.Code != want {
		t.Fatalf("status %d want %d: %s", r.Code, want, r.Body.String())
	}
}

func TestDirectMessageLifecyclePagingReadAndRetract(t *testing.T) {
	h := newAIHarness(t, nil)
	peer := directMessageUser(t, h, "dm-peer", "STUDENT")
	ctx := context.Background()
	// Same timestamps and deliberately reversed ids expose unstable timestamp-only cursors.
	for i := 0; i < 55; i++ {
		if _, err := h.pool.Exec(ctx, `INSERT INTO "Message"("id","senderId","recipientId","body","createdAt") VALUES($1,$2,$3,$4,'2026-01-01')`, fmt.Sprintf("history-%03d", 55-i), h.student, peer.student, fmt.Sprint(i)); err != nil {
			t.Fatal(err)
		}
	}
	latest := directMessageList(t, peer.do("GET", "/api/messages?userId="+h.student, nil))
	if len(latest) != 50 || latest[0].(map[string]any)["body"] != "5" || latest[49].(map[string]any)["body"] != "54" {
		t.Fatal("latest chronological page", len(latest))
	}
	earlier := directMessageList(t, peer.do("GET", "/api/messages?userId="+h.student+"&before="+latest[0].(map[string]any)["id"].(string), nil))
	if len(earlier) != 5 || earlier[0].(map[string]any)["body"] != "0" {
		t.Fatal("before cursor", earlier)
	}
	inbox := directMessageList(t, peer.do("GET", "/api/messages?inbox=1", nil))
	if inbox[0].(map[string]any)["unreadCount"] != float64(55) {
		t.Fatal("GET marked read", inbox)
	}
	boundary := latest[10].(map[string]any)["id"]
	communityData(t, peer.do("PATCH", "/api/messages", map[string]any{"userId": h.student, "throughId": boundary}), 200)
	inbox = directMessageList(t, peer.do("GET", "/api/messages?inbox=1", nil))
	if inbox[0].(map[string]any)["unreadCount"] != float64(39) {
		t.Fatal("read boundary overreached", inbox)
	}
	m := directMessageSend(t, h, peer.student, "hello", "send-once")
	id := m["id"].(string)
	if m["requestId"] != "send-once" {
		t.Fatal("own request id missing")
	}
	again := directMessageSend(t, h, peer.student, "ignored retry changed body", "send-once")
	if again["id"] != id || again["body"] != "hello" {
		t.Fatal("retry duplicated/edited")
	}
	reply := communityData(t, peer.do("POST", "/api/messages", map[string]any{"userId": h.student, "body": "reply", "requestId": "reply-once", "replyToId": id}), 201)
	if reply["replyTo"].(map[string]any)["body"] != "hello" {
		t.Fatal("missing snapshot", reply)
	}
	liked := communityData(t, peer.do("PATCH", "/api/messages/"+id, map[string]any{"reaction": "❤️"}), 200)
	if liked["requestId"] != nil {
		t.Fatal("other sender request id leaked")
	}
	if liked["reactions"].([]any)[0].(map[string]any)["count"] != float64(1) {
		t.Fatal("heart missing")
	}
	communityData(t, peer.do("PATCH", "/api/messages/"+id, map[string]any{"reaction": "❤️"}), 200)
	liked = communityData(t, h.do("PATCH", "/api/messages/"+id, map[string]any{"reaction": "❤️"}), 200)
	if liked["reactions"].([]any)[0].(map[string]any)["count"] != float64(2) {
		t.Fatal("heart not per-user")
	}
	liked = communityData(t, peer.do("PATCH", "/api/messages/"+id, map[string]any{"reaction": nil}), 200)
	if liked["reactions"].([]any)[0].(map[string]any)["mine"] != false {
		t.Fatal("heart removal")
	}
	directMessageStatus(t, peer.do("DELETE", "/api/messages/"+id, nil), 403)
	gone := communityData(t, h.do("DELETE", "/api/messages/"+id, nil), 200)
	if gone["deleted"] != true || gone["body"] != "" || len(gone["blocks"].([]any)) != 0 {
		t.Fatal("retract did not clear body")
	}
	gone = directMessageSend(t, h, peer.student, "hello", "send-once")
	if gone["id"] != id || gone["deleted"] != true {
		t.Fatal("retry resurrected deletion")
	}
	directMessageStatus(t, peer.do("PATCH", "/api/messages/"+id, map[string]any{"reaction": "❤️"}), 404)
	all := directMessageList(t, h.do("GET", "/api/messages?userId="+peer.student, nil))
	last := all[len(all)-1].(map[string]any)
	snap := last["replyTo"].(map[string]any)
	if snap["deleted"] != true || snap["body"] != "" {
		t.Fatal("reply leaked retracted text", snap)
	}
	communityData(t, peer.do("PATCH", "/api/messages", map[string]any{"userId": h.student, "throughId": last["id"]}), 200)
	fresh := directMessageSend(t, h, peer.student, "not visible yet", "fresh")
	all = directMessageList(t, h.do("GET", "/api/messages?userId="+peer.student, nil))
	if all[len(all)-1].(map[string]any)["id"] != fresh["id"] || all[len(all)-1].(map[string]any)["readAt"] != nil {
		t.Fatal("future message marked read")
	}
}

func TestDirectMessageAccessBoundaries(t *testing.T) {
	h := newAIHarness(t, nil)
	peer := directMessageUser(t, h, "dm-peer", "STUDENT")
	other := directMessageUser(t, h, "dm-other", "STUDENT")
	parent := directMessageUser(t, h, "dm-parent", "PARENT")
	ctx := context.Background()
	m := directMessageSend(t, h, peer.student, "private", "private-once")
	id := m["id"].(string)
	foreign := directMessageSend(t, other, peer.student, "elsewhere", "elsewhere")["id"].(string)
	for _, tc := range []struct {
		method, path string
		body         any
		status       int
	}{
		{"PATCH", "/api/messages/" + id, map[string]any{"reaction": "❤️"}, 404},
		{"DELETE", "/api/messages/" + id, nil, 404},
		{"POST", "/api/messages/" + id + "/blocks/nope/solve", map[string]any{"selected": 0}, 404},
		{"GET", "/api/messages?userId=" + peer.student + "&before=" + id, nil, 404},
		{"PATCH", "/api/messages", map[string]any{"userId": peer.student, "throughId": id}, 404},
		{"POST", "/api/messages", map[string]any{"userId": peer.student, "body": "reply", "replyToId": id}, 404},
	} {
		directMessageStatus(t, other.do(tc.method, tc.path, tc.body), tc.status)
	}
	directMessageStatus(t, h.do("POST", "/api/messages", map[string]any{"userId": peer.student, "body": "reply", "replyToId": foreign}), 404)
	directMessageStatus(t, h.do("POST", "/api/messages", map[string]any{"userId": other.student, "body": "reuse", "requestId": "private-once"}), 409)
	for _, target := range []string{h.student, parent.student, "missing"} {
		directMessageStatus(t, h.do("POST", "/api/messages", map[string]any{"userId": target, "body": "no"}), 404)
	}
	for _, payload := range []map[string]any{{"userId": peer.student, "body": " "}, {"userId": peer.student, "body": strings.Repeat("가", 3001)}, {"userId": peer.student, "body": "yes", "requestId": strings.Repeat("x", 101)}} {
		directMessageStatus(t, h.do("POST", "/api/messages", payload), 400)
	}
	directMessageStatus(t, h.do("PATCH", "/api/messages/"+id, map[string]any{"reaction": "🔥"}), 400)
	if _, err := h.pool.Exec(ctx, `INSERT INTO "Block"("userId","blockedId") VALUES($1,$2)`, peer.student, h.student); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		method, path string
		body         any
	}{
		{"GET", "/api/messages?userId=" + peer.student, nil},
		{"GET", "/api/messages?peer=1&userId=" + peer.student, nil},
		{"POST", "/api/messages", map[string]any{"userId": peer.student, "body": "private", "requestId": "private-once"}},
		{"PATCH", "/api/messages", map[string]any{"userId": peer.student, "throughId": id}},
		{"PATCH", "/api/messages/" + id, map[string]any{"reaction": "❤️"}},
		{"DELETE", "/api/messages/" + id, nil},
	} {
		directMessageStatus(t, h.do(tc.method, tc.path, tc.body), 403)
	}
	if got := directMessageList(t, h.do("GET", "/api/messages?inbox=1", nil)); len(got) != 0 {
		t.Fatal("blocked inbox visible")
	}
	if _, err := h.pool.Exec(ctx, `DELETE FROM "Block";UPDATE "User" SET "suspended"=true WHERE "id"=$1`, pgx.QueryExecModeSimpleProtocol, peer.student); err != nil {
		t.Fatal(err)
	}
	directMessageStatus(t, h.do("GET", "/api/messages?userId="+peer.student, nil), 404)
	if len(directMessageList(t, h.do("GET", "/api/messages?inbox=1", nil))) != 0 {
		t.Fatal("suspended inbox visible")
	}
}

func TestDirectMessageCanonicalLearningAndActions(t *testing.T) {
	h := newAIHarness(t, nil)
	peer := directMessageUser(t, h, "dm-peer", "STUDENT")
	other := directMessageUser(t, h, "dm-other", "STUDENT")
	ctx := context.Background()
	var subject string
	if err := h.pool.QueryRow(ctx, `SELECT "subjectId" FROM "Material" WHERE "id"=$1`, h.material).Scan(&subject); err != nil {
		t.Fatal(err)
	}
	_, err := h.pool.Exec(ctx, `INSERT INTO "Question"("id","userId","subjectId","materialId","prompt","options","answer","explanation","citation","past","future") VALUES('dm-q',$1,$2,$3,'진짜 문제',ARRAY['가','나'],1,'진짜 해설','원문','','');
 INSERT INTO "Card"("id","userId","subjectId","front","back","type","diagram","maskedNodeIds") VALUES('dm-card',$1,$2,'앞','뒤','BLIND','{"id":"d","nodes":[]}',ARRAY['mask']);
 INSERT INTO "Schedule"("id","userId","title","date","start","end","kind") VALUES('dm-flex',$1,'공부','2026-09-16','16:00','17:00','FLEXIBLE'),('dm-fixed',$1,'민감 학교','2026-09-16','08:00','16:00','FIXED');
 INSERT INTO "CommunityPrivacy"("userId","visibility") VALUES($4,'{"cardsDefault":true}');`, pgx.QueryExecModeSimpleProtocol, h.student, subject, h.material, peer.student)
	if err != nil {
		t.Fatal(err)
	}
	blocks := []any{map[string]any{"id": "question", "type": "QUESTION", "refId": "dm-q", "payload": map[string]any{"answer": 0, "explanation": "위조"}}, map[string]any{"id": "card", "type": "CARD", "refId": "dm-card"}, map[string]any{"id": "schedule", "type": "SCHEDULE", "payload": map[string]any{"rows": []any{map[string]any{"id": "dm-flex"}, map[string]any{"id": "dm-fixed"}}}}}
	input := map[string]any{"userId": peer.student, "body": "", "requestId": "learning-once", "blocks": blocks}
	m := communityData(t, h.do("POST", "/api/messages", input), 201)
	id := m["id"].(string)
	q := m["blocks"].([]any)[0].(map[string]any)
	if q["payload"].(map[string]any)["answer"] != float64(1) || q["refId"] != "dm-q" {
		t.Fatal("forged snapshot")
	}
	rows := m["blocks"].([]any)[2].(map[string]any)["payload"].(map[string]any)["rows"].([]any)
	if rows[1].(map[string]any)["title"] != "학교" {
		t.Fatal("school not redacted")
	}
	directMessageStatus(t, other.do("POST", "/api/messages", map[string]any{"userId": peer.student, "body": "", "blocks": []any{blocks[0]}}), 404)
	directMessageStatus(t, h.do("POST", "/api/messages", map[string]any{"userId": peer.student, "body": "", "blocks": append(blocks, map[string]any{"id": "extra", "type": "MATH", "payload": map[string]any{"text": "x"}})}), 400)
	received := directMessageList(t, peer.do("GET", "/api/messages?userId="+h.student, nil))[0].(map[string]any)
	for _, raw := range received["blocks"].([]any) {
		if raw.(map[string]any)["refId"] != nil {
			t.Fatal("private source id leaked")
		}
	}
	if _, err = h.pool.Exec(ctx, `DELETE FROM "Question" WHERE "id"='dm-q';UPDATE "Card" SET "deleted"=true WHERE "id"='dm-card'`); err != nil {
		t.Fatal(err)
	}
	replay := communityData(t, h.do("POST", "/api/messages", input), 201)
	if replay["id"] != id {
		t.Fatal("deleted source broke replay")
	}
	first := communityData(t, peer.do("POST", "/api/messages/"+id+"/blocks/question/solve", map[string]any{"selected": 0}), 200)
	again := communityData(t, peer.do("POST", "/api/messages/"+id+"/blocks/question/solve", map[string]any{"selected": 1}), 200)
	if first["correct"] != false || again["correct"] != false || again["stats"].(map[string]any)["attempts"] != float64(1) {
		t.Fatal("solve idempotency")
	}
	listed := directMessageList(t, peer.do("GET", "/api/messages?userId="+h.student, nil))[0].(map[string]any)
	if listed["blocks"].([]any)[0].(map[string]any)["stats"].(map[string]any)["attempts"] != float64(1) {
		t.Fatal("polling lost solve stats")
	}
	saved := communityData(t, peer.do("POST", "/api/messages/"+id+"/blocks/question/save-question", map[string]any{}), 200)
	again = communityData(t, peer.do("POST", "/api/messages/"+id+"/blocks/question/save-question", map[string]any{}), 200)
	if saved["id"] != again["id"] {
		t.Fatal("save duplicated")
	}
	copied := communityData(t, peer.do("POST", "/api/messages/"+id+"/blocks/card/clone", map[string]any{}), 200)
	again = communityData(t, peer.do("POST", "/api/messages/"+id+"/blocks/card/clone", map[string]any{}), 200)
	if copied["id"] != again["id"] {
		t.Fatal("clone duplicated")
	}
	var kind, bucket string
	var mask []string
	var public bool
	if err = h.pool.QueryRow(ctx, `SELECT c."type",c."bucket",c."maskedNodeIds",COALESCE(cc."public",false) FROM "Card" c LEFT JOIN "CommunityCard" cc ON cc."cardId"=c."id" WHERE c."id"=$1`, copied["id"]).Scan(&kind, &bucket, &mask, &public); err != nil || kind != "BLIND" || bucket != "AGAIN" || len(mask) != 1 || public {
		t.Fatal("private clone fidelity", err, kind, bucket, mask, public)
	}
	schedule := communityData(t, peer.do("POST", "/api/messages/"+id+"/blocks/schedule/schedule", map[string]any{"date": "2026-09-17"}), 200)
	if schedule["created"] != float64(1) || schedule["skipped"] != float64(1) {
		t.Fatal("schedule copy", schedule)
	}
	again = communityData(t, peer.do("POST", "/api/messages/"+id+"/blocks/schedule/schedule", map[string]any{"date": "2026-09-17"}), 200)
	if again["created"] != schedule["created"] {
		t.Fatal("schedule retry")
	}
	conflict := communityData(t, h.do("POST", "/api/messages/"+id+"/blocks/schedule/schedule", map[string]any{"date": "2026-09-16"}), 200)
	if conflict["created"] != float64(0) || conflict["skipped"] != float64(2) {
		t.Fatal("schedule overlap", conflict)
	}
	directMessageStatus(t, other.do("POST", "/api/messages/"+id+"/blocks/question/solve", map[string]any{"selected": 0}), 404)
	directMessageStatus(t, peer.do("POST", "/api/messages/"+id+"/blocks/question/solve", map[string]any{"selected": 2}), 400)
	directMessageStatus(t, peer.do("POST", "/api/messages/"+id+"/blocks/card/solve", map[string]any{"selected": 0}), 400)
	directMessageStatus(t, peer.do("POST", "/api/messages/"+id+"/blocks/schedule/schedule", map[string]any{"date": "2026-02-30"}), 400)
	var posts, attempts, actions, savedCount int
	if err = h.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM "Post"),(SELECT count(*) FROM "Attempt"),(SELECT count(*) FROM "CommunityAction"),(SELECT count(*) FROM "MessageSavedQuestion" WHERE "questionId"=$1 AND "userId"=$2)`, saved["id"], peer.student).Scan(&posts, &attempts, &actions, &savedCount); err != nil || posts != 0 || attempts != 0 || actions != 0 || savedCount != 1 {
		t.Fatal("private action isolation", err, posts, attempts, actions, savedCount)
	}
	bootstrap := communityData(t, peer.do("GET", "/api/bootstrap", nil), 200)
	found := false
	for _, raw := range bootstrap["questions"].([]any) {
		q := raw.(map[string]any)
		if q["id"] == saved["id"] {
			found = q["savedToNotes"] == true && (q["communityPostId"] == nil || q["communityPostId"] == "")
		}
	}
	if !found {
		t.Fatal("DM saved question missing from notes")
	}
	if _, err = h.pool.Exec(ctx, `INSERT INTO "Block"("userId","blockedId") VALUES($1,$2)`, h.student, peer.student); err != nil {
		t.Fatal(err)
	}
	directMessageStatus(t, peer.do("POST", "/api/messages/"+id+"/blocks/question/solve", map[string]any{"selected": 0}), 403)
	if _, err = h.pool.Exec(ctx, `DELETE FROM "Block" WHERE "userId"=$1 AND "blockedId"=$2`, h.student, peer.student); err != nil {
		t.Fatal(err)
	}
	communityData(t, peer.do("POST", "/api/messages/"+id+"/blocks/question/solve", map[string]any{"selected": 0}), 200)
	communityData(t, h.do("DELETE", "/api/messages/"+id, nil), 200)
	directMessageStatus(t, peer.do("POST", "/api/messages/"+id+"/blocks/question/save-question", map[string]any{}), 404)
}

func TestDirectMessagePollParentsAndConcurrentRetries(t *testing.T) {
	h := newAIHarness(t, nil)
	peer := directMessageUser(t, h, "dm-peer", "STUDENT")
	parent := directMessageUser(t, h, "dm-parent", "PARENT")
	parentPeer := directMessageUser(t, h, "dm-parent-peer", "PARENT")
	// A simultaneous retry exercises the transaction and unique key rather than sequential luck.
	results := make(chan *httptest.ResponseRecorder, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- h.do("POST", "/api/messages", map[string]any{"userId": peer.student, "body": "once", "requestId": "concurrent-once"})
		}()
	}
	wg.Wait()
	close(results)
	var id any
	for rec := range results {
		m := communityData(t, rec, 201)
		if id != nil && m["id"] != id {
			t.Fatal("concurrent duplicate")
		}
		id = m["id"]
	}
	if len(directMessageList(t, peer.do("GET", "/api/messages?userId="+h.student, nil))) != 1 {
		t.Fatal("duplicate delivered")
	}
	poll := map[string]any{"id": "poll", "type": "POLL", "payload": map[string]any{"question": "언제?", "options": []string{"오늘", "내일"}}}
	m := communityData(t, parent.do("POST", "/api/messages", map[string]any{"userId": parentPeer.student, "body": "", "blocks": []any{poll}}), 201)
	pollID := m["id"].(string)
	vote := communityData(t, parentPeer.do("POST", "/api/messages/"+pollID+"/blocks/poll/vote", map[string]any{"selected": 1}), 200)
	if vote["stats"].(map[string]any)["voted"] != float64(1) {
		t.Fatal("vote state")
	}
	pollMessage := directMessageList(t, parentPeer.do("GET", "/api/messages?userId="+parent.student, nil))[0].(map[string]any)
	if pollMessage["blocks"].([]any)[0].(map[string]any)["stats"].(map[string]any)["voted"] != float64(1) {
		t.Fatal("polling lost vote state")
	}
	originalNow := h.s.now
	h.s.now = func() time.Time { return originalNow().Add(25 * time.Hour) }
	vote = communityData(t, parentPeer.do("POST", "/api/messages/"+pollID+"/blocks/poll/vote", map[string]any{"selected": 0}), 200)
	if vote["selected"] != float64(1) {
		t.Fatal("expired retry changed vote")
	}
	directMessageStatus(t, parent.do("POST", "/api/messages/"+pollID+"/blocks/poll/vote", map[string]any{"selected": 0}), 409)
	directMessageStatus(t, parent.do("POST", "/api/messages/"+pollID+"/blocks/poll/solve", map[string]any{"selected": 0}), 403)
	directMessageStatus(t, parent.do("POST", "/api/messages", map[string]any{"userId": parentPeer.student, "body": "", "blocks": []any{map[string]any{"id": "math", "type": "MATH", "payload": map[string]any{"text": "x"}}}}), 403)
}

func TestDirectMessageBidirectionalSend(t *testing.T) {
	h := newAIHarness(t, nil)
	peer := directMessageUser(t, h, "dm-peer", "STUDENT")
	// Both transactions own their sender row, then must validate the recipient FK.
	// A FOR UPDATE sender lock deadlocks opposite sends; NO KEY UPDATE permits both.
	results := make(chan *httptest.ResponseRecorder, 16)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		for _, pair := range [][2]*aiHarness{{h, peer}, {peer, h}} {
			wg.Add(1)
			go func(i int, sender, recipient *aiHarness) {
				defer wg.Done()
				results <- sender.do("POST", "/api/messages", map[string]any{"userId": recipient.student, "body": "동시 전송", "requestId": fmt.Sprintf("bidirectional-%d", i)})
			}(i, pair[0], pair[1])
		}
	}
	wg.Wait()
	close(results)
	for rec := range results {
		directMessageStatus(t, rec, 201)
	}
	messages := directMessageList(t, h.do("GET", "/api/messages?userId="+peer.student, nil))
	if len(messages) != 16 {
		t.Fatal("missing concurrent delivery")
	}
	var previous float64
	for _, raw := range messages {
		m := raw.(map[string]any)
		ordinal, ok := m["ordinal"].(float64)
		if !ok || ordinal <= previous {
			t.Fatal("unstable ordinal", m)
		}
		previous = ordinal
	}
}

func TestDirectMessageOtherCanonicalAttachments(t *testing.T) {
	h := newAIHarness(t, nil)
	peer := directMessageUser(t, h, "dm-peer", "STUDENT")
	ctx := context.Background()
	var subject string
	if err := h.pool.QueryRow(ctx, `SELECT "subjectId" FROM "Material" WHERE "id"=$1`, h.material).Scan(&subject); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(ctx, `INSERT INTO "Essay"("id","userId","subjectId","materialId","prompt","modelAnswer","citation") VALUES('dm-essay',$1,$2,$3,'진짜 서술형','정답','원문')`, h.student, subject, h.material); err != nil {
		t.Fatal(err)
	}
	cases := []any{
		map[string]any{"id": "essay", "type": "ESSAY", "refId": "dm-essay", "payload": map[string]any{"score": 100}},
		map[string]any{"id": "material", "type": "MATERIAL", "refId": h.material, "payload": map[string]any{"text": "나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.", "page": 1}},
		map[string]any{"id": "math", "type": "MATH", "payload": map[string]any{"text": "x^2 + y^2 = 1"}},
		map[string]any{"id": "photo", "type": "PHOTO", "payload": map[string]any{"image": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=", "caption": "풀이"}},
	}
	for _, b := range cases {
		communityData(t, h.do("POST", "/api/messages", map[string]any{"userId": peer.student, "body": "", "blocks": []any{b}}), 201)
	}
	messages := directMessageList(t, peer.do("GET", "/api/messages?userId="+h.student, nil))
	if len(messages) != 4 {
		t.Fatal("attachment types missing")
	}
	essay := messages[0].(map[string]any)["blocks"].([]any)[0].(map[string]any)["payload"].(map[string]any)
	if essay["prompt"] != "진짜 서술형" || essay["score"] != nil {
		t.Fatal("essay payload forged", essay)
	}
	for _, m := range messages {
		b := m.(map[string]any)["blocks"].([]any)[0].(map[string]any)
		if b["refId"] != nil {
			t.Fatal("source reference leaked")
		}
	}
	photo := messages[3].(map[string]any)["blocks"].([]any)[0].(map[string]any)["payload"].(map[string]any)
	if !strings.HasPrefix(photo["image"].(string), "data:image/png;base64,") {
		t.Fatal("conversation omitted full photo snapshot")
	}
	inboxResponse := peer.do("GET", "/api/messages?inbox=1", nil)
	inbox := directMessageList(t, inboxResponse)
	preview := inbox[0].(map[string]any)["blocks"].([]any)[0].(map[string]any)
	if preview["type"] != "PHOTO" || len(preview["payload"].(map[string]any)) != 0 || preview["refId"] != nil || strings.Contains(inboxResponse.Body.String(), "data:image") {
		t.Fatal("inbox fetched attachment content", preview)
	}
	directMessageStatus(t, h.do("POST", "/api/messages", map[string]any{"userId": peer.student, "blocks": []any{map[string]any{"id": "material", "type": "MATERIAL", "refId": h.material, "payload": map[string]any{"text": "invented excerpt"}}}}), 400)
}

func TestDirectMessageConcurrentAttachmentsWithSmallPool(t *testing.T) {
	h := newAIHarness(t, nil)
	peer := directMessageUser(t, h, "dm-peer", "STUDENT")
	ctx := context.Background()
	conf := h.pool.Config()
	conf.MaxConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, conf)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	h.s.pool = pool
	h.s.q = store.New(pool)
	results := make(chan *httptest.ResponseRecorder, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results <- h.do("POST", "/api/messages", map[string]any{"userId": peer.student, "body": "", "requestId": fmt.Sprintf("small-pool-%d", i), "blocks": []any{map[string]any{"id": "material", "type": "MATERIAL", "refId": h.material, "payload": map[string]any{"text": "나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다."}}}})
		}(i)
	}
	wg.Wait()
	close(results)
	for rec := range results {
		directMessageStatus(t, rec, 201)
	}
	if len(directMessageList(t, peer.do("GET", "/api/messages?userId="+h.student, nil))) != 8 {
		t.Fatal("attachment delivery missing")
	}
}
