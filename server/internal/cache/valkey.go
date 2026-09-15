package cache

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/valkey-io/valkey-go"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"

	"memoryz/server/internal/jitter"
)

// ValkeyOptions describes the instance and how to authenticate to it.
type ValkeyOptions struct {
	Addr       string // host:port
	IAM        bool   // Memorystore IAM authentication: the service account's access token is the password
	CAPEM      string // PEM of the instance's certificate authority; enables TLS with server authentication
	ServerName string // TLS name to verify (defaults to the host part of Addr)
	Username   string // static credentials (local instances with ACL users)
	Password   string
	// TokenSource overrides the Google credentials (tests); nil means Application Default Credentials.
	TokenSource oauth2.TokenSource
}

// Valkey is the shared cache for the cloud service (Memorystore for Valkey, cluster mode disabled).
type Valkey struct {
	client valkey.Client
	addr   string
}

// NewValkey connects and verifies the instance with one PING.
func NewValkey(ctx context.Context, o ValkeyOptions) (*Valkey, error) {
	option := valkey.ClientOption{
		InitAddress:      []string{o.Addr},
		DisableCache:     true, // small hot set, no client-side tracking needed
		ConnWriteTimeout: 3 * time.Second,
		Username:         o.Username,
		Password:         o.Password,
	}
	if o.CAPEM != "" {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM([]byte(o.CAPEM)) {
			return nil, errors.New("valkey: VALKEY_CA_PEM holds no certificate")
		}
		host, _, err := net.SplitHostPort(o.Addr)
		if err != nil {
			return nil, fmt.Errorf("valkey: address %q: %w", o.Addr, err)
		}
		serverName := o.ServerName
		if serverName == "" {
			serverName = host
		}
		option.TLSConfig = &tls.Config{RootCAs: pool, ServerName: serverName, MinVersion: tls.VersionTLS12}
	}
	if o.IAM || o.TokenSource != nil {
		source := o.TokenSource
		if source == nil {
			// The credentials' own token source refreshes 10 minutes early, so a connection that
			// re-authenticates near expiry already gets the next token (no outer cache needed).
			creds, err := google.FindDefaultCredentialsWithParams(ctx, google.CredentialsParams{
				Scopes:            []string{"https://www.googleapis.com/auth/cloud-platform"},
				EarlyTokenRefresh: 10 * time.Minute,
			})
			if err != nil {
				return nil, fmt.Errorf("valkey: token source: %w", err)
			}
			source = creds.TokenSource
		}
		option.AuthCredentialsFn = IAMCredentials(source)
	}
	client, err := valkey.NewClient(option)
	if err != nil {
		return nil, fmt.Errorf("valkey client: %w", err)
	}
	// jitter: none — one PING (5 s, no retry) per instance start, and Cloud Run already spaces out restarts [site server/internal/cache/valkey.go:76]
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := client.Do(pingCtx, client.B().Ping().Build()).Error(); err != nil {
		client.Close()
		return nil, fmt.Errorf("valkey ping %s: %w", o.Addr, err)
	}
	return &Valkey{client: client, addr: o.Addr}, nil
}

// IAMCredentials hands each new connection a fresh access token and schedules the next
// re-authentication before the token expires, so long-lived connections keep working after rotation.
func IAMCredentials(source oauth2.TokenSource) func(valkey.AuthCredentialsContext) (valkey.AuthCredentials, error) {
	return iamCredentials(source, jitter.Std, time.Now)
}

func iamCredentials(source oauth2.TokenSource, r jitter.Rand, now func() time.Time) func(valkey.AuthCredentialsContext) (valkey.AuthCredentials, error) {
	return func(valkey.AuthCredentialsContext) (valkey.AuthCredentials, error) {
		token, err := source.Token()
		if err != nil {
			return valkey.AuthCredentials{}, fmt.Errorf("valkey: access token: %w", err)
		}
		return valkey.AuthCredentials{Password: token.AccessToken, RefreshAfter: iamRefreshAt(token.Expiry, r, now())}, nil
	}
}

// iamRefreshAt is when a connection re-authenticates: 5 min + U[0, 60 s) before the token expires,
// so the connections a pool opened together do not all re-AUTH in the same second. A token that is
// already close to expiry (the previous rule then scheduled the refresh 30 min later — after the
// expiry) is retried after U[30 s, 90 s), and never later than half its remaining life.
func iamRefreshAt(expiry time.Time, r jitter.Rand, now time.Time) time.Time {
	if expiry.IsZero() {
		return now.Add(30 * time.Minute)
	}
	// jitter: lifetime re-AUTH 5 min + U[0,60 s) before expiry; near expiry U[30 s,90 s) capped at half the remaining life [site server/internal/cache/valkey.go:93]
	if at := expiry.Add(-5*time.Minute - jitter.Between(r, 0, time.Minute)); at.After(now) {
		return at
	}
	at := now.Add(jitter.Between(r, 30*time.Second, 90*time.Second))
	if expiry.After(now) {
		if half := now.Add(expiry.Sub(now) / 2); at.After(half) {
			at = half
		}
	}
	return at
}

func (v *Valkey) Name() string { return "valkey:" + v.addr }

// opTimeout bounds every cache operation. valkey-go retries with equal jitter but skips a retry that
// would pass the deadline, so a Valkey outage costs at most this per operation before the request
// falls back to Postgres — never the whole request deadline (docs/JITTER.md).
const opTimeout = 250 * time.Millisecond

func (v *Valkey) Get(ctx context.Context, key string) ([]byte, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	// jitter: library valkey-go equal-jitter retry bounded by the 250 ms operation deadline [site server/internal/cache/valkey.go:40]
	data, err := v.client.Do(ctx, v.client.B().Get().Key(key).Build()).AsBytes()
	if err != nil {
		if valkey.IsValkeyNil(err) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return data, true, nil
}

func (v *Valkey) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	b := v.client.B().Set().Key(key).Value(valkey.BinaryString(value))
	// jitter: none — the driver writes the PX TTL it is given; cache TTLs are exact by policy and the write is bounded by opTimeout [site server/internal/cache/valkey.go:117]
	if ttl > 0 {
		return v.client.Do(ctx, b.Px(ttl).Build()).Error()
	}
	return v.client.Do(ctx, b.Build()).Error()
}

func (v *Valkey) Del(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	return v.client.Do(ctx, v.client.B().Del().Key(keys...).Build()).Error()
}

// jitter: retry-after enabler: one atomic INCR + PTTL + heal-PEXPIRE, so every refusal can say how much of the window is left [site server/internal/cache/valkey.go:129]
// windowScript counts one event and reports the window's remaining time atomically. A key without
// an expiry (a crash between INCR and PEXPIRE in the old two-command form left some) heals here.
var windowScript = valkey.NewLuaScript(`local n = redis.call('INCR', KEYS[1])
local left = redis.call('PTTL', KEYS[1])
if left < 0 and tonumber(ARGV[1]) > 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  left = tonumber(ARGV[1])
end
return {n, left}`)

func (v *Valkey) Incr(ctx context.Context, key string, ttl time.Duration) (int64, time.Duration, error) {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	// jitter: retry-after the fixed window stays; each refusal gets the window's rest + U[0,15 s) from ratelimit.Check [site server/internal/cache/valkey.go:134]
	out, err := windowScript.Exec(ctx, v.client, []string{key}, []string{strconv.FormatInt(ttl.Milliseconds(), 10)}).AsIntSlice()
	if err != nil {
		return 0, 0, err
	}
	if len(out) != 2 {
		return 0, 0, fmt.Errorf("valkey: window script returned %d values", len(out))
	}
	return out[0], max(0, time.Duration(out[1])*time.Millisecond), nil
}

// bumpScript stores max(current+1, floor) as decimal text; values never repeat, even after expiry.
var bumpScript = valkey.NewLuaScript(`local cur = tonumber(redis.call('GET', KEYS[1])) or 0
local n = math.max(cur + 1, tonumber(ARGV[1]))
local s = string.format('%d', n)
redis.call('SET', KEYS[1], s, 'PX', ARGV[2])
return s`)

func (v *Valkey) Bump(ctx context.Context, key string, floor int64, ttl time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	return bumpScript.Exec(ctx, v.client, []string{key}, []string{strconv.FormatInt(floor, 10), strconv.FormatInt(max(1, ttl.Milliseconds()), 10)}).ToString()
}

// releaseScript deletes the lease only if the caller still owns it.
const releaseScript = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`

// jitter: none — Lock is not used in production; only tests call it [site server/internal/cache/valkey.go:145]
func (v *Valkey) Lock(ctx context.Context, key string, ttl time.Duration) (func(), bool, error) {
	var b [8]byte
	_, _ = rand.Read(b[:])
	token := hex.EncodeToString(b[:])
	// jitter: none — an unused lease (SET NX PX, 3 s release), so nothing can synchronise on it [site server/internal/cache/valkey.go:149]
	res := v.client.Do(ctx, v.client.B().Set().Key(key).Value(token).Nx().Px(ttl).Build())
	if err := res.Error(); err != nil {
		if valkey.IsValkeyNil(err) {
			return nil, false, nil
		}
		return nil, false, err
	}
	var once sync.Once
	release := func() {
		once.Do(func() {
			rctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_ = v.client.Do(rctx, v.client.B().Eval().Script(releaseScript).Numkeys(1).Key(key).Arg(token).Build()).Error()
		})
	}
	return release, true, nil
}

func (v *Valkey) Flush(ctx context.Context) error {
	return v.client.Do(ctx, v.client.B().Flushdb().Build()).Error()
}

func (v *Valkey) Close() error {
	v.client.Close()
	return nil
}
