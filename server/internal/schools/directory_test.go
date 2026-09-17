package schools

import "testing"

func TestDirectory(t *testing.T) {
	if len(all) < 2000 {
		t.Fatal("incomplete")
	}
	ids := map[string]bool{}
	for _, s := range all {
		if s.ID == "" || s.Name == "" || s.Address == "" || ids[s.ID] {
			t.Fatal("invalid", s)
		}
		ids[s.ID] = true
	}
	if Search("가락")[0].Name != "가락고등학교" {
		t.Fatal("name match should precede address match")
	}
	if len(Search("서울 송파 가락")) != 1 {
		t.Fatal("regional search")
	}
	if _, ok := Find("fake"); ok {
		t.Fatal("invalid lookup")
	}
}
