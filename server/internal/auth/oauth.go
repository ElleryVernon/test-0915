package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/jackc/pgx/v5"
	"golang.org/x/oauth2"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/db"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/logx"
	"memoryz/server/internal/store"
)

// Provider describes one social login. Google and Apple are OpenID Connect (the id_token is
// verified against the issuer's keys and the nonce we sent); Kakao and Naver are plain OAuth2 with
// a userinfo call, as they were in the previous server.
type Provider struct {
	Authorize string
	Token     string
	UserInfo  string
	Scope     string
	Issuer    string // OIDC issuer, when the provider returns an id_token
	FormPost  bool   // Apple posts the callback as a form
	PKCE      bool
}

// Providers is the table the flows use; tests point it at a local fake issuer.
var Providers = map[string]*Provider{
	"google": {
		Authorize: "https://accounts.google.com/o/oauth2/v2/auth",
		Token:     "https://oauth2.googleapis.com/token",
		UserInfo:  "https://openidconnect.googleapis.com/v1/userinfo",
		Scope:     "openid profile",
		Issuer:    "https://accounts.google.com",
		PKCE:      true,
	},
	"kakao": {
		Authorize: "https://kauth.kakao.com/oauth/authorize",
		Token:     "https://kauth.kakao.com/oauth/token",
		UserInfo:  "https://kapi.kakao.com/v2/user/me",
		Scope:     "profile_nickname",
	},
	"naver": {
		Authorize: "https://nid.naver.com/oauth2.0/authorize",
		Token:     "https://nid.naver.com/oauth2.0/token",
		UserInfo:  "https://openapi.naver.com/v1/nid/me",
	},
	"apple": {
		Authorize: "https://appleid.apple.com/auth/authorize",
		Token:     "https://appleid.apple.com/auth/token",
		Scope:     "name",
		Issuer:    "https://appleid.apple.com",
		FormPost:  true,
	},
}

// jitter: none — stateLifetime runs 10 min from each sign-in's own start (cookie Max-Age and signed expiry), so nothing expires together [site server/internal/auth/oauth.go:74]
const (
	stateCookie   = "memoryz_oauth"
	stateLifetime = 10 * time.Minute
	defaultName   = "새로운 기억"
)

// ErrProviderOff is the answer for a login the operator has not configured: a configuration state,
// so it carries the code PROVIDER_OFF and no retry hint.
// jitter: none — a configuration state; code PROVIDER_OFF and no hint [site server/internal/auth/oauth.go:79]
var ErrProviderOff = apierr.WithCode(503, "이 로그인 서비스가 아직 연결되지 않았어요.", "PROVIDER_OFF")

// ErrBadStep is the answer for an unknown auth path.
var ErrBadStep = apierr.New(404, "잘못된 로그인 경로예요.")

type loginState struct {
	State    string `json:"state"`
	Verifier string `json:"verifier"`
	Nonce    string `json:"nonce"`
	Role     string `json:"role"`
	Provider string `json:"provider"`
	Expires  int64  `json:"expires"`
}

func (a *Auth) sign(text string) string {
	mac := hmac.New(sha256.New, []byte(a.cfg.AuthSecret))
	mac.Write([]byte(text))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (a *Auth) pack(s loginState) string {
	raw, _ := json.Marshal(s)
	text := base64.RawURLEncoding.EncodeToString(raw)
	return text + "." + a.sign(text)
}

func (a *Auth) unpack(value string) (loginState, bool) {
	text, signature, ok := strings.Cut(value, ".")
	if !ok || text == "" {
		return loginState{}, false
	}
	if !hmac.Equal([]byte(a.sign(text)), []byte(signature)) {
		return loginState{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(text)
	if err != nil {
		return loginState{}, false
	}
	var s loginState
	if json.Unmarshal(raw, &s) != nil || s.Expires <= a.now().UnixMilli() {
		return loginState{}, false
	}
	return s, true
}

func (a *Auth) transientCookie(value, provider string, clear bool) string {
	sameSite := "Lax"
	secure := ""
	if a.cfg.Secure() {
		secure = "; Secure"
		if provider == "apple" {
			sameSite = "None" // Apple's form_post arrives cross-site
		}
	}
	maxAge := int(stateLifetime.Seconds())
	if clear {
		maxAge = 0
	}
	return fmt.Sprintf("%s=%s; Path=/api/auth; HttpOnly; SameSite=%s; Max-Age=%d%s", stateCookie, value, sameSite, maxAge, secure)
}

func (a *Auth) provider(name string) (*Provider, error) {
	spec, ok := Providers[name]
	if !ok {
		return nil, ErrProviderOff
	}
	if _, configured := a.cfg.OAuth[name]; !configured {
		return nil, ErrProviderOff
	}
	return spec, nil
}

func (a *Auth) oauthConfig(name string, spec *Provider) *oauth2.Config {
	client := a.cfg.OAuth[name]
	var scopes []string
	if spec.Scope != "" {
		scopes = strings.Fields(spec.Scope)
	}
	return &oauth2.Config{
		ClientID:     client.ID,
		ClientSecret: client.Secret,
		Endpoint:     oauth2.Endpoint{AuthURL: spec.Authorize, TokenURL: spec.Token, AuthStyle: oauth2.AuthStyleInParams},
		RedirectURL:  a.cfg.AppURL + "/api/auth/" + name + "/callback",
		Scopes:       scopes,
	}
}

// OAuthStart sends the browser to the provider with a signed, short-lived state cookie.
func (a *Auth) OAuthStart(w http.ResponseWriter, r *http.Request, name string) error {
	spec, err := a.provider(name)
	if err != nil {
		return err
	}
	role := "STUDENT"
	if r.URL.Query().Get("role") == "PARENT" {
		role = "PARENT"
	}
	state := loginState{
		State:    base64.RawURLEncoding.EncodeToString([]byte(ids.Token(32))[:43]),
		Verifier: oauth2.GenerateVerifier(),
		Nonce:    ids.Token(24),
		Role:     role,
		Provider: name,
		Expires:  a.now().Add(stateLifetime).UnixMilli(),
	}
	conf := a.oauthConfig(name, spec)
	opts := []oauth2.AuthCodeOption{}
	if spec.PKCE {
		opts = append(opts, oauth2.S256ChallengeOption(state.Verifier))
	}
	if spec.Issuer != "" {
		opts = append(opts, oauth2.SetAuthURLParam("nonce", state.Nonce))
	}
	if spec.FormPost {
		opts = append(opts, oauth2.SetAuthURLParam("response_mode", "form_post"))
	}
	w.Header().Add("Set-Cookie", a.transientCookie(a.pack(state), name, false))
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, conf.AuthCodeURL(state.State, opts...), http.StatusFound)
	return nil
}

// identity is what a provider tells us about the signed-in person.
type identity struct {
	providerID string
	name       string
}

// OAuthCallback finishes the login: on success the session cookie is set and the browser goes to
// onboarding (new account) or home; any failure lands on /?loginError=1. The state cookie is
// always cleared.
func (a *Auth) OAuthCallback(w http.ResponseWriter, r *http.Request, name string) error {
	spec, err := a.provider(name)
	if err != nil {
		return err
	}
	target := "/?loginError=1"
	var cookies []string
	if dest, issued, err := a.finish(r, name, spec); err == nil {
		target, cookies = dest, issued
	} else {
		logx.From(r.Context()).Warn("social login failed", "provider", name, "error", err.Error())
	}
	for _, c := range cookies {
		w.Header().Add("Set-Cookie", c)
	}
	w.Header().Add("Set-Cookie", a.transientCookie("", name, true))
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, a.cfg.AppURL+target, http.StatusSeeOther)
	return nil
}

func (a *Auth) finish(r *http.Request, name string, spec *Provider) (string, []string, error) {
	ctx := r.Context()
	var incoming url.Values
	if r.Method == http.MethodPost {
		body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		if err != nil {
			return "", nil, err
		}
		incoming, err = url.ParseQuery(string(body))
		if err != nil {
			return "", nil, err
		}
	} else {
		incoming = r.URL.Query()
	}
	var raw string
	if c, err := r.Cookie(stateCookie); err == nil {
		raw = c.Value
	}
	state, ok := a.unpack(raw)
	code := incoming.Get("code")
	if !ok || state.Provider != name || incoming.Get("state") != state.State || code == "" {
		return "", nil, errors.New("invalid-state")
	}
	conf := a.oauthConfig(name, spec)
	// jitter: none — one attempt per user action: 15 s clients for the exchange and userinfo, no retry; a failure lands on /?loginError=1 [site server/internal/auth/oauth.go:257]
	ctx = context.WithValue(ctx, oauth2.HTTPClient, &http.Client{Timeout: 15 * time.Second})
	opts := []oauth2.AuthCodeOption{oauth2.SetAuthURLParam("state", state.State)}
	if spec.PKCE {
		opts = append(opts, oauth2.VerifierOption(state.Verifier))
	}
	token, err := conf.Exchange(ctx, code, opts...)
	if err != nil {
		return "", nil, fmt.Errorf("token-exchange: %w", err)
	}
	who, err := a.identify(ctx, name, spec, conf, token, state, incoming)
	if err != nil {
		return "", nil, err
	}
	if who.providerID == "" || who.providerID == "undefined" {
		return "", nil, errors.New("invalid-identity")
	}
	user, created, err := a.account(ctx, name, who, state.Role)
	if err != nil {
		return "", nil, err
	}
	if user.Suspended {
		return "", nil, errors.New("suspended")
	}
	session, hint, err := a.Create(ctx, user.ID)
	if err != nil {
		return "", nil, err
	}
	cookies := []string{session, hint}
	switch {
	case created:
		return "/onboarding", cookies, nil
	case user.Role == store.RolePARENT:
		return "/parent", cookies, nil
	default:
		return "/", cookies, nil
	}
}

var (
	oidcMu        sync.Mutex
	oidcProviders = map[string]*oidc.Provider{}
)

func issuer(ctx context.Context, url string) (*oidc.Provider, error) {
	oidcMu.Lock()
	defer oidcMu.Unlock()
	if p, ok := oidcProviders[url]; ok {
		return p, nil
	}
	// jitter: none — oidcMu makes callers share one discovery, cached for the life of the process on success [site server/internal/auth/oauth.go:305]
	p, err := oidc.NewProvider(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery %s: %w", url, err)
	}
	oidcProviders[url] = p
	return p, nil
}

// ResetIssuers forgets discovered issuers (tests swap providers).
func ResetIssuers() {
	oidcMu.Lock()
	defer oidcMu.Unlock()
	oidcProviders = map[string]*oidc.Provider{}
}

func (a *Auth) identify(ctx context.Context, name string, spec *Provider, conf *oauth2.Config, token *oauth2.Token, state loginState, incoming url.Values) (identity, error) {
	who := identity{name: defaultName}
	if spec.Issuer != "" {
		rawID, _ := token.Extra("id_token").(string)
		if rawID == "" {
			return who, errors.New("missing-id-token")
		}
		p, err := issuer(ctx, spec.Issuer)
		if err != nil {
			return who, err
		}
		idToken, err := p.Verifier(&oidc.Config{ClientID: conf.ClientID}).Verify(ctx, rawID)
		if err != nil {
			return who, fmt.Errorf("id-token: %w", err)
		}
		if idToken.Nonce != state.Nonce || idToken.Subject == "" {
			return who, errors.New("invalid-nonce")
		}
		who.providerID = idToken.Subject
		var claims struct {
			Name string `json:"name"`
		}
		if idToken.Claims(&claims) == nil && claims.Name != "" {
			who.name = claims.Name
		}
		if name == "apple" {
			if userJSON := incoming.Get("user"); userJSON != "" {
				var detail struct {
					Name struct {
						FirstName string `json:"firstName"`
						LastName  string `json:"lastName"`
					} `json:"name"`
				}
				if json.Unmarshal([]byte(userJSON), &detail) == nil {
					if full := strings.TrimSpace(strings.Join(nonEmpty(detail.Name.LastName, detail.Name.FirstName), " ")); full != "" {
						who.name = full
					}
				}
			}
			return who, nil
		}
	}
	if spec.UserInfo == "" {
		return who, nil
	}
	if token.AccessToken == "" {
		return who, errors.New("missing-token")
	}
	info, err := fetchJSON(ctx, spec.UserInfo, token.AccessToken)
	if err != nil {
		return who, err
	}
	switch name {
	case "google":
		if who.providerID == "" {
			who.providerID = str(info["sub"])
		}
		if n := str(info["name"]); n != "" {
			who.name = n
		}
	case "kakao":
		who.providerID = str(info["id"])
		if props, ok := info["properties"].(map[string]any); ok {
			if n := str(props["nickname"]); n != "" {
				who.name = n
			}
		}
	case "naver":
		if resp, ok := info["response"].(map[string]any); ok {
			who.providerID = str(resp["id"])
			if n := str(resp["nickname"]); n != "" {
				who.name = n
			}
		}
	}
	return who, nil
}

func nonEmpty(values ...string) []string {
	out := []string{}
	for _, v := range values {
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

func str(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return fmt.Sprintf("%.0f", t)
	case json.Number:
		return t.String()
	case nil:
		return ""
	default:
		return fmt.Sprint(t)
	}
}

func fetchJSON(ctx context.Context, endpoint, accessToken string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	client := &http.Client{Timeout: 15 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("userinfo: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("userinfo: status %d", res.StatusCode)
	}
	var info map[string]any
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&info); err != nil {
		return nil, fmt.Errorf("userinfo: %w", err)
	}
	return info, nil
}

// account finds the user behind a provider identity or creates one.
func (a *Auth) account(ctx context.Context, provider string, who identity, role string) (store.User, bool, error) {
	row, err := a.q.GetOAuthAccountUser(ctx, store.GetOAuthAccountUserParams{Provider: provider, ProviderID: who.providerID})
	if err == nil {
		return row.User, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return store.User{}, false, err
	}
	name := []rune(who.name)
	if len(name) > 50 {
		name = name[:50]
	}
	var user store.User
	err = db.Tx(ctx, a.pool, func(tx pgx.Tx) error {
		q := a.q.WithTx(tx)
		var err error
		user, err = q.CreateUser(ctx, store.CreateUserParams{ID: ids.New(), Name: string(name), Nickname: "기억" + ids.Token(6), Role: store.Role(role)})
		if err != nil {
			return err
		}
		return q.CreateOAuthAccount(ctx, store.CreateOAuthAccountParams{ID: ids.New(), Provider: provider, ProviderID: who.providerID, UserID: user.ID})
	})
	if err != nil {
		// Two callbacks for the same new identity raced: the other one won; use its account.
		if row, again := a.q.GetOAuthAccountUser(ctx, store.GetOAuthAccountUserParams{Provider: provider, ProviderID: who.providerID}); again == nil {
			return row.User, false, nil
		}
		return store.User{}, false, err
	}
	return user, true, nil
}
