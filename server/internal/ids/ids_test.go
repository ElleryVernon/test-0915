package ids

import (
	"regexp"
	"testing"
)

func TestNewIsUniqueAndOrdered(t *testing.T) {
	pattern := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	seen := map[string]bool{}
	var previous string
	for i := 0; i < 1000; i++ {
		id := New()
		if !pattern.MatchString(id) {
			t.Fatalf("not a v7 uuid: %s", id)
		}
		if seen[id] {
			t.Fatalf("duplicate id %s", id)
		}
		seen[id] = true
		if previous != "" && id[:13] < previous[:13] {
			t.Fatalf("ids should not go backwards in time: %s after %s", id, previous)
		}
		previous = id
	}
}

func TestTokenLength(t *testing.T) {
	if got := Token(32); len(got) != 64 || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(got) {
		t.Fatalf("token: %q", got)
	}
	if a, b := Token(8), Token(8); a == b {
		t.Fatal("tokens should differ")
	}
}
