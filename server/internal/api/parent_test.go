package api

import (
	"regexp"
	"strconv"
	"testing"
	"time"
)

// The week starts Monday 00:00 in Korea; the arithmetic is the previous server's, so a request
// late Sunday night in Seoul still belongs to the week that is ending.
func TestWeekStart(t *testing.T) {
	cases := []struct{ now, want string }{
		{"2026-09-15T23:30:00Z", "2026-09-13T15:00:00Z"}, // Wed 08:30 Seoul → Mon Sep 14 00:00 Seoul
		{"2026-09-20T14:59:59Z", "2026-09-13T15:00:00Z"}, // Sun 23:59:59 Seoul, still that week
		{"2026-09-20T15:00:00Z", "2026-09-20T15:00:00Z"}, // Mon 00:00 Seoul is its own start
		{"2026-09-13T14:59:59Z", "2026-09-06T15:00:00Z"}, // Sun 23:59:59 Seoul
		{"2026-10-01T00:00:00Z", "2026-09-27T15:00:00Z"}, // Thu Oct 1 09:00 Seoul → Mon Sep 28 Seoul
		{"2026-01-01T10:00:00Z", "2025-12-28T15:00:00Z"}, // Thu Jan 1 19:00 Seoul → Mon Dec 29 Seoul
	}
	for _, c := range cases {
		now, err := time.Parse(time.RFC3339, c.now)
		if err != nil {
			t.Fatal(err)
		}
		if got := weekStart(now).Format(time.RFC3339); got != c.want {
			t.Errorf("weekStart(%s) = %s, want %s", c.now, got, c.want)
		}
	}
	// A clock in the machine's zone gives the same instant as the UTC clock.
	seoul := time.FixedZone("KST", 9*3600)
	if got, want := weekStart(time.Date(2026, 9, 16, 8, 30, 0, 0, seoul)), weekStart(time.Date(2026, 9, 15, 23, 30, 0, 0, time.UTC)); !got.Equal(want) {
		t.Errorf("zone changed the week start: %s vs %s", got, want)
	}
}

func TestInviteCodeShape(t *testing.T) {
	shape := regexp.MustCompile(`^[1-9]\d{5}$`)
	for i := 0; i < 2000; i++ {
		code, err := inviteCode()
		if err != nil {
			t.Fatal(err)
		}
		if !shape.MatchString(code) || !codeShape.MatchString(code) {
			t.Fatalf("code %q is not six digits from 100000", code)
		}
		if n, _ := strconv.Atoi(code); n < 100000 || n > 999999 {
			t.Fatalf("code %q outside the range", code)
		}
	}
}
