package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sync/errgroup"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/jsonx"
	"memoryz/server/internal/planner"
	"memoryz/server/internal/store"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/bootstrap", httpx.Methods{http.MethodGet: s.withUser(s.bootstrap)})
	})
}

var seoul = func() *time.Location {
	loc, err := time.LoadLocation("Asia/Seoul")
	if err != nil {
		panic(err)
	}
	return loc
}()

// dateKey is the Seoul calendar date, the representation Schedule.date and streaks use.
func dateKey(t time.Time) string { return t.In(seoul).Format("2006-01-02") }

type subjectView struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Icon          string  `json:"icon"`
	Semester      string  `json:"semester"`
	Color         string  `json:"color"`
	MaterialCount int32   `json:"materialCount"`
	QuestionCount int32   `json:"questionCount"`
	CardCount     int32   `json:"cardCount"`
	ExamDate      *string `json:"examDate,omitempty"`
	ExamName      *string `json:"examName,omitempty"`
}

// materialView is a material in the bootstrap payload: the row without its body, plus the file's
// page count, the image count and a bounded excerpt with the text's length and hash. Screens that
// need the text fetch GET /api/materials/{id}.
type materialView struct {
	ID            string     `json:"id"`
	UserID        string     `json:"userId"`
	SubjectID     string     `json:"subjectId"`
	Title         string     `json:"title"`
	Type          string     `json:"type"`
	URL           *string    `json:"url,omitempty"`
	UploadID      *string    `json:"uploadId,omitempty"`
	PageBreaks    []int32    `json:"pageBreaks"`
	Extraction    *string    `json:"extraction,omitempty"`
	Pages         *int32     `json:"pages,omitempty"`
	ImageCount    int32      `json:"imageCount"`
	CreatedAt     jsonx.Time `json:"createdAt"`
	ContentLength int        `json:"contentLength"`
	Excerpt       string     `json:"excerpt"`
	ContentHash   string     `json:"contentHash"`
}

type scheduleView struct {
	ID        string     `json:"id"`
	UserID    string     `json:"userId"`
	Title     string     `json:"title"`
	Date      string     `json:"date"`
	Start     string     `json:"start"`
	End       string     `json:"end"`
	Kind      string     `json:"kind"`
	SubjectID *string    `json:"subjectId,omitempty"`
	Done      bool       `json:"done"`
	CreatedAt jsonx.Time `json:"createdAt"`
}

type cheerView struct {
	ID          string     `json:"id"`
	SenderID    string     `json:"senderId"`
	RecipientID string     `json:"recipientId"`
	Message     string     `json:"message"`
	Points      int32      `json:"points"`
	Thanked     bool       `json:"thanked"`
	CreatedAt   jsonx.Time `json:"createdAt"`
	SenderName  string     `json:"senderName"`
}

type notificationView struct {
	ID        string     `json:"id"`
	UserID    string     `json:"userId"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	Read      bool       `json:"read"`
	Href      string     `json:"href"`
	CreatedAt jsonx.Time `json:"createdAt"`
}

type statsView struct {
	YesterdayCards int   `json:"yesterdayCards"`
	TodayCards     int   `json:"todayCards"`
	TodayQuestions int   `json:"todayQuestions"`
	Accuracy       int   `json:"accuracy"`
	StudyMinutes   int   `json:"studyMinutes"`
	Weekly         []int `json:"weekly"`
}

type appData struct {
	Profile       Profile            `json:"profile"`
	Child         *Profile           `json:"child,omitempty"`
	Subjects      []subjectView      `json:"subjects"`
	Materials     []materialView     `json:"materials"`
	Questions     []questionRow      `json:"questions"`
	Essays        []essayRow         `json:"essays"`
	Cards         []cardView         `json:"cards"`
	Attempts      []attemptView      `json:"attempts"`
	Schedules     []scheduleView     `json:"schedules"`
	Posts         []PostView         `json:"posts"`
	Cheers        []cheerView        `json:"cheers"`
	Notifications []notificationView `json:"notifications"`
	Stats         statsView          `json:"stats"`
	AIAvailable   bool               `json:"aiAvailable"`
	Demo          bool               `json:"demo"`
}

func jsRound(v float64) int { return int(math.Floor(v + 0.5)) }

// bootstrap is the whole screen state in one round trip: the learner's data (a parent sees the
// selected child's, filtered by that child's privacy settings), the caller's social data and the
// day's statistics. Independent queries run concurrently.
func (s *Server) bootstrap(w http.ResponseWriter, r *http.Request, user store.User) error {
	ctx := r.Context()
	now := s.now()
	parent := user.Role == store.RolePARENT
	var child *store.User
	if parent {
		linked, err := s.selectedChild(ctx, user)
		if err != nil {
			return err
		}
		child = linked
	}
	var learner *store.User
	if !parent {
		learner = &user
	} else {
		learner = child
	}
	userID := "no-linked-student"
	if learner != nil {
		userID = learner.ID
	}
	// The payload is a pure function of the caller's rows, the learner's rows and the Seoul date,
	// so its key is those two accounts' cache versions plus the date; any write to either account
	// moves its version (see withUser) and the next read misses.
	// jitter: none — the date in the key must roll at 00:00 KST; refills follow requests, few users then, sweep at 04:00 [site server/internal/api/bootstrap.go:163]
	cacheKey := "boot:" + user.ID + ":" + userID + ":" + dateKey(now) + ":" + s.version(ctx, user.ID) + ":" + s.version(ctx, userID)
	// The build runs once per key for everyone asking at the same time (fill), on the fill's context.
	build := func(ctx context.Context) ([]byte, error) {
		var (
			subjects      []store.ListSubjectsWithCountsRow
			materials     []store.ListMaterialsWithUploadRow
			questions     []store.Question
			essays        []store.Essay
			cards         []store.ListCardsWithReviewCountRow
			attempts      []store.Attempt
			schedules     []store.Schedule
			posts         []PostView
			cheersSent    []store.ListCheersSentRow
			cheersGot     []store.ListCheersReceivedRow
			notifications []store.Notification
			reviews       []time.Time
			studied       []string
		)
		g, gctx := errgroup.WithContext(ctx)
		// Up to four queries at once: enough to overlap round trips without one request draining the pool.
		g.SetLimit(4)
		run := func(fn func() error) { g.Go(fn) }
		run(func() (err error) { subjects, err = s.q.ListSubjectsWithCounts(gctx, userID); return })
		run(func() (err error) { materials, err = s.q.ListMaterialsWithUpload(gctx, userID); return })
		run(func() (err error) { questions, err = s.q.ListQuestions(gctx, userID); return })
		run(func() (err error) { essays, err = s.q.ListEssays(gctx, userID); return })
		run(func() (err error) { cards, err = s.q.ListCardsWithReviewCount(gctx, userID); return })
		run(func() (err error) { attempts, err = s.q.ListAttempts(gctx, userID); return })
		run(func() (err error) { schedules, err = s.q.ListSchedules(gctx, userID); return })
		run(func() (err error) { posts, _, err = s.postsFor(gctx, user, false); return })
		if parent {
			run(func() (err error) { cheersSent, err = s.q.ListCheersSent(gctx, user.ID); return })
		} else {
			run(func() (err error) { cheersGot, err = s.q.ListCheersReceived(gctx, user.ID); return })
		}
		run(func() (err error) { notifications, err = s.q.ListNotifications(gctx, user.ID); return })
		run(func() (err error) {
			reviews, err = s.q.ListRecentCardReviews(gctx, store.ListRecentCardReviewsParams{UserID: userID, CreatedAt: now.Add(-7 * 24 * time.Hour)})
			return
		})
		run(func() (err error) { studied, err = s.q.StudiedDays(gctx, userID); return })
		if err := g.Wait(); err != nil {
			return nil, err
		}

		today := dateKey(now)
		privacy := Privacy{}
		if learner != nil {
			privacy = privacyOf(learner.Privacy)
		}
		mayAccuracy := !parent || privacy.Accuracy
		mayNotes := !parent || (privacy.WrongNotes && privacy.Accuracy)
		mayTime := !parent || privacy.Time

		days := map[string]bool{}
		for _, day := range studied {
			days[day] = true
		}
		streak := 0
		start := 1
		if days[today] {
			start = 0
		}
		for offset := start; days[dateKey(now.Add(-time.Duration(offset)*24*time.Hour))]; offset++ {
			streak++
		}
		wrongIDs := map[string]bool{}
		todayQuestions := 0
		correct := 0
		for _, a := range attempts {
			if !a.Correct && a.QuestionID != nil {
				wrongIDs[*a.QuestionID] = true
			}
			if a.Correct {
				correct++
			}
			if a.QuestionID != nil && dateKey(a.CreatedAt) == today {
				todayQuestions++
			}
		}
		weekly := make([]int, 7)
		for index := range weekly {
			date := dateKey(now.Add(-time.Duration(6-index) * 24 * time.Hour))
			for _, a := range attempts {
				if dateKey(a.CreatedAt) == date {
					weekly[index]++
				}
			}
			for _, t := range reviews {
				if dateKey(t) == date {
					weekly[index]++
				}
			}
		}

		out := appData{
			Profile: profileOf(user), Subjects: []subjectView{}, Materials: []materialView{}, Questions: []questionRow{}, Essays: []essayRow{},
			Cards: []cardView{}, Attempts: []attemptView{}, Schedules: []scheduleView{}, Posts: posts, Cheers: []cheerView{}, Notifications: []notificationView{},
			AIAvailable: s.ai.Available(), Demo: s.cfg.DemoMode,
		}
		if out.Posts == nil {
			out.Posts = []PostView{}
		}
		if user.Role == store.RoleSTUDENT {
			out.Profile.Streak = int32(streak)
		}
		if child != nil {
			profile := profileOf(*child)
			profile.Streak = 0
			if mayTime {
				profile.Streak = int32(streak)
			}
			out.Child = &profile
		}
		for _, sub := range subjects {
			view := subjectView{ID: sub.ID, Name: sub.Name, Icon: sub.Icon, Semester: sub.Semester, Color: sub.Color, MaterialCount: sub.MaterialCount, QuestionCount: sub.QuestionCount, CardCount: sub.CardCount}
			if sub.ExamDate != nil {
				view.ExamDate = sub.ExamDate
				name := "시험"
				if sub.ExamName != nil {
					name = *sub.ExamName
				}
				view.ExamName = &name
			}
			out.Subjects = append(out.Subjects, view)
		}
		if !parent {
			for _, m := range materials {
				breaks := m.PageBreaks
				if breaks == nil {
					breaks = []int32{}
				}
				out.Materials = append(out.Materials, materialView{
					ID: m.ID, UserID: m.UserID, SubjectID: m.SubjectID, Title: m.Title, Type: m.Type, URL: m.Url, UploadID: m.UploadID, PageBreaks: breaks,
					Extraction: m.Extraction, Pages: m.UploadPages, ImageCount: m.ImageCount, CreatedAt: jsonx.Time(m.CreatedAt),
					ContentLength: length(strings.TrimSpace(m.Content)), Excerpt: m.Excerpt, ContentHash: m.ContentHash,
				})
			}
		}
		if mayNotes {
			savedQuestions := map[string]string{}
			if !parent {
				rows, err := s.pool.Query(ctx, `SELECT "questionId","postId" FROM "CommunitySavedQuestion" WHERE "userId"=$1`, userID)
				if err != nil {
					return nil, err
				}
				for rows.Next() {
					var questionID, postID string
					if err = rows.Scan(&questionID, &postID); err != nil {
						rows.Close()
						return nil, err
					}
					savedQuestions[questionID] = postID
				}
				err = rows.Err()
				rows.Close()
				if err != nil {
					return nil, err
				}
			}
			for _, q := range questions {
				if parent && !wrongIDs[q.ID] {
					continue
				}
				view := questionOf(q)

				if postID, ok := savedQuestions[q.ID]; ok {
					view.SavedToNotes = true
					view.CommunityPostID = postID
				}
				out.Questions = append(out.Questions, view)
			}
			for _, a := range attempts {
				out.Attempts = append(out.Attempts, attemptView{ResponseMs: a.ResponseMs, BeatsSeen: a.BeatsSeen, ExplainDepth: a.ExplainDepth, MicroResult: a.MicroResult, DivergenceNodeID: a.DivergenceNodeId, ID: a.ID, UserID: a.UserID, QuestionID: a.QuestionID, EssayID: a.EssayID, Answer: a.Answer, Correct: a.Correct, Score: a.Score, CreatedAt: jsonx.Time(a.CreatedAt)})
			}
		}
		if !parent {
			for _, e := range essays {
				out.Essays = append(out.Essays, essayOf(e))
			}
			for _, c := range cards {
				count := c.ReviewCount
				out.Cards = append(out.Cards, cardOf(store.Card{
					Diagram: c.Diagram, MaskedNodeIds: c.MaskedNodeIds, SourceDiagramId: c.SourceDiagramId, MaterialID: c.MaterialID, ID: c.ID, UserID: c.UserID, SubjectID: c.SubjectID, Front: c.Front, Back: c.Back, Type: c.Type, Bucket: c.Bucket, ConsecutiveEasy: c.ConsecutiveEasy,
					NextReviewAt: c.NextReviewAt, Deleted: c.Deleted, Image: c.Image, Masks: c.Masks, SourceQuestionID: c.SourceQuestionID, Fsrs: c.Fsrs, CreatedAt: c.CreatedAt,
				}, &count))
			}
		}
		studyMinutes := 0
		if mayTime {
			for _, sch := range schedules {
				out.Schedules = append(out.Schedules, scheduleView{ID: sch.ID, UserID: sch.UserID, Title: sch.Title, Date: sch.Date, Start: sch.Start, End: sch.End, Kind: string(sch.Kind), SubjectID: sch.SubjectID, Done: sch.Done, CreatedAt: jsonx.Time(sch.CreatedAt)})
				if sch.Date == today && sch.Done {
					studyMinutes += planner.Minutes(sch.End) - planner.Minutes(sch.Start)
				}
			}
		}
		for _, c := range cheersSent {
			out.Cheers = append(out.Cheers, cheerView{ID: c.ID, SenderID: c.SenderID, RecipientID: c.RecipientID, Message: c.Message, Points: c.Points, Thanked: c.Thanked, CreatedAt: jsonx.Time(c.CreatedAt), SenderName: c.SenderName})
		}
		for _, c := range cheersGot {
			out.Cheers = append(out.Cheers, cheerView{ID: c.ID, SenderID: c.SenderID, RecipientID: c.RecipientID, Message: c.Message, Points: c.Points, Thanked: c.Thanked, CreatedAt: jsonx.Time(c.CreatedAt), SenderName: c.SenderName})
		}
		for _, n := range notifications {
			out.Notifications = append(out.Notifications, notificationView{ID: n.ID, UserID: n.UserID, Title: n.Title, Body: n.Body, Read: n.Read, Href: n.Href, CreatedAt: jsonx.Time(n.CreatedAt)})
		}
		yesterday := dateKey(now.Add(-24 * time.Hour))
		todayCards, yesterdayCards := 0, 0
		for _, t := range reviews {
			switch dateKey(t) {
			case today:
				todayCards++
			case yesterday:
				yesterdayCards++
			}
		}
		accuracy := 0
		if mayAccuracy && len(attempts) > 0 {
			accuracy = jsRound(float64(correct) / float64(len(attempts)) * 100)
		}
		out.Stats = statsView{TodayCards: todayCards, TodayQuestions: todayQuestions, Accuracy: accuracy, StudyMinutes: studyMinutes, Weekly: []int{}}
		if mayTime {
			out.Stats.YesterdayCards = yesterdayCards
			out.Stats.Weekly = weekly
		}

		body, err := json.Marshal(map[string]any{"data": out})
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(body)
		etag := `"` + hex.EncodeToString(sum[:16]) + `"`
		// One entry holds the ETag and the body, so a conditional request is answered from the cache alone.
		entry := make([]byte, 0, etagLength+len(body))
		return append(append(entry, etag...), body...), nil
	}
	entry, state, err := s.fill(ctx, "bootstrap", cacheKey, bootstrapTTL, build)
	if err != nil {
		return err
	}
	if len(entry) <= etagLength {
		return apierr.ErrInternal
	}
	writeBootstrap(w, r, string(entry[:etagLength]), entry[etagLength:], state)
	return nil
}

// etagLength is len(`"` + 32 hex characters + `"`).
const etagLength = 34

func writeBootstrap(w http.ResponseWriter, r *http.Request, etag string, body []byte, cacheState string) {
	h := w.Header()
	h.Set("ETag", etag)
	h.Set("Cache-Control", "private, no-cache")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Cache", cacheState)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
