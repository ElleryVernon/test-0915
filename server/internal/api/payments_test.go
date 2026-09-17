package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"memoryz/server/internal/config"
)

type paymentRoundTrip func(*http.Request) (*http.Response, error)

func (f paymentRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestPointTopupVerifiedExactlyOnce(t *testing.T) {
	h := newAIHarness(t, func(c *config.Config) { c.TossClientKey = "test_ck_fixture"; c.TossSecretKey = "test_sk_fixture" })
	ctx := context.Background()
	if _, err := h.pool.Exec(ctx, `UPDATE "User" SET "role"='PARENT',"points"=0 WHERE "id"=$1`, h.student); err != nil {
		t.Fatal(err)
	}
	h.s.auth.Invalidate(ctx, h.student)
	body := map[string]any{"amount": 5000, "requestId": "payment-request-0001"}
	r := h.do("POST", "/api/points/orders", body)
	if r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	var envelope struct {
		Data struct {
			Order topup `json:"order"`
		} `json:"data"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	order := envelope.Data.Order
	again := h.do("POST", "/api/points/orders", body)
	if !strings.Contains(again.Body.String(), order.ID) {
		t.Fatal("create was not idempotent")
	}
	body["amount"] = 6000
	if got := h.do("POST", "/api/points/orders", body); got.Code != 409 {
		t.Fatal("changed amount accepted", got.Code)
	}
	confirm := map[string]any{"orderId": order.ID, "amount": 5000, "paymentKey": "test-payment-key-001"}
	confirm["amount"] = 1
	if got := h.do("POST", "/api/points/confirm", confirm); got.Code != 400 {
		t.Fatal("tampered amount accepted", got.Code)
	}
	confirm["amount"] = 5000
	var mu sync.Mutex
	postCalls := 0
	badResponse := true
	h.s.paymentHTTP = &http.Client{Transport: paymentRoundTrip(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Host != "api.tosspayments.com" {
			t.Errorf("unexpected provider")
		}
		key, pass, ok := r.BasicAuth()
		if !ok || key != "test_sk_fixture" || pass != "" {
			t.Errorf("bad auth")
		}
		if r.Method == "POST" {
			postCalls++
			if r.Header.Get("Idempotency-Key") != order.ID {
				t.Errorf("missing stable idempotency key")
			}
		}
		amount := 5000
		if badResponse {
			amount = 1
		}
		raw := fmt.Sprintf(`{"paymentKey":"test-payment-key-001","orderId":%q,"status":"DONE","totalAmount":%d,"currency":"KRW"}`, order.ID, amount)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(raw)), Header: http.Header{}}, nil
	})}
	if got := h.do("POST", "/api/points/confirm", confirm); got.Code != 503 {
		t.Fatal("unverified provider result accepted", got.Code)
	}
	var points int
	_ = h.pool.QueryRow(ctx, `SELECT "points" FROM "User" WHERE "id"=$1`, h.student).Scan(&points)
	if points != 0 {
		t.Fatal("credited without verified amount")
	}
	mu.Lock()
	badResponse = false
	mu.Unlock()
	// Browser retry, concurrent callback, and read-only recovery all converge on one credit.
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Go(func() {
			got := h.do("POST", "/api/points/confirm", confirm)
			if got.Code != 200 && got.Code != 409 {
				t.Errorf("confirm: %d %s", got.Code, got.Body.String())
			}
		})
	}
	wg.Wait()
	if got := h.do("POST", "/api/points/orders/"+order.ID+"/check", map[string]any{}); got.Code != 200 {
		t.Fatal(got.Code)
	}
	_ = h.pool.QueryRow(ctx, `SELECT "points" FROM "User" WHERE "id"=$1`, h.student).Scan(&points)
	if points != 5000 {
		t.Fatalf("expected 5000 points got %d", points)
	}
	confirm["paymentKey"] = "another-payment-key"
	if got := h.do("POST", "/api/points/confirm", confirm); got.Code != 409 {
		t.Fatal("changed key accepted", got.Code)
	}
	confirm["orderId"] = "other-owner-order"
	if got := h.do("POST", "/api/points/confirm", confirm); got.Code != 404 {
		t.Fatal("order ownership check", got.Code)
	}
}
func TestPointTopupPermissionsAndConfig(t *testing.T) {
	h := newAIHarness(t, nil)
	if r := h.do("GET", "/api/points", nil); r.Code != 403 {
		t.Fatal("student wallet access", r.Code)
	}
	_, err := h.pool.Exec(context.Background(), `UPDATE "User" SET "role"='PARENT' WHERE "id"=$1`, h.student)
	if err != nil {
		t.Fatal(err)
	}
	h.s.auth.Invalidate(context.Background(), h.student)
	if r := h.do("POST", "/api/points/orders", map[string]any{"amount": 5000, "requestId": "payment-request-0002"}); r.Code != 503 {
		t.Fatal("unconfigured payment", r.Code)
	}
	if r := h.do("GET", "/api/points", nil); r.Code != 200 || !strings.Contains(r.Body.String(), `"mode":"unavailable"`) {
		t.Fatal(r.Code, r.Body.String())
	}
}

func TestPointTopupRecoveryAndTerminalFailure(t *testing.T) {
	h := newAIHarness(t, func(c *config.Config) { c.TossClientKey = "test_ck_fixture"; c.TossSecretKey = "test_sk_fixture" })
	_, err := h.pool.Exec(context.Background(), `UPDATE "User" SET "role"='PARENT',"points"=0 WHERE "id"=$1`, h.student)
	if err != nil {
		t.Fatal(err)
	}
	h.s.auth.Invalidate(context.Background(), h.student)
	rec := h.do("POST", "/api/points/orders", map[string]any{"amount": 1000, "requestId": "recover-topup-001"})
	var env struct {
		Data struct {
			Order topup `json:"order"`
		} `json:"data"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &env)
	id := env.Data.Order.ID
	mode := "timeout"
	h.s.paymentHTTP = &http.Client{Transport: paymentRoundTrip(func(r *http.Request) (*http.Response, error) {
		if mode == "timeout" {
			return nil, fmt.Errorf("simulated connection loss")
		}
		if r.Method != "GET" {
			t.Error("recovery must not approve or charge")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(fmt.Sprintf(`{"paymentKey":"recover-key-001","orderId":%q,"status":%q,"totalAmount":1000,"currency":"KRW"}`, id, mode)))}, nil
	})}
	if got := h.do("POST", "/api/points/confirm", map[string]any{"orderId": id, "amount": 1000, "paymentKey": "recover-key-001"}); got.Code != 503 {
		t.Fatal(got.Code)
	}
	if got := h.do("POST", "/api/points/orders", map[string]any{"amount": 1000, "requestId": "recover-topup-002"}); got.Code != 409 {
		t.Fatal("new payment while unresolved", got.Code)
	}
	mode = "EXPIRED"
	if got := h.do("POST", "/api/points/orders/"+id+"/check", map[string]any{}); got.Code != 409 || !strings.Contains(got.Body.String(), "PAYMENT_FAILED") {
		t.Fatal(got.Code, got.Body.String())
	}
	o, err := h.s.ownedTopup(context.Background(), id, h.student)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.s.settleTopup(context.Background(), h.student, o, tossPayment{PaymentKey: "recover-key-001", OrderID: id, Status: "DONE", TotalAmount: 1000, Currency: "KRW"}); err == nil {
		t.Fatal("stale approval after terminal failure reported success")
	}
	var points int
	_ = h.pool.QueryRow(context.Background(), `SELECT "points" FROM "User" WHERE "id"=$1`, h.student).Scan(&points)
	if points != 0 {
		t.Fatal("failed credited")
	}
}
func TestLiveTopupRejectsSharedDemo(t *testing.T) {
	h := newAIHarness(t, func(c *config.Config) {
		c.TossClientKey = "live_ck_fixture"
		c.TossSecretKey = "live_sk_fixture"
		c.PaymentsLive = true
	})
	demo := commentActor(t, h, "demo-parent", "PARENT")
	if r := demo.do("POST", "/api/points/orders", map[string]any{"amount": 1000, "requestId": "shared-demo-0001"}); r.Code != 503 {
		t.Fatal("live charge allowed on shared account", r.Code)
	}
}
