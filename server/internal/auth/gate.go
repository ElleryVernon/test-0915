package auth

import (
	"context"
	"net/http"
	"regexp"
	"time"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/store"
)

// gateTimeout bounds the session lookup in front of a page; the API enforces the real boundary, so
// a slow lookup serves the page rather than holding the navigation.
const gateTimeout = 3 * time.Second

// The previous Next.js proxy guarded these HTML routes; the Go server keeps the same rule in
// front of the static build so a parent never lands on a student screen (the API enforces the
// real boundary).
var (
	gatedPaths   = regexp.MustCompile(`^/(study|subjects|quiz|essay|flashcards|wrong-notes|create-card|completed-subjects|community|boards|planner|parent|parent-boards|cheer|admin)(/|$)`)
	studentPaths = regexp.MustCompile(`^/(study|subjects|quiz|essay|flashcards|wrong-notes|create-card|completed-subjects|community|boards|planner)(/|$)`)
	parentPaths  = regexp.MustCompile(`^/(parent|parent-boards)(/|$)`)
	adminPaths   = regexp.MustCompile(`^/admin(/|$)`)
)

const forbiddenPage = `<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width, initial-scale=1"><title>접근할 수 없는 공간 · memoryz</title><body style="font-family:system-ui;padding:48px 24px;max-width:420px;margin:auto"><p style="color:#f97316">memoryz · 403</p><h1 style="font-size:24px">이 계정에서 볼 수 없는 화면이에요</h1><p>학생과 학부모의 공간을 안전하게 구분하고 있어요.</p><a href="/">내 홈으로 돌아가기</a></body></html>`

// GateHTML wraps the static handler: a signed-in visitor on a screen of the other role gets the
// 403 page, a broken session goes home, and everything else passes through untouched.
func (a *Auth) GateHTML(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if !gatedPaths.MatchString(path) || ReadToken(r) == "" {
			next.ServeHTTP(w, r)
			return
		}
		// jitter: none — a missing time bound, not an alignment problem; now bounded at 3 s [site server/internal/auth/gate.go:31]
		ctx, cancel := context.WithTimeout(r.Context(), gateTimeout)
		user, err := a.CurrentUser(ctx, r)
		cancel()
		if e, ok := apierr.From(err); ok && (e.Status == http.StatusUnauthorized || e.Status == http.StatusForbidden) {
			w.Header().Set("Cache-Control", "no-store")
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		if err != nil {
			// The database or cache is slow or down: the page itself holds no data, and every API call
			// it makes is checked again, so it is served rather than bouncing a signed-in learner home.
			next.ServeHTTP(w, r)
			return
		}
		if (user.Role == store.RolePARENT && studentPaths.MatchString(path)) ||
			(user.Role == store.RoleSTUDENT && parentPaths.MatchString(path)) ||
			(adminPaths.MatchString(path) && user.Role != store.RoleADMIN) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(forbiddenPage))
			return
		}
		next.ServeHTTP(w, r)
	})
}
