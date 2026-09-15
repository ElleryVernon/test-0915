package api

import (
	"net/http"
	"strconv"
	"time"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/auth"
	"memoryz/server/internal/demo"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ratelimit"
	"memoryz/server/internal/store"
	"memoryz/server/internal/telemetry"
)

var (
	errDemoOff      = apierr.New(403, "데모 로그인이 비활성화되어 있어요. 소셜 로그인을 이용해 주세요.")
	errDemoAdminOff = apierr.New(403, "관리자 데모 로그인이 비활성화되어 있어요.")
	errInput        = apierr.New(400, "입력값을 확인해 주세요.")
)

// sessionLimit caps sign-ins per address. Two classes behind one school NAT make about 50 sign-ins
// in 10 s at the bell; doubling that for double taps and role switches and adding 20% gives 120, so
// an ordinary bell never meets the window edge and only abuse does.
// jitter: retry-after rest of the window + U[0,15 s) from ratelimit.Check; limit sized above the bell [site server/internal/api/auth_handlers.go:37]
const (
	sessionLimit  = 120
	sessionWindow = time.Minute
)

func (s *Server) configHandler(w http.ResponseWriter, r *http.Request) error {
	httpx.OK(w, http.StatusOK, struct {
		Demo      bool     `json:"demo"`
		Providers []string `json:"providers"`
	}{Demo: s.cfg.DemoMode, Providers: s.cfg.ConfiguredProviders()})
	return nil
}

// demoLogin seeds the sample accounts on first use and signs the caller in as one of them.
func (s *Server) demoLogin(w http.ResponseWriter, r *http.Request) error {
	if err := ratelimit.Check(r.Context(), s.cache, "session:"+clientIP(r, s.cfg), sessionLimit, sessionWindow); err != nil {
		return err
	}
	if !s.cfg.DemoMode {
		return errDemoOff
	}
	var input struct {
		Role string `json:"role"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		return err
	}
	var userID string
	switch input.Role {
	case "STUDENT":
		userID = demo.Student
	case "PARENT":
		userID = demo.Parent
	case "ADMIN":
		if !s.cfg.DemoAdmin {
			return errDemoAdminOff
		}
		userID = demo.Admin
	default:
		return errInput
	}
	if err := demo.Seed(r.Context(), s.pool, s.now()); err != nil {
		return err
	}
	user, err := s.q.GetUser(r.Context(), userID)
	if err != nil {
		return err
	}
	if user.Suspended {
		return apierr.ErrSuspended
	}
	if err := s.auth.Delete(r.Context(), auth.ReadToken(r)); err != nil {
		return err
	}
	cookie, hint, err := s.auth.Create(r.Context(), userID)
	if err != nil {
		return err
	}
	w.Header().Add("Set-Cookie", cookie)
	w.Header().Add("Set-Cookie", hint)
	httpx.OK(w, http.StatusOK, profileOf(user))
	return nil
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) error {
	if err := s.auth.Delete(r.Context(), auth.ReadToken(r)); err != nil {
		return err
	}
	w.Header().Add("Set-Cookie", s.auth.ClearCookie())
	w.Header().Add("Set-Cookie", s.auth.ClearHintCookie())
	httpx.OK(w, http.StatusOK, map[string]bool{"loggedOut": true})
	return nil
}

func (s *Server) me(w http.ResponseWriter, r *http.Request, user store.User) error {
	httpx.OK(w, http.StatusOK, profileOf(user))
	return nil
}

// oauthStart is a top-level navigation, not a fetch: a refusal goes back to the sign-in screen with
// the drawn wait in the URL (loginError=busy&retryAfter=<s>), where the buttons count it down.
func (s *Server) oauthStart(w http.ResponseWriter, r *http.Request) error {
	if err := ratelimit.Check(r.Context(), s.cache, "session:"+clientIP(r, s.cfg), sessionLimit, sessionWindow); err != nil {
		e, ok := apierr.From(err)
		wait, hinted := time.Duration(0), false
		if ok {
			wait, hinted = httpx.RetryAfter(e, s.rand)
		}
		if !hinted {
			return err
		}
		telemetry.RetryAfter(r.Context(), e.Status, wait)
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, s.cfg.AppURL+"/?loginError=busy&retryAfter="+strconv.FormatInt(int64((wait+time.Second-1)/time.Second), 10), http.StatusSeeOther)
		return nil
	}
	return s.auth.OAuthStart(w, r, r.PathValue("provider"))
}

func (s *Server) oauthCallback(w http.ResponseWriter, r *http.Request) error {
	return s.auth.OAuthCallback(w, r, r.PathValue("provider"))
}
