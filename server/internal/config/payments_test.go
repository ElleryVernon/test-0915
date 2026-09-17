package config

import "testing"

func TestPaymentMode(t *testing.T) {
	for _, tc := range []struct {
		env, ck, sk string
		live        bool
		want        string
	}{
		{Development, "", "", false, "unavailable"},
		{Development, "test_ck_x", "test_sk_x", false, "test"},
		{Production, "test_ck_x", "test_sk_x", false, "unavailable"},
		{Production, "live_ck_x", "live_sk_x", false, "unavailable"},
		{Production, "live_ck_x", "live_sk_x", true, "live"},
		{Development, "test_ck_x", "live_sk_x", false, "unavailable"},
	} {
		c := Config{Env: tc.env, TossClientKey: tc.ck, TossSecretKey: tc.sk, PaymentsLive: tc.live}
		if got := c.PaymentMode(); got != tc.want {
			t.Fatalf("got %s want %s", got, tc.want)
		}
	}
}
