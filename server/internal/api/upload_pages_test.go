package api

import "testing"

func TestRequestedPDFPages(t *testing.T) {
	pages, err := requestedPDFPages("2,5,9", "application/pdf")
	if err != nil || len(pages) != 3 || pages[1] != 5 {
		t.Fatalf("%v %v", pages, err)
	}
	for _, raw := range []string{"", "0", "-1", "2,2", "3,2", "1-3", "1, 2", "01", "+1", "10001", "1,2,3,4,5,6,7,8,9,10,11,12,13"} {
		if _, err := requestedPDFPages(raw, "application/pdf"); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
	if _, err := requestedPDFPages("1", "image/png"); err == nil {
		t.Fatal("accepted non-PDF")
	}
}
