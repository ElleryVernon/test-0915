package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"memoryz/server/internal/auth"
	"memoryz/server/internal/blob"
	"memoryz/server/internal/cache"
	"memoryz/server/internal/config"
	"memoryz/server/internal/db"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/testenv"
)

// queryCounter counts every statement the pool executes.
type queryCounter struct{ n atomic.Int64 }

func (c *queryCounter) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	c.n.Add(1)
	return ctx
}
func (c *queryCounter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// maxBootstrapQueries is the fixed statement budget of one bootstrap, whatever the data size.
const maxBootstrapQueries = 14

// TestBootstrapQueryCount proves bootstrap has no N+1: a student with 50 cards, 20 materials and
// 200 attempts costs the same number of statements as an empty one, and so does a linked parent.
func TestBootstrapQueryCount(t *testing.T) {
	ctx := context.Background()
	scratch := testenv.Scratch(t, testenv.DatabaseURL(t))
	counter := &queryCounter{}
	cfg, err := pgxpool.ParseConfig(scratch)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.Tracer = counter
	cfg.MaxConns = 6
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := db.Migrate(ctx, pool, slog.Default()); err != nil {
		t.Fatal(err)
	}
	conf := &config.Config{Env: config.Development, AppURL: "http://127.0.0.1:8080", AuthSecret: strings.Repeat("s", 40), PDFWorkers: 1, OpenRouterProviderOrder: []string{"openai/fast"}}
	mem := cache.NewMemory()
	defer mem.Close()
	a := auth.New(conf, pool, mem)
	s := New(conf, pool, mem, a, blob.NewPG(pool), slog.Default())

	seedUser := func(id, role string) {
		if _, err := pool.Exec(ctx, `INSERT INTO "User" ("id", "name", "nickname", "role") VALUES ($1, $1, $1, $2)`, id, role); err != nil {
			t.Fatal(err)
		}
	}
	populate := func(userID string, cards, materials, attempts int) {
		subjectID := ids.New()
		if _, err := pool.Exec(ctx, `INSERT INTO "Subject" ("id", "userId", "name") VALUES ($1, $2, '과목')`, subjectID, userID); err != nil {
			t.Fatal(err)
		}
		materialID := ""
		for i := 0; i < materials; i++ {
			materialID = ids.New()
			if _, err := pool.Exec(ctx, `INSERT INTO "Material" ("id", "userId", "subjectId", "title", "content") VALUES ($1, $2, $3, $4, $5)`, materialID, userID, subjectID, fmt.Sprintf("자료 %d", i), strings.Repeat("본문 ", 200)); err != nil {
				t.Fatal(err)
			}
		}
		questionID := ids.New()
		if _, err := pool.Exec(ctx, `INSERT INTO "Question" ("id", "userId", "subjectId", "materialId", "prompt", "options", "answer", "explanation", "citation", "past", "future") VALUES ($1, $2, $3, $4, '문제', ARRAY['a','b','c','d','e'], 0, '설명', '인용 문장입니다.', '과거', '미래')`, questionID, userID, subjectID, materialID); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < cards; i++ {
			cardID := ids.New()
			if _, err := pool.Exec(ctx, `INSERT INTO "Card" ("id", "userId", "subjectId", "front", "back") VALUES ($1, $2, $3, '앞', '뒤')`, cardID, userID, subjectID); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `INSERT INTO "CardReview" ("id", "userId", "cardId", "rating", "result", "createdAt") VALUES ($1, $2, $3, 'GOOD', '{}', $4)`, ids.New(), userID, cardID, time.Now().UTC().Add(-time.Duration(i)*time.Hour)); err != nil {
				t.Fatal(err)
			}
		}
		for i := 0; i < attempts; i++ {
			if _, err := pool.Exec(ctx, `INSERT INTO "Attempt" ("id", "userId", "questionId", "answer", "correct", "score", "createdAt") VALUES ($1, $2, $3, '0', $4, 0, $5)`, ids.New(), userID, questionID, i%2 == 0, time.Now().UTC().Add(-time.Duration(i)*time.Minute)); err != nil {
				t.Fatal(err)
			}
		}
	}
	small, big, parent := "qa-boot-small-"+ids.Token(3), "qa-boot-big-"+ids.Token(3), "qa-boot-parent-"+ids.Token(3)
	seedUser(small, "STUDENT")
	seedUser(big, "STUDENT")
	seedUser(parent, "PARENT")
	populate(small, 1, 1, 1)
	populate(big, 50, 20, 200)
	if _, err := pool.Exec(ctx, `INSERT INTO "ParentLink" ("parentId", "studentId") VALUES ($1, $2)`, parent, big); err != nil {
		t.Fatal(err)
	}

	handler := s.withUser(s.bootstrap)
	run := func(userID string) (int64, int) {
		cookie, _, err := a.Create(ctx, userID)
		if err != nil {
			t.Fatal(err)
		}
		token := strings.TrimPrefix(strings.Split(cookie, ";")[0], auth.CookieName+"=")
		// Warm the session cache so only bootstrap's own statements are counted.
		warm := httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil)
		warm.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
		handler.ServeHTTP(httptest.NewRecorder(), warm)
		before := counter.n.Load()
		req := httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil)
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("bootstrap %s: %d %s", userID, rec.Code, rec.Body.String())
		}
		return counter.n.Load() - before, rec.Body.Len()
	}
	smallQueries, _ := run(small)
	bigQueries, bigBytes := run(big)
	parentQueries, _ := run(parent)
	if smallQueries != bigQueries {
		t.Fatalf("statement count depends on data size: %d vs %d", smallQueries, bigQueries)
	}
	if bigQueries > maxBootstrapQueries || parentQueries > maxBootstrapQueries {
		t.Fatalf("too many statements: student %d, parent %d (max %d)", bigQueries, parentQueries, maxBootstrapQueries)
	}
	t.Logf("BOOTSTRAP_QUERIES student=%d parent=%d (max %d) payload=%dB", bigQueries, parentQueries, maxBootstrapQueries, bigBytes)
}
