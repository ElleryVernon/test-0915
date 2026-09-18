// Package config reads the server's settings from the environment, validates them once at startup
// and never lets a secret reach the logs.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Environment names.
const (
	Development = "development"
	Production  = "production"
)

// OAuthClient is one social login provider's client credentials.
type OAuthClient struct {
	ID     string
	Secret string
}

// Config is the validated server configuration.
type Config struct {
	Env       string
	Host      string // listen address; empty binds every interface (Cloud Run), development binds loopback
	Port      int
	AppURL    string // public origin (https://…); decides Secure cookies, OAuth callbacks and the CSRF rule
	LogFormat string // json | text

	DatabaseURL string // secret: a postgres:// URL (local, or through a proxy)
	DBInstance  string // Cloud SQL instance connection name project:region:instance; used instead of DatabaseURL
	DBUser      string
	DBName      string
	DBPassword  string // secret; empty with IAM authentication
	DBIAMAuth   bool
	DBIPType    string // private | public
	DBPoolMax   int32

	ValkeyAddr          string // host:port; empty keeps the in-process cache
	ValkeyIAMAuth       bool   // Memorystore IAM authentication (the service account's access token is the password)
	ValkeyCAPEM         string // PEM certificate authority; set means TLS with server authentication
	ValkeyTLSServerName string // name to verify on the server certificate; defaults to the address host
	ValkeyUsername      string // static ACL credentials (local instances)
	ValkeyPassword      string // secret
	BlobStore           string // pg | gcs
	GCSBucket           string
	StaticDir           string // directory of the web build to serve; empty serves the API only

	TossClientKey string
	TossSecretKey string // secret; server-only
	PaymentsLive  bool   // explicit opt-in; test keys never enabled in production

	DemoMode  bool
	DemoAdmin bool

	AuthSecret string // secret: signs login state cookies
	OAuth      map[string]OAuthClient

	OpenRouterAPIKey         string // secret
	OpenRouterModel          string
	OpenRouterQualityModel   string // optional independent generation reviewer; empty uses the generator
	OpenRouterEffort         string
	OpenRouterStructuredMode string // function (default) or json_schema for endpoints without forced tools
	OpenRouterProviderOrder  []string
	OpenRouterBaseURL        string // empty means openrouter.ai; tests point it at a fake
	AIRatePerMinute          int    // paid model requests one student may start per minute
	AIRatePerDay             int
	TypeSafeAPIKey           string // secret: TypeSafe (Jev) judgment model
	TypeSafeModel            string // jev-latest unless pinned
	TypeSafeBaseURL          string // empty means api.typesafe.ai; tests point it at a fake
	AIJudge                  string // off (default): no judgments; shadow: record verdicts only; on: agreement may replace the separate review call

	PDFWorkers       int
	AIConcurrency    int
	AIQualityReview  bool // independent semantic review before generated items can be stored
	UploadLegacyDirs []string
	MigrateOnStart   bool
	LogLevel         string
	GoogleProject    string // for log/trace correlation in Cloud Logging
	TrustProxy       bool   // behind Cloud Run: X-Forwarded-For names the client (see TrustedProxies)
	// TrustedProxies are the addresses that append to X-Forwarded-For after the client: the load
	// balancer's forwarding rule in front of Cloud Run. The client is the rightmost entry not in it.
	TrustedProxies  []netip.Prefix
	PprofAddr       string  // loopback address for net/http/pprof; empty keeps profiling off
	OTelExporter    string  // none | stdout | gcp — where spans and metrics go
	OTelSampleRatio float64 // fraction of root traces kept (0, 1]

	// Warnings are non-fatal findings to log once at startup.
	Warnings []string
}

// Providers this server can sign users in with, in the order the client lists them.
var Providers = []string{"google", "kakao", "naver", "apple"}

// DefaultProviderOrder routes Luna to OpenAI's fast tier first and Bedrock us-east-1 second. The
// previous server had Bedrock first; measured on 2026-09-15 Bedrock answered a 3-card request in
// 56.7 s (cloud run 01a0a534) and a 1-card request with zero completion tokens after 93.4 s
// (verify-provider), while every OpenAI answer that day completed (1–11 s at 01:26 KST, 3–89 s at
// 23:40 KST). OPENROUTER_PROVIDER_ORDER overrides.
var DefaultProviderOrder = []string{"openai/fast", "amazon-bedrock/us-east-1"}

var providerSlug = regexp.MustCompile(`^[a-z0-9-]+(/[a-z0-9-]+)?$`)

const devSecret = "memoryz-development-only-secret-do-not-use-in-production"

// Load builds a Config from get (usually os.LookupEnv) and validates it.
func Load(get func(string) (string, bool)) (*Config, error) {
	env := func(key, fallback string) string {
		if v, ok := get(key); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
		return fallback
	}
	var problems []string
	intOf := func(key string, fallback int) int {
		raw := env(key, "")
		if raw == "" {
			return fallback
		}
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			problems = append(problems, key+" must be a non-negative integer")
			return fallback
		}
		return n
	}
	boolOf := func(key string) bool { return env(key, "false") == "true" }

	c := &Config{
		Env:                      env("ENV", Development),
		Host:                     env("HOST", ""),
		Port:                     intOf("PORT", 8080),
		LogFormat:                env("LOG_FORMAT", ""),
		AppURL:                   env("APP_URL", ""),
		DatabaseURL:              env("DATABASE_URL", ""),
		DBInstance:               env("DB_INSTANCE", ""),
		DBUser:                   env("DB_USER", ""),
		DBName:                   env("DB_NAME", "memoryz"),
		DBPassword:               env("DB_PASSWORD", ""),
		DBIAMAuth:                boolOf("DB_IAM_AUTH"),
		DBIPType:                 env("DB_IP_TYPE", "private"),
		DBPoolMax:                int32(intOf("DB_POOL_MAX", 6)),
		ValkeyAddr:               env("VALKEY_ADDR", ""),
		ValkeyIAMAuth:            boolOf("VALKEY_IAM_AUTH"),
		ValkeyCAPEM:              env("VALKEY_CA_PEM", ""),
		ValkeyTLSServerName:      env("VALKEY_TLS_SERVER_NAME", ""),
		ValkeyUsername:           env("VALKEY_USERNAME", ""),
		ValkeyPassword:           env("VALKEY_PASSWORD", ""),
		BlobStore:                env("BLOB_STORE", "pg"),
		GCSBucket:                env("GCS_BUCKET", ""),
		StaticDir:                env("STATIC_DIR", ""),
		TossClientKey:            env("TOSS_CLIENT_KEY", ""),
		TossSecretKey:            env("TOSS_SECRET_KEY", ""),
		PaymentsLive:             boolOf("PAYMENTS_LIVE"),
		DemoMode:                 boolOf("DEMO_MODE"),
		DemoAdmin:                boolOf("DEMO_ADMIN"),
		AuthSecret:               env("AUTH_SECRET", ""),
		OAuth:                    map[string]OAuthClient{},
		OpenRouterAPIKey:         env("OPENROUTER_API_KEY", ""),
		OpenRouterModel:          env("OPENROUTER_MODEL", ""),
		OpenRouterQualityModel:   env("OPENROUTER_QUALITY_MODEL", ""),
		OpenRouterEffort:         env("OPENROUTER_REASONING_EFFORT", "high"),
		OpenRouterStructuredMode: env("OPENROUTER_STRUCTURED_MODE", "function"),
		OpenRouterBaseURL:        env("OPENROUTER_BASE_URL", ""),
		AIRatePerMinute:          intOf("AI_RATE_PER_MINUTE", 10),
		AIRatePerDay:             intOf("AI_RATE_PER_DAY", 200),
		TypeSafeAPIKey:           env("TYPESAFE_API_KEY", ""),
		TypeSafeModel:            env("TYPESAFE_MODEL", "jev-latest"),
		TypeSafeBaseURL:          env("TYPESAFE_BASE_URL", ""),
		AIJudge:                  env("AI_JUDGE", "off"),
		PDFWorkers:               intOf("PDF_WORKERS", 2),
		AIConcurrency:            intOf("AI_CONCURRENCY", 16),
		AIQualityReview:          env("AI_QUALITY_REVIEW", "true") != "false",
		MigrateOnStart:           boolOf("MIGRATE_ON_START"),
		LogLevel:                 env("LOG_LEVEL", "info"),
		GoogleProject:            env("GOOGLE_CLOUD_PROJECT", ""),
		TrustProxy:               env("TRUST_PROXY", "") == "true",
		PprofAddr:                env("PPROF_ADDR", ""),
		OTelExporter:             env("OTEL_EXPORTER", ""),
		OTelSampleRatio:          1,
	}
	for _, raw := range strings.Split(env("TRUSTED_PROXIES", ""), ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		prefix, err := netip.ParsePrefix(raw)
		if err != nil {
			addr, aerr := netip.ParseAddr(raw)
			if aerr != nil {
				problems = append(problems, "TRUSTED_PROXIES must be comma-separated IP addresses or CIDR ranges")
				continue
			}
			prefix = netip.PrefixFrom(addr, addr.BitLen())
		}
		c.TrustedProxies = append(c.TrustedProxies, prefix.Masked())
	}
	if raw := env("OTEL_SAMPLE_RATIO", ""); raw != "" {
		ratio, err := strconv.ParseFloat(raw, 64)
		if err != nil || ratio <= 0 || ratio > 1 {
			problems = append(problems, "OTEL_SAMPLE_RATIO must be a number in (0, 1]")
		} else {
			c.OTelSampleRatio = ratio
		}
	}
	if c.GoogleProject == "" && strings.Count(c.DBInstance, ":") == 2 {
		// The Cloud SQL instance name starts with the project; Cloud Run sets no project variable.
		c.GoogleProject = c.DBInstance[:strings.IndexByte(c.DBInstance, ':')]
	}
	if c.OTelExporter == "" {
		c.OTelExporter = "none"
		if c.Env == Production {
			c.OTelExporter = "gcp"
		}
	}
	switch c.OTelExporter {
	case "none", "stdout":
	case "gcp":
		if c.GoogleProject == "" {
			problems = append(problems, "GOOGLE_CLOUD_PROJECT is required with OTEL_EXPORTER=gcp")
		}
	default:
		problems = append(problems, "OTEL_EXPORTER must be none, stdout or gcp")
	}
	if c.Env == Production && c.ValkeyAddr == "" {
		// Without the shared cache every instance keeps its own rate-limit counters, cache versions
		// and fills: up to 3× the limits and stale reads across instances.
		problems = append(problems, "VALKEY_ADDR is required in production (rate limits, cache versions and fills are shared across instances)")
	}
	if c.ValkeyAddr != "" {
		if _, _, err := net.SplitHostPort(c.ValkeyAddr); err != nil {
			problems = append(problems, "VALKEY_ADDR must be host:port")
		}
		if c.Env == Production && c.ValkeyCAPEM == "" {
			problems = append(problems, "VALKEY_CA_PEM is required in production (the cache travels the VPC only over TLS)")
		}
		if c.ValkeyIAMAuth && (c.ValkeyUsername != "" || c.ValkeyPassword != "") {
			problems = append(problems, "VALKEY_IAM_AUTH excludes VALKEY_USERNAME/VALKEY_PASSWORD")
		}
		if _, set := get("VALKEY_IAM_AUTH"); !set && c.Env == Production && c.ValkeyPassword == "" {
			c.ValkeyIAMAuth = true
		}
	}

	if c.Env != Development && c.Env != Production {
		problems = append(problems, "ENV must be development or production")
	}
	if _, set := get("TRUST_PROXY"); !set && c.Env == Production {
		c.TrustProxy = true
	}
	if _, set := get("HOST"); !set && c.Env == Development {
		c.Host = "127.0.0.1"
	}
	if c.LogFormat == "" {
		c.LogFormat = "text"
		if c.Env == Production {
			c.LogFormat = "json"
		}
	}
	if c.LogFormat != "json" && c.LogFormat != "text" {
		problems = append(problems, "LOG_FORMAT must be json or text")
	}
	if c.Port < 1 || c.Port > 65535 {
		problems = append(problems, "PORT must be between 1 and 65535")
	}
	if c.DatabaseURL == "" && c.DBInstance == "" {
		problems = append(problems, "DATABASE_URL is required (or DB_INSTANCE with DB_USER for Cloud SQL)")
	}
	if c.DatabaseURL != "" {
		if u, err := url.Parse(c.DatabaseURL); err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
			problems = append(problems, "DATABASE_URL must be a postgres:// URL")
		}
	}
	if c.DBInstance != "" {
		if strings.Count(c.DBInstance, ":") != 2 {
			problems = append(problems, "DB_INSTANCE must look like project:region:instance")
		}
		if c.DBUser == "" {
			problems = append(problems, "DB_USER is required with DB_INSTANCE")
		}
		if !c.DBIAMAuth && c.DBPassword == "" {
			problems = append(problems, "DB_PASSWORD is required with DB_INSTANCE unless DB_IAM_AUTH=true")
		}
	}
	if c.DBIPType != "private" && c.DBIPType != "public" {
		problems = append(problems, "DB_IP_TYPE must be private or public")
	}
	if c.DBPoolMax < 1 || c.DBPoolMax > 50 {
		problems = append(problems, "DB_POOL_MAX must be between 1 and 50")
	}
	if c.BlobStore != "pg" && c.BlobStore != "gcs" {
		problems = append(problems, "BLOB_STORE must be pg or gcs")
	}
	if c.BlobStore == "gcs" && c.GCSBucket == "" {
		problems = append(problems, "GCS_BUCKET is required with BLOB_STORE=gcs")
	}
	if c.AppURL == "" {
		if c.Env == Production {
			problems = append(problems, "APP_URL is required in production")
		} else {
			c.AppURL = fmt.Sprintf("http://127.0.0.1:%d", c.Port)
		}
	}
	if c.AppURL != "" {
		u, err := url.Parse(c.AppURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			problems = append(problems, "APP_URL must be an absolute http(s) origin")
		} else if c.Env == Production && u.Scheme != "https" {
			problems = append(problems, "APP_URL must use https in production")
		} else {
			c.AppURL = u.Scheme + "://" + u.Host
		}
	}
	if c.AuthSecret == "" {
		if c.Env == Production {
			problems = append(problems, "AUTH_SECRET is required in production (32+ random bytes)")
		} else {
			c.AuthSecret = devSecret
			c.Warnings = append(c.Warnings, "AUTH_SECRET is unset; using the development-only secret")
		}
	} else if len(c.AuthSecret) < 32 {
		problems = append(problems, "AUTH_SECRET must be at least 32 characters")
	}
	for _, p := range Providers {
		id := env(strings.ToUpper(p)+"_CLIENT_ID", "")
		secret := env(strings.ToUpper(p)+"_CLIENT_SECRET", "")
		switch {
		case id != "" && secret != "":
			c.OAuth[p] = OAuthClient{ID: id, Secret: secret}
		case id != "" || secret != "":
			c.Warnings = append(c.Warnings, strings.ToUpper(p)+"_CLIENT_ID and _CLIENT_SECRET must both be set; "+p+" login stays off")
		}
	}
	if raw := env("OPENROUTER_PROVIDER_ORDER", ""); raw != "" {
		for _, slug := range strings.Split(raw, ",") {
			slug = strings.TrimSpace(slug)
			if slug == "" {
				continue
			}
			if !providerSlug.MatchString(slug) {
				problems = append(problems, "OPENROUTER_PROVIDER_ORDER has an invalid provider slug")
				break
			}
			c.OpenRouterProviderOrder = append(c.OpenRouterProviderOrder, slug)
		}
	}
	if len(c.OpenRouterProviderOrder) == 0 {
		c.OpenRouterProviderOrder = append([]string(nil), DefaultProviderOrder...)
	}
	if c.OpenRouterModel != "" && !regexp.MustCompile(`^[a-zA-Z0-9._:/-]+$`).MatchString(c.OpenRouterModel) {
		problems = append(problems, "OPENROUTER_MODEL has unexpected characters")
	}
	if c.OpenRouterQualityModel != "" && !regexp.MustCompile(`^[a-zA-Z0-9._:/-]+$`).MatchString(c.OpenRouterQualityModel) {
		problems = append(problems, "OPENROUTER_QUALITY_MODEL has unexpected characters")
	}
	if c.OpenRouterStructuredMode != "function" && c.OpenRouterStructuredMode != "json_schema" {
		problems = append(problems, "OPENROUTER_STRUCTURED_MODE must be function or json_schema")
	}
	if c.OpenRouterBaseURL != "" {
		if u, err := url.Parse(c.OpenRouterBaseURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			problems = append(problems, "OPENROUTER_BASE_URL must be an absolute http(s) URL")
		}
	}
	if c.AIRatePerMinute < 1 || c.AIRatePerDay < 1 {
		problems = append(problems, "AI_RATE_PER_MINUTE and AI_RATE_PER_DAY must be positive")
	}
	if c.AIJudge != "off" && c.AIJudge != "shadow" && c.AIJudge != "on" {
		problems = append(problems, "AI_JUDGE must be off, shadow or on")
	}
	if c.AIJudge != "off" && c.TypeSafeAPIKey == "" {
		problems = append(problems, "AI_JUDGE needs TYPESAFE_API_KEY")
	}
	if c.TypeSafeModel == "" || !regexp.MustCompile(`^[a-zA-Z0-9._:/-]+$`).MatchString(c.TypeSafeModel) {
		problems = append(problems, "TYPESAFE_MODEL has unexpected characters")
	}
	if c.TypeSafeBaseURL != "" {
		if u, err := url.Parse(c.TypeSafeBaseURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			problems = append(problems, "TYPESAFE_BASE_URL must be an absolute http(s) URL")
		}
	}
	if c.PprofAddr != "" && !strings.HasPrefix(c.PprofAddr, "127.0.0.1:") && !strings.HasPrefix(c.PprofAddr, "localhost:") {
		problems = append(problems, "PPROF_ADDR must bind loopback")
	}
	if c.PDFWorkers < 1 || c.PDFWorkers > 8 {
		problems = append(problems, "PDF_WORKERS must be between 1 and 8")
	}
	if c.AIConcurrency < 1 || c.AIConcurrency > 64 {
		problems = append(problems, "AI_CONCURRENCY must be between 1 and 64")
	}
	for _, dir := range strings.Split(env("UPLOAD_LEGACY_DIRS", ""), string(filepath.ListSeparator)) {
		if dir = strings.TrimSpace(dir); dir != "" {
			c.UploadLegacyDirs = append(c.UploadLegacyDirs, dir)
		}
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		problems = append(problems, "LOG_LEVEL must be debug, info, warn or error")
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return nil, errors.New("configuration: " + strings.Join(problems, "; "))
	}
	return c, nil
}

// AIAvailable reports whether AI-backed features can run.
func (c *Config) AIAvailable() bool { return c.OpenRouterAPIKey != "" && c.OpenRouterModel != "" }

// JudgeAvailable reports whether the Jev judgment model may be called (shadow or on, with a key).
func (c *Config) JudgeAvailable() bool {
	return c.TypeSafeAPIKey != "" && (c.AIJudge == "shadow" || c.AIJudge == "on")
}

// Secure reports whether cookies must carry the Secure flag.
func (c *Config) Secure() bool { return strings.HasPrefix(c.AppURL, "https:") }

// Development reports whether development-only behaviour (dev routes, fallback secret) is on.
func (c *Config) Development() bool { return c.Env == Development }

// ConfiguredProviders lists the social logins that have credentials, in contract order.
func (c *Config) ConfiguredProviders() []string {
	out := []string{}
	for _, p := range Providers {
		if _, ok := c.OAuth[p]; ok {
			out = append(out, p)
		}
	}
	return out
}

// Redacted is the configuration as it may be logged: every secret is replaced by whether it is set.
func (c *Config) Redacted() map[string]any {
	set := func(v string) string {
		if v == "" {
			return "<unset>"
		}
		return "<set>"
	}
	return map[string]any{
		"env": c.Env, "host": c.Host, "port": c.Port, "appUrl": c.AppURL, "logFormat": c.LogFormat,
		"databaseUrl": set(c.DatabaseURL), "dbInstance": c.DBInstance, "dbUser": c.DBUser, "dbName": c.DBName,
		"dbPassword": set(c.DBPassword), "dbIamAuth": c.DBIAMAuth, "dbIpType": c.DBIPType, "dbPoolMax": c.DBPoolMax,
		"valkeyAddr": c.ValkeyAddr, "valkeyIamAuth": c.ValkeyIAMAuth, "valkeyCaPem": set(c.ValkeyCAPEM), "valkeyTlsServerName": c.ValkeyTLSServerName,
		"valkeyUsername": c.ValkeyUsername, "valkeyPassword": set(c.ValkeyPassword),
		"blobStore": c.BlobStore, "gcsBucket": c.GCSBucket, "staticDir": c.StaticDir,
		"otelExporter": c.OTelExporter, "otelSampleRatio": c.OTelSampleRatio,
		"demoMode": c.DemoMode, "demoAdmin": c.DemoAdmin, "authSecret": set(c.AuthSecret),
		"oauthProviders":   c.ConfiguredProviders(),
		"openRouterApiKey": set(c.OpenRouterAPIKey), "openRouterModel": c.OpenRouterModel, "openRouterEffort": c.OpenRouterEffort, "openRouterQualityModel": c.OpenRouterQualityModel,
		"openRouterProviderOrder": c.OpenRouterProviderOrder, "openRouterBaseUrl": c.OpenRouterBaseURL, "aiRatePerMinute": c.AIRatePerMinute, "aiRatePerDay": c.AIRatePerDay,
		"pdfWorkers": c.PDFWorkers, "aiConcurrency": c.AIConcurrency,
		"typeSafeApiKey": set(c.TypeSafeAPIKey), "typeSafeModel": c.TypeSafeModel, "typeSafeBaseUrl": c.TypeSafeBaseURL, "aiJudge": c.AIJudge,
		"uploadLegacyDirs": c.UploadLegacyDirs, "migrateOnStart": c.MigrateOnStart, "logLevel": c.LogLevel, "googleProject": c.GoogleProject, "trustProxy": c.TrustProxy, "trustedProxies": len(c.TrustedProxies), "pprofAddr": c.PprofAddr,
	}
}

// PaymentMode requires a matching environment pair; incomplete configuration stays unavailable.
func (c *Config) PaymentMode() string {
	if strings.HasPrefix(c.TossClientKey, "live_ck_") && strings.HasPrefix(c.TossSecretKey, "live_sk_") && c.PaymentsLive {
		return "live"
	}
	if c.Development() && strings.HasPrefix(c.TossClientKey, "test_ck_") && strings.HasPrefix(c.TossSecretKey, "test_sk_") && !c.PaymentsLive {
		return "test"
	}
	return "unavailable"
}
