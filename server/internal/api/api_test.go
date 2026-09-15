package api

import (
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestClientIP(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.9:4321"
	r.Header.Set("X-Forwarded-For", "203.0.113.7, 198.51.100.2")
	if got, hop, _ := clientAddr(r, false, nil); got != "10.0.0.9" || hop != -1 {
		t.Fatalf("without a trusted proxy the socket peer counts: %s %d", got, hop)
	}
	// Cloud Run appends the real client after anything the client sent: the forgeable first entry
	// must never win.
	if got, hop, entries := clientAddr(r, true, nil); got != "198.51.100.2" || hop != 0 || entries != 2 {
		t.Fatalf("behind Cloud Run alone the last entry is the client: %s %d %d", got, hop, entries)
	}
	// Behind the load balancer: <client's claim>,<client>,<forwarding rule>. The rule's address is
	// skipped, and the claim still never wins.
	lb := []netip.Prefix{netip.MustParsePrefix("136.110.129.207/32")}
	r.Header.Set("X-Forwarded-For", "203.0.113.7,198.51.100.2,136.110.129.207")
	if got, hop, entries := clientAddr(r, true, lb); got != "198.51.100.2" || hop != 1 || entries != 3 {
		t.Fatalf("behind the load balancer the entry before its address is the client: %s %d %d", got, hop, entries)
	}
	if got, _, _ := clientAddr(r, true, nil); got != "136.110.129.207" {
		t.Fatalf("control: without the trusted list every user would share the balancer's address: %s", got)
	}
	r.Header.Set("X-Forwarded-For", "198.51.100.2, 136.110.129.207")
	if got, _, _ := clientAddr(r, true, lb); got != "198.51.100.2" {
		t.Fatalf("no claim: %s", got)
	}
	r.Header.Set("X-Forwarded-For", "136.110.129.207")
	if got, hop, _ := clientAddr(r, true, lb); got != "10.0.0.9" || hop != -1 {
		t.Fatalf("only trusted entries fall back to the peer: %s %d", got, hop)
	}
	r.Header.Set("X-Forwarded-For", "")
	if got, _, _ := clientAddr(r, true, lb); got != "10.0.0.9" {
		t.Fatalf("empty header falls back to the peer: %s", got)
	}
}
