// Package schools provides a versioned, official NEIS directory without runtime network dependencies.
package schools

import (
	_ "embed"
	"encoding/json"
	"sort"
	"strings"
)

//go:embed directory.json
var raw []byte

type School struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Address  string `json:"address"`
	Province string `json:"province"`
}

var all = func() []School {
	var rows []School
	if err := json.Unmarshal(raw, &rows); err != nil {
		panic(err)
	}
	return rows
}()

func Find(id string) (School, bool) {
	for _, s := range all {
		if s.ID == id {
			return s, true
		}
	}
	return School{}, false
}
func Search(query string) []School {
	result := []School{}
	words := strings.Fields(strings.ToLower(query))
	for _, s := range all {
		text := strings.ToLower(s.Name + " " + s.Address)
		match := true
		for _, word := range words {
			if !strings.Contains(text, word) {
				match = false
				break
			}
		}
		if match {
			result = append(result, s)

		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		score := func(s School) int {
			n := strings.ToLower(s.Name)
			q := strings.ToLower(strings.TrimSpace(query))
			if n == q {
				return 3
			}
			if strings.HasPrefix(n, q) {
				return 2
			}
			if strings.Contains(n, q) {
				return 1
			}
			return 0
		}
		return score(result[i]) > score(result[j])
	})
	if len(result) > 30 {
		result = result[:30]
	}
	return result
}

// Identity keeps same-name schools separate in legacy text-based community scoping.
func (s School) Identity() string { return s.Name + " · " + s.Address }
