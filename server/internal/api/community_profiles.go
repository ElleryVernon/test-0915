package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/store"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/community/profiles/{userId}", httpx.Methods{http.MethodGet: s.withUser(s.communityProfile, store.RoleSTUDENT)})
		mux.Handle("/api/community/profile", httpx.Methods{http.MethodPatch: s.withUser(s.communityPrivacy, store.RoleSTUDENT)})
		mux.Handle("/api/community/following", httpx.Methods{http.MethodGet: s.withUser(s.communityFollowing, store.RoleSTUDENT)})
		mux.Handle("/api/community/cards/{id}", httpx.Methods{http.MethodPatch: s.withUser(s.communityCardPrivacy, store.RoleSTUDENT)})
		mux.Handle("/api/community/cards/{id}/clone", httpx.Methods{http.MethodPost: s.withUser(s.communityPublicCardClone, store.RoleSTUDENT)})
	})
}

type communityVisibility struct {
	Grade             bool       `json:"grade"`
	Subjects          bool       `json:"subjects"`
	FollowerCount     bool       `json:"followerCount"`
	CardsDefault      bool       `json:"cardsDefault"`
	WhoCanFollow      string     `json:"whoCanFollow"`
	NicknameChangedAt *time.Time `json:"nicknameChangedAt,omitempty"`
}

func (s *Server) communityVisibility(ctx context.Context, id string) (communityVisibility, error) {
	out := communityVisibility{Grade: true, Subjects: true, WhoCanFollow: "SAME_GRADE"}
	var raw []byte
	e := s.pool.QueryRow(ctx, `SELECT "visibility" FROM "CommunityPrivacy" WHERE "userId"=$1`, id).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return out, nil
	}
	if e == nil {
		e = json.Unmarshal(raw, &out)
	}
	return out, e
}
func (s *Server) communityPrivacy(w http.ResponseWriter, r *http.Request, u store.User) error {
	var in struct {
		Visibility map[string]any `json:"visibility"`
		Nickname   *string        `json:"nickname"`
	}
	if e := httpx.Decode(r, &in); e != nil {
		return e
	}
	v, e := s.communityVisibility(r.Context(), u.ID)
	if e != nil {
		return e
	}
	for key, value := range in.Visibility {
		switch key {
		case "grade", "subjects", "followerCount", "cardsDefault":
			b, ok := value.(bool)
			if !ok {
				return blockError()
			}
			switch key {
			case "grade":
				v.Grade = b
			case "subjects":
				v.Subjects = b
			case "followerCount":
				v.FollowerCount = b
			case "cardsDefault":
				v.CardsDefault = b
			}
		case "whoCanFollow":
			str := textValue(value)
			if str != "ALL" && str != "SAME_GRADE" && str != "NONE" {
				return blockError()
			}
			v.WhoCanFollow = str
		case "nicknameChangedAt":
			// Server-owned field echoed back inside the visibility document; never client-set.
		default:
			return blockError()
		}
	}
	if in.Nickname != nil {
		nick := strings.TrimSpace(*in.Nickname)
		runes := []rune(nick)
		if len(runes) == 0 || len(runes) > 12 {
			return apierr.New(400, "닉네임은 1~12자로 적어 주세요.")
		}
		if nick != u.Nickname {
			if v.NicknameChangedAt != nil && s.now().Sub(*v.NicknameChangedAt) < 30*24*time.Hour {
				left := v.NicknameChangedAt.Add(30 * 24 * time.Hour).Sub(s.now())
				return apierr.New(429, fmt.Sprintf("닉네임은 30일에 한 번 바꿀 수 있어요. %d일 뒤에 다시 바꿀 수 있어요.", int(math.Ceil(left.Hours()/24))))
			}
			now := s.now()
			v.NicknameChangedAt = &now
			if _, e = s.q.UpdateProfile(r.Context(), store.UpdateProfileParams{ID: u.ID, Nickname: &nick}); e != nil {
				var pgErr *pgconn.PgError
				if errors.As(e, &pgErr) && pgErr.Code == "23505" {
					return apierr.New(409, "이미 사용 중인 닉네임이에요.")
				}
				return e
			}
			s.auth.Invalidate(r.Context(), u.ID)
		}
	}
	_, e = s.pool.Exec(r.Context(), `INSERT INTO "CommunityPrivacy"("userId","visibility") VALUES($1,$2) ON CONFLICT("userId") DO UPDATE SET "visibility"=$2`, u.ID, jsonBytes(v))
	if e == nil {
		httpx.OK(w, 200, map[string]any{"visibility": v})
	}
	return e
}
func (s *Server) communityProfile(w http.ResponseWriter, r *http.Request, u store.User) error {
	ctx := r.Context()
	target := u
	id := r.PathValue("userId")
	if id != u.ID {
		var e error
		target, e = s.peer(ctx, u, id)
		if e != nil {
			return e
		}
	}
	v, e := s.communityVisibility(ctx, target.ID)
	if e != nil {
		return e
	}
	mine := id == u.ID
	if !mine {
		// The cooldown marker is the owner's own editing hint, not profile data.
		v.NicknameChangedAt = nil
	}
	out := map[string]any{"id": id, "nickname": target.Nickname, "joinedAt": target.CreatedAt, "isMine": mine, "visibility": v, "subjects": []string{}, "posts": []PostView{}, "answers": []any{}, "cards": []communityBlock{}}
	if v.Grade || mine {
		out["grade"] = target.Grade
	}
	if v.Subjects || mine {
		rows, e := s.q.ListLiveSubjects(ctx, id)
		if e != nil {
			return e
		}
		names := []string{}
		for _, sub := range rows {
			names = append(names, sub.Name)
		}
		out["subjects"] = names
	}
	var following bool
	var followers, followingCount int
	e = s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "Follow" WHERE "followerId"=$1 AND "followingId"=$2),(SELECT count(*) FROM "Follow" WHERE "followingId"=$2),(SELECT count(*) FROM "Follow" WHERE "followerId"=$2)`, u.ID, id).Scan(&following, &followers, &followingCount)
	if e != nil {
		return e
	}
	out["following"] = following
	out["followingCount"] = followingCount
	if v.FollowerCount || mine {
		out["followers"] = followers
	}
	var accepted, answers, cloned, helped int
	e = s.pool.QueryRow(ctx, `
 WITH public_blocks AS (
 SELECT cp."postId",b->>'id' AS block_id,p."userId" AS author_id FROM "CommunityPost" cp JOIN "Post" p ON p."id"=cp."postId" CROSS JOIN LATERAL jsonb_array_elements(cp."blocks") b WHERE NOT p."anonymous" AND NOT cp."deleted"
 UNION ALL SELECT c."postId",cc."block"->>'id',c."userId" FROM "CommunityComment" cc JOIN "Comment" c ON c."id"=cc."commentId" JOIN "Post" p ON p."id"=c."postId" WHERE NOT (p."anonymous" AND p."userId"=c."userId")
 ), clones AS (
 SELECT a."userId" AS beneficiary FROM "CommunityAction" a JOIN public_blocks b ON b."postId"=a."postId" AND b.block_id=a."blockId" WHERE b.author_id=$1 AND a."kind"='clone' AND a."userId"<>$1
 UNION ALL SELECT cc."userId" FROM "CommunityCardClone" cc JOIN "Card" c ON c."id"=cc."sourceCardId" WHERE c."userId"=$1 AND cc."userId"<>$1
 ), helped AS (SELECT beneficiary FROM clones UNION SELECT p."userId" FROM "CommunityReward" r JOIN "Post" p ON p."id"=r."postId" WHERE r."userId"=$1)
 SELECT (SELECT count(*) FROM "CommunityPost" cp JOIN "Comment" c ON c."id"=cp."acceptedCommentId" JOIN "Post" p ON p."id"=cp."postId" WHERE c."userId"=$1 AND NOT cp."deleted" AND NOT (p."anonymous" AND p."userId"=$1)),
 (SELECT count(*) FROM "Comment" c JOIN "Post" p ON p."id"=c."postId" LEFT JOIN "CommunityPost" cp ON cp."postId"=p."id" WHERE c."userId"=$1 AND NOT COALESCE(cp."deleted",false) AND NOT (p."anonymous" AND p."userId"=$1)),
 (SELECT count(*) FROM clones),(SELECT count(*) FROM helped)`, id).Scan(&accepted, &answers, &cloned, &helped)
	if e != nil {
		return e
	}
	out["stats"] = map[string]int{"accepted": accepted, "answers": answers, "cardsCloned": cloned, "helpedUsers": helped}
	if !mine {
		// The relation line answers "이 사람 답을 믿어도 되나" with the viewer's own history:
		// how many of my questions they answered, how many of those I accepted, how many of
		// their cards I saved. Anonymous posts stay out: the relation must not re-identify them.
		var answersToMe, acceptedForMe, cardsICloned int
		e = s.pool.QueryRow(ctx, `
 WITH target_blocks AS (
 SELECT b->>'id' AS block_id, cp."postId" FROM "CommunityPost" cp JOIN "Post" p ON p."id"=cp."postId" CROSS JOIN LATERAL jsonb_array_elements(cp."blocks") b WHERE p."userId"=$2 AND NOT p."anonymous" AND NOT cp."deleted"
 UNION ALL SELECT cc."block"->>'id', c."postId" FROM "CommunityComment" cc JOIN "Comment" c ON c."id"=cc."commentId" JOIN "Post" p ON p."id"=c."postId" WHERE c."userId"=$2 AND cc."block" IS NOT NULL AND NOT (p."anonymous" AND p."userId"=c."userId")
 )
 SELECT (SELECT count(DISTINCT c."postId") FROM "Comment" c JOIN "Post" p ON p."id"=c."postId" LEFT JOIN "CommunityPost" cp ON cp."postId"=p."id" WHERE c."userId"=$2 AND p."userId"=$1 AND p."role"='STUDENT' AND p."category"='질문' AND NOT p."anonymous" AND NOT COALESCE(cp."deleted",false)),
 (SELECT count(*) FROM "Comment" c JOIN "CommunityPost" cp ON cp."acceptedCommentId"=c."id" JOIN "Post" p ON p."id"=cp."postId" WHERE c."userId"=$2 AND p."userId"=$1 AND NOT p."anonymous" AND NOT cp."deleted"),
 (SELECT count(*) FROM "CommunityAction" a JOIN target_blocks tb ON tb."postId"=a."postId" AND tb.block_id=a."blockId" WHERE a."userId"=$1 AND a."kind"='clone')
 + (SELECT count(*) FROM "CommunityCardClone" cc JOIN "Card" c ON c."id"=cc."sourceCardId" WHERE cc."userId"=$1 AND c."userId"=$2)`,
			u.ID, id).Scan(&answersToMe, &acceptedForMe, &cardsICloned)
		if e != nil {
			return e
		}
		out["relation"] = map[string]int{"answersToMe": answersToMe, "acceptedForMe": acceptedForMe, "cardsICloned": cardsICloned}
	}
	// Select candidates before fetching each authorized view; no anonymous author linkage in public profiles.
	rows, e := s.pool.Query(ctx, `SELECT p."id" FROM "Post" p LEFT JOIN "CommunityPost" cp ON cp."postId"=p."id" WHERE p."userId"=$1 AND NOT p."anonymous" AND NOT COALESCE(cp."deleted",false) ORDER BY p."createdAt" DESC LIMIT 100`, id)
	if e != nil {
		return e
	}
	postIDs := []string{}
	for rows.Next() {
		var pid string
		if e = rows.Scan(&pid); e != nil {
			rows.Close()
			return e
		}
		postIDs = append(postIDs, pid)
	}
	rows.Close()
	posts := []PostView{}
	for _, pid := range postIDs {
		p, e := s.communityPostView(ctx, u, pid)
		if e == nil {
			posts = append(posts, p)
		}
	}
	out["posts"] = posts
	rows, e = s.pool.Query(ctx, `SELECT c."postId",p."title",c."body",COALESCE(cp."acceptedCommentId"=c."id",false) FROM "Comment" c JOIN "Post" p ON p."id"=c."postId" LEFT JOIN "CommunityPost" cp ON cp."postId"=p."id" LEFT JOIN "CommunityComment" cc ON cc."commentId"=c."id" WHERE c."userId"=$1 AND NOT COALESCE(cc."deleted",false) AND NOT(p."anonymous" AND p."userId"=$1) AND NOT COALESCE(cp."deleted",false) ORDER BY c."createdAt" DESC LIMIT 100`, id)
	if e != nil {
		return e
	}
	ans := []map[string]any{}
	for rows.Next() {
		var pid, title, body string
		var yes bool
		if e = rows.Scan(&pid, &title, &body, &yes); e != nil {
			rows.Close()
			return e
		}
		ans = append(ans, map[string]any{"postId": pid, "postTitle": title, "body": body, "accepted": yes})
	}
	rows.Close()
	safe := []map[string]any{}
	for _, a := range ans {
		if _, e = s.accessiblePost(ctx, u, textValue(a["postId"])); e == nil {
			safe = append(safe, a)
		}
	}
	out["answers"] = safe
	cards, e := s.communityProfileCards(ctx, u, target)
	if e != nil {
		return e
	}
	out["cards"] = cards
	httpx.OK(w, 200, out)
	return nil
}
func (s *Server) communityProfileCards(ctx context.Context, viewer, target store.User) ([]communityBlock, error) {
	rows, e := s.pool.Query(ctx, `SELECT c."id",COALESCE(cc."public",false) FROM "Card" c JOIN "Subject" sub ON sub."id"=c."subjectId" LEFT JOIN "CommunityCard" cc ON cc."cardId"=c."id" WHERE c."userId"=$1 AND NOT c."deleted" AND NOT sub."deleted" AND ($2 OR COALESCE(cc."public",false)) ORDER BY c."createdAt" DESC LIMIT 100`, target.ID, viewer.ID == target.ID)
	if e != nil {
		return nil, e
	}
	type row struct {
		id     string
		public bool
	}
	list := []row{}
	for rows.Next() {
		var r row
		if e = rows.Scan(&r.id, &r.public); e != nil {
			rows.Close()
			return nil, e
		}
		list = append(list, r)
	}
	rows.Close()
	out := []communityBlock{}
	for _, r := range list {
		c, e := s.q.GetOwnedLiveCard(ctx, store.GetOwnedLiveCardParams{ID: r.id, UserID: target.ID})
		if e != nil {
			return nil, e
		}
		p := s.cardPayload(ctx, c)
		p["public"] = r.public
		out = append(out, communityBlock{ID: c.ID, RefID: c.ID, Type: "CARD", Payload: p})
	}
	return out, nil
}
func (s *Server) communityCardPrivacy(w http.ResponseWriter, r *http.Request, u store.User) error {
	var in struct {
		Public *bool `json:"public"`
	}
	if e := httpx.Decode(r, &in); e != nil {
		return e
	}
	if in.Public == nil {
		return blockError()
	}
	c, e := s.q.GetOwnedLiveCard(r.Context(), store.GetOwnedLiveCardParams{ID: r.PathValue("id"), UserID: u.ID})
	if e != nil {
		return apierr.New(404, "카드를 찾을 수 없어요.")
	}
	_, e = s.pool.Exec(r.Context(), `INSERT INTO "CommunityCard"("cardId","public") VALUES($1,$2) ON CONFLICT("cardId") DO UPDATE SET "public"=$2`, c.ID, *in.Public)
	if e == nil {
		httpx.OK(w, 200, map[string]any{"id": c.ID, "public": *in.Public})
	}
	return e
}
func (s *Server) communityPublicCardClone(w http.ResponseWriter, r *http.Request, u store.User) error {
	ctx := r.Context()
	var owner string
	e := s.pool.QueryRow(ctx, `SELECT c."userId" FROM "Card" c JOIN "CommunityCard" cc ON cc."cardId"=c."id" WHERE c."id"=$1 AND cc."public" AND NOT c."deleted"`, r.PathValue("id")).Scan(&owner)
	if e != nil {
		return apierr.New(404, "공개 카드를 찾을 수 없어요.")
	}
	if owner != u.ID {
		if _, e = s.peer(ctx, u, owner); e != nil {
			return e
		}
	}
	c, e := s.q.GetOwnedLiveCard(ctx, store.GetOwnedLiveCardParams{ID: r.PathValue("id"), UserID: owner})
	if e != nil {
		return apierr.New(404, "카드를 찾을 수 없어요.")
	}
	b := communityBlock{ID: c.ID, Type: "CARD", Payload: s.cardPayload(ctx, c)}
	var id, subject string
	e = s.locked(ctx, u.ID, func(tx pgx.Tx, q *store.Queries) error {
		err := tx.QueryRow(ctx, `SELECT c."id",c."subjectId" FROM "CommunityCardClone" cc JOIN "Card" c ON c."id"=cc."cardId" WHERE cc."userId"=$1 AND cc."sourceCardId"=$2`, u.ID, c.ID).Scan(&id, &subject)
		if err == nil {
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		id, subject, err = s.cloneBlockCard(ctx, tx, u, b)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO "CommunityCardClone"("userId","sourceCardId","cardId") VALUES($1,$2,$3)`, u.ID, c.ID, id)
		return err
	})
	if e == nil {
		httpx.OK(w, 200, map[string]string{"id": id, "subjectId": subject})
	}
	return e
}
func (s *Server) communityFollowing(w http.ResponseWriter, r *http.Request, u store.User) error {
	posts, _, e := s.postsForFeed(r.Context(), u, store.ListPostsParams{FollowingOnly: true})
	if e != nil {
		return e
	}
	following, e := s.q.ListFollowing(r.Context(), u.ID)
	if e != nil {
		return e
	}
	cards := []map[string]any{}
	for _, f := range following {
		peer, e := s.peer(r.Context(), u, f.ID)
		if e != nil {
			continue
		}
		blocks, e := s.communityProfileCards(r.Context(), u, peer)
		if e != nil {
			return e
		}
		for _, b := range blocks {
			var created time.Time
			_ = s.pool.QueryRow(r.Context(), `SELECT "createdAt" FROM "Card" WHERE "id"=$1`, b.ID).Scan(&created)
			cards = append(cards, map[string]any{"block": b, "authorId": peer.ID, "author": peer.Nickname, "createdAt": created})
		}
	}
	httpx.OK(w, 200, map[string]any{"posts": posts, "cards": cards})
	return nil
}
func (s *Server) communityFollow(w http.ResponseWriter, r *http.Request, u store.User) error {
	if u.Role != store.RoleSTUDENT {
		return apierr.New(403, "학생 프로필에서 팔로우할 수 있어요.")
	}
	var in struct {
		UserID    string `json:"userId"`
		Following *bool  `json:"following"`
	}
	if e := httpx.Decode(r, &in); e != nil {
		return e
	}
	ctx := r.Context()
	peer, e := s.peer(ctx, u, in.UserID)
	if e != nil {
		return e
	}
	v, e := s.communityVisibility(ctx, peer.ID)
	if e != nil {
		return e
	}
	var following bool
	e = s.locked(ctx, u.ID, func(tx pgx.Tx, q *store.Queries) error {
		prior, err := q.HasFollow(ctx, store.HasFollowParams{FollowerID: u.ID, FollowingID: peer.ID})
		if err != nil {
			return err
		}
		following = !prior
		if in.Following != nil {
			following = *in.Following
		}
		if prior == following {
			return nil
		}
		if !following {
			return q.DeleteFollow(ctx, store.DeleteFollowParams{FollowerID: u.ID, FollowingID: peer.ID})
		}
		if v.WhoCanFollow == "NONE" || (v.WhoCanFollow == "SAME_GRADE" && (u.Grade == "" || peer.Grade != u.Grade)) {
			return apierr.New(403, "이 사용자의 팔로우 허용 범위에 해당하지 않아요.")
		}
		limit := 50
		if s.now().Sub(u.CreatedAt) < 7*24*time.Hour {
			limit = 20
		}
		var n int
		err = tx.QueryRow(ctx, `SELECT count(*) FROM "CommunityFollowEvent" WHERE "userId"=$1 AND "createdAt">=now()-interval '24 hours'`, u.ID).Scan(&n)
		if err != nil {
			return err
		}
		if n >= limit {
			return apierr.New(429, "오늘은 팔로우를 충분히 했어요. 내일 다시 시도해 주세요.")
		}
		if err = q.CreateFollow(ctx, store.CreateFollowParams{FollowerID: u.ID, FollowingID: peer.ID}); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO "CommunityFollowEvent"("id","userId") VALUES($1,$2)`, ids.New(), u.ID)
		return err
	})
	if e == nil {
		httpx.OK(w, 200, map[string]bool{"following": following})
	}
	return e
}
