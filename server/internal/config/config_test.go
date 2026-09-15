package config

import (
	"strings"
	"testing"
)

func lookup(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		v, ok := values[key]
		return v, ok
	}
}

func TestLoadDevelopmentDefaults(t *testing.T) {
	c, err := Load(lookup(map[string]string{"DATABASE_URL": "postgres://u:p@127.0.0.1:15444/memoryz"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 8080 || c.AppURL != "http://127.0.0.1:8080" || c.BlobStore != "pg" || c.DBPoolMax != 6 {
		t.Fatalf("unexpected defaults: %+v", c)
	}
	if c.AuthSecret != devSecret || len(c.Warnings) != 1 {
		t.Fatalf("development fallback secret expected, got warnings %v", c.Warnings)
	}
	if c.AIAvailable() || c.Secure() {
		t.Fatal("no AI key and no https expected")
	}
}

func TestLoadProductionRequiresSecrets(t *testing.T) {
	_, err := Load(lookup(map[string]string{"ENV": "production", "PORT": "8080"}))
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"DATABASE_URL", "APP_URL", "AUTH_SECRET"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error should name %s: %v", want, err)
		}
	}
}

func TestLoadCloudSQL(t *testing.T) {
	c, err := Load(lookup(map[string]string{
		"ENV": "production", "APP_URL": "https://memoryz.example/", "AUTH_SECRET": strings.Repeat("x", 40),
		"DB_INSTANCE": "memoryz-prod:asia-northeast3:memoryz-pg", "DB_USER": "memoryz-run@memoryz-prod.iam", "DB_IAM_AUTH": "true",
		"BLOB_STORE": "gcs", "GCS_BUCKET": "memoryz-prod-uploads", "GOOGLE_CLIENT_ID": "id", "GOOGLE_CLIENT_SECRET": "secret",
		"OPENROUTER_PROVIDER_ORDER": "amazon-bedrock/us-east-1, openai/fast",
		"VALKEY_ADDR":               "10.178.0.2:6379", "VALKEY_CA_PEM": "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.AppURL != "https://memoryz.example" || !c.Secure() || c.ConfiguredProviders()[0] != "google" {
		t.Fatalf("unexpected: %+v", c)
	}
	if got := c.Redacted(); got["authSecret"] != "<set>" || got["databaseUrl"] != "<unset>" {
		t.Fatalf("redaction: %v", got)
	}
	if c.GoogleProject != "memoryz-prod" || c.OTelExporter != "gcp" || c.OTelSampleRatio != 1 {
		t.Fatalf("production telemetry defaults: project=%q exporter=%q ratio=%v", c.GoogleProject, c.OTelExporter, c.OTelSampleRatio)
	}
}

func TestLoadValkeyCloud(t *testing.T) {
	base := map[string]string{
		"ENV": "production", "APP_URL": "https://memoryz.example", "AUTH_SECRET": strings.Repeat("x", 40),
		"DB_INSTANCE": "memoryz-prod:asia-northeast3:memoryz-pg", "DB_USER": "memoryz-run@memoryz-prod.iam", "DB_IAM_AUTH": "true",
		"VALKEY_ADDR": "10.178.0.2:6379", "VALKEY_CA_PEM": "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
	}
	c, err := Load(lookup(base))
	if err != nil {
		t.Fatal(err)
	}
	if !c.ValkeyIAMAuth {
		t.Fatal("production defaults to IAM authentication for Memorystore")
	}
	if got := c.Redacted(); got["valkeyCaPem"] != "<set>" || got["valkeyPassword"] != "<unset>" {
		t.Fatalf("redaction: %v", got)
	}
	withPassword := map[string]string{}
	for k, v := range base {
		withPassword[k] = v
	}
	withPassword["VALKEY_PASSWORD"] = "secret"
	if c, err := Load(lookup(withPassword)); err != nil || c.ValkeyIAMAuth {
		t.Fatalf("a static password turns IAM off: %v %v", err, c)
	}
}

func TestLoadTrustedProxies(t *testing.T) {
	c, err := Load(lookup(map[string]string{"DATABASE_URL": "postgres://x", "TRUSTED_PROXIES": " 136.110.129.207 , 35.191.0.0/16,,2001:db8::1"}))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"136.110.129.207/32", "35.191.0.0/16", "2001:db8::1/128"}
	if len(c.TrustedProxies) != len(want) {
		t.Fatalf("trusted proxies: %v", c.TrustedProxies)
	}
	for i, p := range c.TrustedProxies {
		if p.String() != want[i] {
			t.Fatalf("trusted proxies: %v", c.TrustedProxies)
		}
	}
}

func TestLoadRejectsBadValues(t *testing.T) {
	cases := map[string]map[string]string{
		"bad pool":      {"DATABASE_URL": "postgres://x", "DB_POOL_MAX": "0"},
		"bad store":     {"DATABASE_URL": "postgres://x", "BLOB_STORE": "s3"},
		"gcs no bucket": {"DATABASE_URL": "postgres://x", "BLOB_STORE": "gcs"},
		"short secret":  {"DATABASE_URL": "postgres://x", "AUTH_SECRET": "short"},
		"bad provider":  {"DATABASE_URL": "postgres://x", "OPENROUTER_PROVIDER_ORDER": "Bad Provider!"},
		"bad url":       {"DATABASE_URL": "mysql://x"},
		"bad exporter":  {"DATABASE_URL": "postgres://x", "OTEL_EXPORTER": "jaeger"},
		"bad ratio":     {"DATABASE_URL": "postgres://x", "OTEL_SAMPLE_RATIO": "1.5"},
		"bad proxy":     {"DATABASE_URL": "postgres://x", "TRUSTED_PROXIES": "136.110.129.207,lb"},
		"gcp no project": {
			"DATABASE_URL": "postgres://x", "OTEL_EXPORTER": "gcp",
		},
		"valkey no port": {"DATABASE_URL": "postgres://x", "VALKEY_ADDR": "10.178.0.2"},
		"valkey plain in production": {
			"ENV": "production", "APP_URL": "https://memoryz.example", "AUTH_SECRET": strings.Repeat("x", 40),
			"DATABASE_URL": "postgres://x", "GOOGLE_CLOUD_PROJECT": "p", "VALKEY_ADDR": "10.178.0.2:6379",
		},
		"production without valkey": {
			"ENV": "production", "APP_URL": "https://memoryz.example", "AUTH_SECRET": strings.Repeat("x", 40),
			"DATABASE_URL": "postgres://x", "GOOGLE_CLOUD_PROJECT": "p",
		},
		"valkey iam and password": {"DATABASE_URL": "postgres://x", "VALKEY_ADDR": "127.0.0.1:6379", "VALKEY_IAM_AUTH": "true", "VALKEY_PASSWORD": "x"},
	}
	for name, values := range cases {
		if _, err := Load(lookup(values)); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}
