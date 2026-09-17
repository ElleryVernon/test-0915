package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/jackc/pgx/v5/pgxpool"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/cache"
	"memoryz/server/internal/config"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/store"
	"memoryz/server/internal/testenv"
)

const testClient = "test-client"

func testConfig() *config.Config {
	return &config.Config{
		Env: config.Development, AppURL: "http://127.0.0.1:8080", AuthSecret: strings.Repeat("s", 40),
		OAuth: map[string]config.OAuthClient{
			"google": {ID: testClient, Secret: "test-secret"},
			"kakao":  {ID: testClient, Secret: "test-secret"},
			"apple":  {ID: testClient, Secret: "test-secret"},
		},
	}
}

type fixture struct {
	t    *testing.T
	pool *pgxpool.Pool
	auth *Auth
	ids  []string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	pool := testenv.Pool(t, testenv.DatabaseURL(t))
	f := &fixture{t: t, pool: pool, auth: New(testConfig(), pool, cache.NewMemory())}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx, `DELETE FROM "User" WHERE "id" = ANY($1)`, f.ids)
		_, _ = pool.Exec(ctx, `DELETE FROM "User" WHERE "id" IN (SELECT "userId" FROM "OAuthAccount" WHERE "providerId" LIKE 'qa-%')`)
	})
	return f
}

func (f *fixture) user(role string, suspended bool) store.User {
	f.t.Helper()
	id := "qa-auth-" + ids.Token(4)
	var user store.User
	row := f.pool.QueryRow(context.Background(), `INSERT INTO "User" ("id", "name", "nickname", "role", "suspended") VALUES ($1, '검증', $1, $2, $3) RETURNING "id", "role", "suspended"`, id, role, suspended)
	if err := row.Scan(&user.ID, &user.Role, &user.Suspended); err != nil {
		f.t.Fatal(err)
	}
	f.ids = append(f.ids, id)
	return user
}

func tokenOf(cookie string) string {
	value, _, _ := strings.Cut(strings.TrimPrefix(cookie, CookieName+"="), ";")
	return value
}

func withCookie(name, value string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	r.AddCookie(&http.Cookie{Name: name, Value: value})
	return r
}

func TestStateCookie(t *testing.T) {
	a := New(testConfig(), nil, cache.NewMemory())
	state := loginState{State: "s", Verifier: "v", Nonce: "n", Role: "PARENT", Provider: "google", Expires: time.Now().Add(time.Minute).UnixMilli()}
	packed := a.pack(state)
	got, ok := a.unpack(packed)
	if !ok || got != state {
		t.Fatalf("round trip: %+v %v", got, ok)
	}
	if _, ok := a.unpack(packed[:len(packed)-2] + "xx"); ok {
		t.Fatal("tampered signature accepted")
	}
	if _, ok := a.unpack("nodot"); ok {
		t.Fatal("malformed value accepted")
	}
	expired := state
	expired.Expires = time.Now().Add(-time.Second).UnixMilli()
	if _, ok := a.unpack(a.pack(expired)); ok {
		t.Fatal("expired state accepted")
	}
	other := New(&config.Config{AuthSecret: strings.Repeat("o", 40), AppURL: "http://x"}, nil, cache.NewMemory())
	if _, ok := other.unpack(packed); ok {
		t.Fatal("state signed with another secret accepted")
	}
}

func TestSignedInHint(t *testing.T) {
	a := New(testConfig(), nil, cache.NewMemory())
	if got := a.HintCookie(691200*time.Second + 900*time.Millisecond); got != "memoryz_signed_in=1; SameSite=Lax; Path=/; Max-Age=691200" {
		t.Fatalf("hint cookie (dev): %s", got)
	}
	if strings.Contains(a.HintCookie(time.Hour), "HttpOnly") {
		t.Fatal("the hint must be readable by the web app")
	}
	if got := a.ClearHintCookie(); got != "memoryz_signed_in=; SameSite=Lax; Path=/; Max-Age=0" {
		t.Fatalf("clear hint: %s", got)
	}
	secure := New(&config.Config{AuthSecret: strings.Repeat("s", 40), AppURL: "https://memoryz.example", Env: "production"}, nil, cache.NewMemory())
	if got := secure.HintCookie(time.Hour); !strings.HasSuffix(got, "; Secure") || !strings.HasSuffix(secure.Cookie("t", time.Hour), "; Secure") {
		t.Fatalf("https origins mark both cookies Secure: %s", got)
	}
}

func TestSessionLifecycle(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	student := f.user("STUDENT", false)
	cookie, hint, err := f.auth.Create(ctx, student.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cookie, "HttpOnly; SameSite=Lax; Path=/; Max-Age=") || strings.Contains(cookie, "Secure") {
		t.Fatalf("cookie attributes: %s", cookie)
	}
	if age := maxAgeOf(cookie); age <= 648000 || age > 691200 || maxAgeOf(hint) != age {
		t.Fatalf("session and hint share one drawn Max-Age in (7.5 d, 8 d]: %s / %s", cookie, hint)
	}
	token := tokenOf(cookie)
	if len(token) != 64 {
		t.Fatalf("token length %d", len(token))
	}
	got, err := f.auth.CurrentUser(ctx, withCookie(CookieName, token))
	if err != nil || got.ID != student.ID {
		t.Fatalf("current user: %v %v", got.ID, err)
	}
	// The snapshot serves the next request even if the row vanished underneath (bounded by the TTL).
	if _, err := f.pool.Exec(ctx, `DELETE FROM "Session" WHERE "id" = $1`, TokenHash(token)); err != nil {
		t.Fatal(err)
	}
	if got, err := f.auth.CurrentUser(ctx, withCookie(CookieName, token)); err != nil || got.ID != student.ID {
		t.Fatalf("cached session should still answer: %v", err)
	}
	if err := f.auth.Delete(ctx, token); err != nil {
		t.Fatal(err)
	}
	if _, err := f.auth.CurrentUser(ctx, withCookie(CookieName, token)); !errors.Is(err, apierr.ErrSessionExpired) {
		t.Fatalf("deleted session: %v", err)
	}
	if _, err := f.auth.CurrentUser(ctx, withCookie(CookieName, "not-a-token")); !errors.Is(err, apierr.ErrLoginRequired) {
		t.Fatalf("malformed token: %v", err)
	}
	if _, err := f.auth.CurrentUser(ctx, httptest.NewRequest(http.MethodGet, "/", nil)); !errors.Is(err, apierr.ErrLoginRequired) {
		t.Fatalf("no cookie: %v", err)
	}
	expiredToken := ids.Token(32)
	if _, err := f.pool.Exec(ctx, `INSERT INTO "Session" ("id", "userId", "expiresAt") VALUES ($1, $2, now() - interval '1 minute')`, TokenHash(expiredToken), student.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.auth.CurrentUser(ctx, withCookie(CookieName, expiredToken)); !errors.Is(err, apierr.ErrSessionExpired) {
		t.Fatalf("expired session: %v", err)
	}
	// Suspension is visible right after the row changes because the handler invalidates the snapshot.
	cookie, _, _ = f.auth.Create(ctx, student.ID)
	token = tokenOf(cookie)
	if _, err := f.auth.CurrentUser(ctx, withCookie(CookieName, token)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE "User" SET "suspended" = true WHERE "id" = $1`, student.ID); err != nil {
		t.Fatal(err)
	}
	f.auth.Invalidate(ctx, student.ID)
	if _, err := f.auth.CurrentUser(ctx, withCookie(CookieName, token)); !errors.Is(err, apierr.ErrSuspended) {
		t.Fatalf("suspended: %v", err)
	}
	if err := RequireRole(store.User{Role: store.RolePARENT}, store.RoleSTUDENT); !errors.Is(err, apierr.ErrRole) {
		t.Fatalf("role: %v", err)
	}
}

// fakeIssuer is a minimal OpenID provider: discovery, JWKS, token and userinfo endpoints.
type fakeIssuer struct {
	srv      *httptest.Server
	key      *rsa.PrivateKey
	mu       sync.Mutex
	nonce    string
	sub      string
	name     string
	idToken  bool
	userinfo func() map[string]any
	form     url.Values
}

func newFakeIssuer(t *testing.T) *fakeIssuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeIssuer{key: key, idToken: true}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer": f.srv.URL, "authorization_endpoint": f.srv.URL + "/authorize", "token_endpoint": f.srv.URL + "/token",
			"jwks_uri": f.srv.URL + "/jwks", "userinfo_endpoint": f.srv.URL + "/userinfo",
			"response_types_supported": []string{"code"}, "subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &f.key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		f.form = r.PostForm
		nonce, sub, name, withID := f.nonce, f.sub, f.name, f.idToken
		f.mu.Unlock()
		if r.PostForm.Get("code") != "good" {
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		body := map[string]any{"access_token": "at-1", "token_type": "Bearer", "expires_in": 3600}
		if withID {
			signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: f.key}, (&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", "k1"))
			if err != nil {
				t.Error(err)
			}
			raw, err := jwt.Signed(signer).Claims(map[string]any{
				"iss": f.srv.URL, "aud": testClient, "sub": sub, "nonce": nonce, "name": name,
				"iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix(),
			}).Serialize()
			if err != nil {
				t.Error(err)
			}
			body["id_token"] = raw
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	})
	mux.HandleFunc("/userinfo", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer at-1" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		f.mu.Lock()
		info := f.userinfo()
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(info)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeIssuer) provider(pkce, formPost, oidc bool, userinfo bool) *Provider {
	p := &Provider{Authorize: f.srv.URL + "/authorize", Token: f.srv.URL + "/token", Scope: "openid profile", PKCE: pkce, FormPost: formPost}
	if oidc {
		p.Issuer = f.srv.URL
	}
	if userinfo {
		p.UserInfo = f.srv.URL + "/userinfo"
	}
	return p
}

// start runs the redirect step and returns the provider's query and the state cookie value.
func start(t *testing.T, a *Auth, provider, role string) (url.Values, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/auth/"+provider+"?role="+role, nil)
	if err := a.OAuthStart(rec, req, provider); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusFound {
		t.Fatalf("start status %d", rec.Code)
	}
	location, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	var cookie string
	for _, c := range rec.Result().Cookies() {
		if c.Name == stateCookie {
			cookie = c.Value
		}
	}
	if cookie == "" {
		t.Fatal("no state cookie")
	}
	return location.Query(), cookie
}

func callback(t *testing.T, a *Auth, provider, query, cookie string, form string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	var req *http.Request
	if form != "" {
		req = httptest.NewRequest(http.MethodPost, "/api/auth/"+provider+"/callback", strings.NewReader(form))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	} else {
		req = httptest.NewRequest(http.MethodGet, "/api/auth/"+provider+"/callback?"+query, nil)
	}
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: stateCookie, Value: cookie})
	}
	if err := a.OAuthCallback(rec, req, provider); err != nil {
		t.Fatal(err)
	}
	return rec
}

func sessionCookie(rec *httptest.ResponseRecorder) string {
	return cookieValue(rec, CookieName)
}

func cookieValue(rec *httptest.ResponseRecorder, name string) string {
	for _, c := range rec.Result().Cookies() {
		if c.Name == name && c.Value != "" {
			return c.Value
		}
	}
	return ""
}

func TestGoogleLogin(t *testing.T) {
	f := newFixture(t)
	issuer := newFakeIssuer(t)
	issuer.sub, issuer.name = "qa-google-"+ids.Token(4), "김지우"
	issuer.userinfo = func() map[string]any { return map[string]any{"sub": issuer.sub, "name": issuer.name} }
	original := Providers["google"]
	Providers["google"] = issuer.provider(true, false, true, true)
	ResetIssuers()
	t.Cleanup(func() { Providers["google"] = original; ResetIssuers() })
	a := f.auth

	query, cookie := start(t, a, "google", "STUDENT")
	if query.Get("client_id") != testClient || query.Get("scope") != "openid profile" || query.Get("code_challenge_method") != "S256" ||
		query.Get("code_challenge") == "" || query.Get("nonce") == "" || query.Get("state") == "" ||
		query.Get("redirect_uri") != "http://127.0.0.1:8080/api/auth/google/callback" {
		t.Fatalf("authorize query: %v", query)
	}
	issuer.nonce = query.Get("nonce")
	rec := callback(t, a, "google", "code=good&state="+url.QueryEscape(query.Get("state")), cookie, "")
	if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "http://127.0.0.1:8080/onboarding?signedIn=1" {
		t.Fatalf("new user: %d %s", rec.Code, rec.Header().Get("Location"))
	}
	if issuer.form.Get("code_verifier") == "" || issuer.form.Get("state") != query.Get("state") {
		t.Fatalf("token request lacked pkce/state: %v", issuer.form)
	}
	// The readable signed-in flag travels with the session from the OAuth callback too, with the
	// session's own Max-Age.
	if cookieValue(rec, SignedInCookie) != "1" {
		t.Fatalf("the OAuth callback must set %s=1 with the session", SignedInCookie)
	}
	var ages []int64
	for _, c := range rec.Result().Cookies() {
		if c.Name == CookieName || c.Name == SignedInCookie {
			ages = append(ages, int64(c.MaxAge))
		}
	}
	if len(ages) != 2 || ages[0] != ages[1] || ages[0] <= 648000 || ages[0] > 691200 {
		t.Fatalf("OAuth cookies share one drawn Max-Age: %v", ages)
	}
	token := sessionCookie(rec)
	if token == "" {
		t.Fatal("no session cookie")
	}
	user, err := a.CurrentUser(context.Background(), withCookie(CookieName, token))
	if err != nil || user.Name != "김지우" || user.Role != store.RoleSTUDENT || !strings.HasPrefix(user.Nickname, "기억") {
		t.Fatalf("created user: %+v %v", user, err)
	}
	f.ids = append(f.ids, user.ID)

	// Leaving setup does not silently complete it on the next sign-in.
	query, cookie = start(t, a, "google", "STUDENT")
	issuer.nonce = query.Get("nonce")
	rec = callback(t, a, "google", "code=good&state="+url.QueryEscape(query.Get("state")), cookie, "")
	if rec.Header().Get("Location") != "http://127.0.0.1:8080/onboarding?signedIn=1" {
		t.Fatal("pending account skipped onboarding")
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE "AccountOnboarding" SET "completedAt"=CURRENT_TIMESTAMP WHERE "userId"=$1`, user.ID); err != nil {
		t.Fatal(err)
	}

	// Same identity again: existing account, straight home.
	query, cookie = start(t, a, "google", "STUDENT")
	issuer.nonce = query.Get("nonce")
	rec = callback(t, a, "google", "code=good&state="+url.QueryEscape(query.Get("state")), cookie, "")
	if rec.Header().Get("Location") != "http://127.0.0.1:8080/?signedIn=1" {
		t.Fatalf("existing user: %s", rec.Header().Get("Location"))
	}

	// A wrong nonce, a tampered state or a bad code all land on the error page without a session.
	query, cookie = start(t, a, "google", "STUDENT")
	issuer.nonce = "someone-else"
	rec = callback(t, a, "google", "code=good&state="+url.QueryEscape(query.Get("state")), cookie, "")
	if rec.Header().Get("Location") != "http://127.0.0.1:8080/?loginError=1" || sessionCookie(rec) != "" || cookieValue(rec, SignedInCookie) != "" {
		t.Fatalf("nonce mismatch: %s (no session and no signed-in flag on a failed login)", rec.Header().Get("Location"))
	}
	query, cookie = start(t, a, "google", "STUDENT")
	issuer.nonce = query.Get("nonce")
	rec = callback(t, a, "google", "code=good&state=wrong", cookie, "")
	if rec.Header().Get("Location") != "http://127.0.0.1:8080/?loginError=1" {
		t.Fatalf("state mismatch: %s", rec.Header().Get("Location"))
	}
	rec = callback(t, a, "google", "code=bad&state="+url.QueryEscape(query.Get("state")), cookie, "")
	if rec.Header().Get("Location") != "http://127.0.0.1:8080/?loginError=1" {
		t.Fatalf("bad code: %s", rec.Header().Get("Location"))
	}
	cleared := false
	for _, c := range rec.Result().Cookies() {
		if c.Name == stateCookie && c.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Fatal("state cookie not cleared")
	}

	// A suspended account cannot sign in.
	if _, err := f.pool.Exec(context.Background(), `UPDATE "User" SET "suspended" = true WHERE "id" = $1`, user.ID); err != nil {
		t.Fatal(err)
	}
	query, cookie = start(t, a, "google", "STUDENT")
	issuer.nonce = query.Get("nonce")
	rec = callback(t, a, "google", "code=good&state="+url.QueryEscape(query.Get("state")), cookie, "")
	if rec.Header().Get("Location") != "http://127.0.0.1:8080/?loginError=1" {
		t.Fatalf("suspended: %s", rec.Header().Get("Location"))
	}

	// A parent lands on the parent home.
	issuer.sub = "qa-google-parent-" + ids.Token(4)
	query, cookie = start(t, a, "google", "PARENT")
	issuer.nonce = query.Get("nonce")
	rec = callback(t, a, "google", "code=good&state="+url.QueryEscape(query.Get("state")), cookie, "")
	if rec.Header().Get("Location") != "http://127.0.0.1:8080/onboarding?signedIn=1" {
		t.Fatalf("new parent: %s", rec.Header().Get("Location"))
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE "AccountOnboarding" SET "completedAt"=CURRENT_TIMESTAMP WHERE "userId"=(SELECT "userId" FROM "OAuthAccount" WHERE "provider"='google' AND "providerId"=$1)`, issuer.sub); err != nil {
		t.Fatal(err)
	}
	query, cookie = start(t, a, "google", "PARENT")
	issuer.nonce = query.Get("nonce")
	rec = callback(t, a, "google", "code=good&state="+url.QueryEscape(query.Get("state")), cookie, "")
	if rec.Header().Get("Location") != "http://127.0.0.1:8080/parent?signedIn=1" {
		t.Fatalf("existing parent: %s", rec.Header().Get("Location"))
	}
	if _, err := a.provider("naver"); !errors.Is(err, ErrProviderOff) {
		t.Fatalf("unconfigured provider: %v", err)
	}
}

func TestKakaoLogin(t *testing.T) {
	f := newFixture(t)
	issuer := newFakeIssuer(t)
	issuer.idToken = false
	issuer.userinfo = func() map[string]any {
		return map[string]any{"id": 424242424242, "properties": map[string]any{"nickname": "수학하는도윤"}}
	}
	original := Providers["kakao"]
	Providers["kakao"] = issuer.provider(false, false, false, true)
	t.Cleanup(func() {
		Providers["kakao"] = original
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM "User" WHERE "id" IN (SELECT "userId" FROM "OAuthAccount" WHERE "provider" = 'kakao' AND "providerId" = '424242424242')`)
	})
	query, cookie := start(t, f.auth, "kakao", "STUDENT")
	if query.Get("scope") != "openid profile" || query.Get("code_challenge") != "" {
		t.Fatalf("kakao query: %v", query)
	}
	rec := callback(t, f.auth, "kakao", "code=good&state="+url.QueryEscape(query.Get("state")), cookie, "")
	if rec.Header().Get("Location") != "http://127.0.0.1:8080/onboarding?signedIn=1" {
		t.Fatalf("kakao: %s", rec.Header().Get("Location"))
	}
	user, err := f.auth.CurrentUser(context.Background(), withCookie(CookieName, sessionCookie(rec)))
	if err != nil || user.Name != "수학하는도윤" {
		t.Fatalf("kakao user: %+v %v", user, err)
	}
	row, err := store.New(f.pool).GetOAuthAccountUser(context.Background(), store.GetOAuthAccountUserParams{Provider: "kakao", ProviderID: "424242424242"})
	if err != nil || row.User.ID != user.ID {
		t.Fatalf("account row: %v", err)
	}
}

func TestAppleLogin(t *testing.T) {
	f := newFixture(t)
	issuer := newFakeIssuer(t)
	issuer.sub = "qa-apple-" + ids.Token(4)
	issuer.userinfo = func() map[string]any { return nil }
	original := Providers["apple"]
	Providers["apple"] = issuer.provider(false, true, true, false)
	ResetIssuers()
	t.Cleanup(func() { Providers["apple"] = original; ResetIssuers() })
	query, cookie := start(t, f.auth, "apple", "STUDENT")
	if query.Get("response_mode") != "form_post" || query.Get("nonce") == "" {
		t.Fatalf("apple query: %v", query)
	}
	issuer.nonce = query.Get("nonce")
	form := url.Values{"code": {"good"}, "state": {query.Get("state")}, "user": {`{"name":{"firstName":"지우","lastName":"김"}}`}}
	rec := callback(t, f.auth, "apple", "", cookie, form.Encode())
	if rec.Header().Get("Location") != "http://127.0.0.1:8080/onboarding?signedIn=1" {
		t.Fatalf("apple: %s", rec.Header().Get("Location"))
	}
	user, err := f.auth.CurrentUser(context.Background(), withCookie(CookieName, sessionCookie(rec)))
	if err != nil || user.Name != "김 지우" {
		t.Fatalf("apple user: %+v %v", user, err)
	}
	f.ids = append(f.ids, user.ID)
}

func TestGateHTML(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	student := f.user("STUDENT", false)
	parent := f.user("PARENT", false)
	studentCookie, _, _ := f.auth.Create(ctx, student.ID)
	parentCookie, _, _ := f.auth.Create(ctx, parent.ID)
	passed := 0
	gate := f.auth.GateHTML(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { passed++; w.WriteHeader(http.StatusOK) }))
	get := func(path, cookie string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: CookieName, Value: tokenOf(cookie)})
		}
		gate.ServeHTTP(rec, req)
		return rec
	}
	if rec := get("/study", ""); rec.Code != http.StatusOK {
		t.Fatalf("no cookie should pass: %d", rec.Code)
	}
	if rec := get("/study", studentCookie); rec.Code != http.StatusOK {
		t.Fatalf("student on study: %d", rec.Code)
	}
	if rec := get("/study/abc", parentCookie); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "이 계정에서 볼 수 없는 화면이에요") {
		t.Fatalf("parent on study: %d", rec.Code)
	}
	if rec := get("/parent", studentCookie); rec.Code != http.StatusForbidden {
		t.Fatalf("student on parent: %d", rec.Code)
	}
	if rec := get("/admin", parentCookie); rec.Code != http.StatusForbidden {
		t.Fatalf("parent on admin: %d", rec.Code)
	}
	if rec := get("/cheer", parentCookie); rec.Code != http.StatusOK {
		t.Fatalf("cheer has no role rule: %d", rec.Code)
	}
	if rec := get("/", parentCookie); rec.Code != http.StatusOK {
		t.Fatalf("home is not gated: %d", rec.Code)
	}
	if rec := get("/planner", CookieName+"=deadbeef; Path=/"); rec.Code != http.StatusFound || rec.Header().Get("Location") != "/" {
		t.Fatalf("broken session should go home: %d %s", rec.Code, rec.Header().Get("Location"))
	}
	// /study (no cookie), /study (student), /cheer and / reached the static handler; the rest did not.
	if passed != 4 {
		t.Fatalf("passed %d", passed)
	}
	_ = slog.Default()
}

func TestNaverLogin(t *testing.T) {
	f := newFixture(t)
	issuer := newFakeIssuer(t)
	issuer.idToken = false
	id := "qa-naver-" + ids.Token(6)
	issuer.userinfo = func() map[string]any {
		return map[string]any{"resultcode": "00", "response": map[string]any{"id": id, "nickname": "네이버학습자"}}
	}
	original := Providers["naver"]
	Providers["naver"] = issuer.provider(false, false, false, true)
	f.auth.cfg.OAuth["naver"] = config.OAuthClient{ID: testClient, Secret: "test-secret"}
	t.Cleanup(func() { Providers["naver"] = original })
	q, c := start(t, f.auth, "naver", "STUDENT")
	rec := callback(t, f.auth, "naver", "code=good&state="+url.QueryEscape(q.Get("state")), c, "")
	if rec.Header().Get("Location") != "http://127.0.0.1:8080/onboarding?signedIn=1" {
		t.Fatal("naver callback failed", rec.Header().Get("Location"))
	}
	user, err := f.auth.CurrentUser(context.Background(), withCookie(CookieName, sessionCookie(rec)))
	if err != nil || user.Name != "네이버학습자" {
		t.Fatal("naver identity failed", err)
	}
	f.ids = append(f.ids, user.ID)
	if issuer.form.Get("state") != q.Get("state") {
		t.Fatal("Naver exchange missing state")
	}
}
