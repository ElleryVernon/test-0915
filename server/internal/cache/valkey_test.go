package cache

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/valkey-io/valkey-go"
	"golang.org/x/oauth2"
)

// TestValkey runs the driver against a real `valkey/valkey:8` container the way the cloud instance
// is reached: TLS with server authentication against a private CA, and a password that a token
// source hands to every connection (Memorystore IAM authentication uses the same AUTH shape).
// It needs Docker; without it the test is skipped, and the ledger check names that as a failure.
func TestValkey(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker is not installed")
	}
	if err := exec.Command("docker", "info").Run(); err != nil {
		t.Skip("docker is not running")
	}
	dir := t.TempDir()
	caPEM := writeTLSMaterial(t, dir)
	port := freePort(t)
	const password = "integration-token-1"
	// Memorystore's IAM authentication is `AUTH <access token>` on the default user; the ACL here
	// gives the default user exactly that password and nothing works without it.
	acl := "user default on >" + password + " ~* &* +@all\n"
	if err := os.WriteFile(filepath.Join(dir, "users.acl"), []byte(acl), 0o644); err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("memoryz-valkey-test-%d", time.Now().UnixNano())
	run := exec.Command("docker", "run", "-d", "--rm", "--name", name,
		"-p", fmt.Sprintf("127.0.0.1:%d:6379", port), "-v", dir+":/tls:ro", "valkey/valkey:8",
		"valkey-server", "--port", "0", "--tls-port", "6379", "--tls-cert-file", "/tls/server.crt", "--tls-key-file", "/tls/server.key",
		"--tls-ca-cert-file", "/tls/ca.crt", "--tls-auth-clients", "no", "--aclfile", "/tls/users.acl")
	if out, err := run.CombinedOutput(); err != nil {
		t.Fatalf("docker run: %v\n%s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })

	var calls atomic.Int32
	source := oauth2.StaticTokenSource(&oauth2.Token{AccessToken: password, Expiry: time.Now().Add(time.Hour)})
	counting := oauth2.TokenSource(countingSource{source: source, calls: &calls})
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var v *Valkey
	var err error
	for deadline := time.Now().Add(45 * time.Second); time.Now().Before(deadline); {
		v, err = NewValkey(ctx, ValkeyOptions{Addr: fmt.Sprintf("127.0.0.1:%d", port), CAPEM: caPEM, ServerName: "localhost", TokenSource: counting})
		if err == nil {
			break
		}
		// Only "not listening yet" is worth waiting for; an authentication or TLS error is final.
		if msg := err.Error(); !strings.Contains(msg, "connection refused") && !strings.Contains(msg, "EOF") && !strings.Contains(msg, "reset by peer") {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer v.Close()
	if calls.Load() == 0 {
		t.Fatal("the token source was never asked for credentials")
	}
	if _, err := NewValkey(ctx, ValkeyOptions{Addr: fmt.Sprintf("127.0.0.1:%d", port), CAPEM: caPEM, ServerName: "localhost"}); err == nil {
		t.Fatal("a connection without credentials must be refused by the ACL")
	}
	if _, err := NewValkey(ctx, ValkeyOptions{Addr: fmt.Sprintf("127.0.0.1:%d", port), CAPEM: caPEM, ServerName: "wrong.example", TokenSource: counting}); err == nil {
		t.Fatal("a server name that the certificate does not carry must fail the handshake")
	}

	if err := v.Set(ctx, "k", []byte("v"), time.Minute); err != nil {
		t.Fatal(err)
	}
	if got, ok, err := v.Get(ctx, "k"); err != nil || !ok || string(got) != "v" {
		t.Fatalf("get: %q %v %v", got, ok, err)
	}
	if _, ok, err := v.Get(ctx, "missing"); err != nil || ok {
		t.Fatalf("missing key: %v %v", ok, err)
	}
	if n, left, err := v.Incr(ctx, "count", time.Minute); err != nil || n != 1 || left <= 59*time.Second || left > time.Minute {
		t.Fatalf("incr: %d %v %v", n, left, err)
	}
	if n, left, err := v.Incr(ctx, "count", time.Minute); err != nil || n != 2 || left > time.Minute {
		t.Fatalf("incr again: %d %v %v", n, left, err)
	}
	// The window really expires: its time left decays (a key the script never gave an expiry would
	// report the full window forever, and the limit would never reset).
	time.Sleep(20 * time.Millisecond)
	if n, left, err := v.Incr(ctx, "count", time.Minute); err != nil || n != 3 || left > time.Minute-15*time.Millisecond {
		t.Fatalf("the window decays: %d %v %v", n, left, err)
	}
	// A counter key without an expiry heals to a full window in the same atomic step.
	if err := v.Set(ctx, "stuck", []byte("7"), 0); err != nil {
		t.Fatal(err)
	}
	if n, left, err := v.Incr(ctx, "stuck", time.Minute); err != nil || n != 8 || left <= 59*time.Second {
		t.Fatalf("heal: %d %v %v", n, left, err)
	}
	// The version bump script: floor for a missing key, +1 above it, restart at the floor for junk.
	if s, err := v.Bump(ctx, "ver", 1000, time.Hour); err != nil || s != "1000" {
		t.Fatalf("bump missing: %q %v", s, err)
	}
	if s, err := v.Bump(ctx, "ver", 900, time.Hour); err != nil || s != "1001" {
		t.Fatalf("bump above floor: %q %v", s, err)
	}
	if err := v.Set(ctx, "odd", []byte("01H8XGJWBWBAQ4Z4"), time.Hour); err != nil {
		t.Fatal(err)
	}
	if s, err := v.Bump(ctx, "odd", 5, time.Hour); err != nil || s != "5" {
		t.Fatalf("bump junk: %q %v", s, err)
	}
	release, ok, err := v.Lock(ctx, "lease", time.Minute)
	if err != nil || !ok {
		t.Fatalf("lock: %v %v", ok, err)
	}
	if _, again, err := v.Lock(ctx, "lease", time.Minute); err != nil || again {
		t.Fatalf("a held lease must not be granted twice: %v %v", again, err)
	}
	release()
	if _, after, err := v.Lock(ctx, "lease", time.Minute); err != nil || !after {
		t.Fatalf("a released lease is free: %v %v", after, err)
	}
	if err := v.Del(ctx, "k", "count"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := v.Get(ctx, "k"); ok {
		t.Fatal("deleted key still present")
	}
	if err := v.Set(ctx, "keep", []byte("x"), time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := v.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := v.Get(ctx, "keep"); ok {
		t.Fatal("flush must drop every key")
	}
	if err := v.Set(ctx, "short", []byte("x"), 50*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	time.Sleep(120 * time.Millisecond)
	if _, ok, _ := v.Get(ctx, "short"); ok {
		t.Fatal("a key past its ttl is gone")
	}
	// Credential refresh: the callback recomputes the refresh time from the token's expiry.
	creds, err := IAMCredentials(oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "t", Expiry: time.Now().Add(20 * time.Minute)}))(valkey.AuthCredentialsContext{})
	if err != nil || creds.Password != "t" || time.Until(creds.RefreshAfter) > 16*time.Minute || time.Until(creds.RefreshAfter) < 14*time.Minute {
		t.Fatalf("refresh five minutes before expiry: %+v %v", creds, err)
	}
	if strings.TrimSpace(v.Name()) != fmt.Sprintf("valkey:127.0.0.1:%d", port) {
		t.Fatalf("name: %s", v.Name())
	}
	fmt.Println("VALKEY_INTEGRATION_OK")
}

type countingSource struct {
	source oauth2.TokenSource
	calls  *atomic.Int32
}

func (c countingSource) Token() (*oauth2.Token, error) {
	c.calls.Add(1)
	return c.source.Token()
}

// writeTLSMaterial creates a CA and a server certificate for localhost/127.0.0.1 and returns the CA PEM.
func writeTLSMaterial(t *testing.T, dir string) string {
	t.Helper()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "memoryz test ca"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	serverKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	serverTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "localhost"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
	}
	serverDER, err := x509.CreateCertificate(rand.Reader, serverTemplate, caTemplate, &serverKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	serverKeyDER, _ := x509.MarshalECPrivateKey(serverKey)
	files := map[string][]byte{
		"ca.crt":     caPEM,
		"server.crt": pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: serverDER}),
		"server.key": pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: serverKeyDER}),
	}
	for name, data := range files {
		// The container's valkey user must be able to read the key.
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return string(caPEM)
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// TestOpDeadline pauses a real Valkey mid-connection: every operation must give up at the 250 ms
// operation deadline (so the request falls back to Postgres) instead of hanging for the request's.
func TestOpDeadline(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker is not installed")
	}
	if err := exec.Command("docker", "info").Run(); err != nil {
		t.Skip("docker is not running")
	}
	port := freePort(t)
	name := fmt.Sprintf("memoryz-valkey-deadline-%d", time.Now().UnixNano())
	if out, err := exec.Command("docker", "run", "-d", "--rm", "--name", name, "-p", fmt.Sprintf("127.0.0.1:%d:6379", port), "valkey/valkey:8").CombinedOutput(); err != nil {
		t.Fatalf("docker run: %v\n%s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })
	ctx := context.Background()
	var v *Valkey
	var err error
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); time.Sleep(300 * time.Millisecond) {
		if v, err = NewValkey(ctx, ValkeyOptions{Addr: fmt.Sprintf("127.0.0.1:%d", port)}); err == nil {
			break
		}
	}
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer v.Close()
	if err := v.Set(ctx, "k", []byte("v"), time.Minute); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("docker", "pause", name).CombinedOutput(); err != nil {
		t.Fatalf("docker pause: %v\n%s", err, out)
	}
	defer func() { _ = exec.Command("docker", "unpause", name).Run() }()
	parent, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for _, op := range []struct {
		name string
		run  func() error
	}{
		{"get", func() error { _, _, err := v.Get(parent, "k"); return err }},
		{"set", func() error { return v.Set(parent, "k", []byte("w"), time.Minute) }},
		{"incr", func() error { _, _, err := v.Incr(parent, "c", time.Minute); return err }},
		{"bump", func() error { _, err := v.Bump(parent, "ver", 1, time.Minute); return err }},
		{"del", func() error { return v.Del(parent, "k") }},
	} {
		started := time.Now()
		err := op.run()
		took := time.Since(started)
		t.Logf("%s gave up after %v: %v", op.name, took, err)
		// The deadline is 250 ms; the slack covers scheduling, not a second deadline.
		if err == nil || took < 240*time.Millisecond || took > 450*time.Millisecond {
			t.Fatalf("%s on a paused Valkey: err=%v after %v (want an error at about 250 ms)", op.name, err, took)
		}
	}
}
