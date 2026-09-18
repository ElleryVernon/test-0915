// Package curriculum retrieves a versioned subset of official achievement standards.
// These learning objectives are never material evidence or proof of student mastery.
package curriculum

import (
	_ "embed"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

//go:embed standards-2022.json
var raw []byte

type Match struct {
	Code      string `json:"code"`
	Course    string `json:"course"`
	Text      string `json:"text"`
	Document  string `json:"document"`
	Paragraph int    `json:"paragraph"`
	Source    string `json:"source"`
}
type Catalog struct {
	Version   string  `json:"version"`
	Notice    string  `json:"notice"`
	Source    string  `json:"source"`
	Standards []Match `json:"standards"`
}

var catalog = func() Catalog {
	var c Catalog
	if err := json.Unmarshal(raw, &c); err != nil {
		panic(err)
	}
	return c
}()

func VersionForGrade(grade string, at time.Time) string {
	grade = strings.ReplaceAll(strings.TrimSpace(grade), " ", "")
	n := map[string]int{"고1": 1, "고2": 2, "고3": 3, "고등학교1학년": 1, "고등학교2학년": 2, "고등학교3학년": 3}[grade]
	if n == 0 {
		return ""
	}
	kst := time.FixedZone("KST", 9*3600)
	at = at.In(kst)
	year := at.Year()
	if at.Month() < time.March {
		year--
	}
	if year-n+1 >= 2025 {
		return "2022"
	}
	return "2015"
}
func normalize(s string) string {
	s = strings.NewReplacer("Ⅰ", "I", "Ⅱ", "II", "Ⅲ", "III").Replace(s)
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return unicode.ToLower(r)
	}, s)
}

var words = regexp.MustCompile(`[가-힣A-Za-z]{2,}`)
var stop = map[string]bool{"있는": true, "통해": true, "대한": true, "이를": true, "또는": true, "위해": true, "대해": true, "이해하고": true, "설명할": true, "설명한다": true, "있다": true, "관련된": true}

// Retrieve requires the exact course and a supported cohort. At least two meaningful
// lexical concepts must overlap; ambiguous/no-match cases stay empty, never guessed.
func Retrieve(course, grade string, at time.Time, query string) []Match {
	result := []Match{}
	if VersionForGrade(grade, at) != "2022" {
		return result
	}
	query = strings.ToLower(query)
	type scored struct {
		m     Match
		score int
	}
	found := []scored{}
	for _, m := range catalog.Standards {
		if normalize(m.Course) != normalize(course) {
			continue
		}
		seen := map[string]bool{}
		score := 0
		for _, word := range words.FindAllString(m.Text, -1) {
			word = strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(word, "을"), "를"), "의")
			if len([]rune(word)) < 2 || stop[word] || seen[word] {
				continue
			}
			seen[word] = true
			if strings.Contains(query, strings.ToLower(word)) {
				score++
			}
		}
		if score >= 2 {
			m.Source = catalog.Source
			found = append(found, scored{m, score})
		}
	}
	sort.SliceStable(found, func(i, j int) bool {
		if found[i].score != found[j].score {
			return found[i].score > found[j].score
		}
		return found[i].m.Code < found[j].m.Code
	})
	for i, f := range found {
		if i >= 3 {
			break
		}
		result = append(result, f.m)
	}
	return result
}
