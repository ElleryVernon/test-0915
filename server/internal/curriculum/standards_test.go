package curriculum

import (
	"strings"
	"testing"
	"time"
)

func TestCurriculumCohortAndSourceBoundaries(t *testing.T) {
	now := time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct{ grade, want string }{{"고1", "2022"}, {"고2", "2022"}, {"고3", "2015"}, {"대학생", ""}, {"", ""}} {
		if got := VersionForGrade(tc.grade, now); got != tc.want {
			t.Fatal(tc, got)
		}
	}
	if VersionForGrade("고3", time.Date(2027, 2, 28, 0, 0, 0, 0, time.UTC)) != "2015" || VersionForGrade("고3", time.Date(2027, 3, 1, 0, 0, 0, 0, time.UTC)) != "2022" {
		t.Fatal("academic year boundary")
	}
	query := "신경계와 내분비계는 몸의 항상성을 유지하며 신경 세포의 구조와 기능을 설명한다."
	if len(Retrieve("생명과학", "고2", now, query)) == 0 {
		t.Fatal("relevant biology must match")
	}
	for _, grade := range []string{"고3", "대학생", ""} {
		if len(Retrieve("생명과학", grade, now, query)) != 0 {
			t.Fatal("wrong curriculum mapped", grade)
		}
	}
	if len(Retrieve("대학 생화학", "고2", now, query)) != 0 || len(Retrieve("생명과학", "고2", now, "삼각함수의 미분계수")) != 0 {
		t.Fatal("unrelated scope matched")
	}
	seen := map[string]bool{}
	for _, m := range catalog.Standards {
		code := strings.ReplaceAll(m.Code, "-", "")
		if seen[code] || strings.Contains(m.Text, "�") || m.Document == "" || m.Paragraph == 0 {
			t.Fatal("invalid source", m.Code)
		}
		seen[code] = true
	}
	if len(catalog.Standards) != 1486 {
		t.Fatal("catalog changed; review provenance", len(catalog.Standards))
	}
}
