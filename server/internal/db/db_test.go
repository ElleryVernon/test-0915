package db

import "testing"

func TestSpanName(t *testing.T) {
	cases := map[string]string{
		"-- name: ListSubjectsWithCounts :many\nSELECT s.* FROM \"Subject\" s": "ListSubjectsWithCounts",
		"SELECT 1":                   "SELECT",
		"  insert into x values (1)": "INSERT",
		"-- a comment only":          "query",
		"":                           "query",
	}
	for stmt, want := range cases {
		if got := SpanName(stmt); got != want {
			t.Errorf("SpanName(%q) = %q, want %q", stmt, got, want)
		}
	}
}
