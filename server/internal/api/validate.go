package api

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"memoryz/server/internal/apierr"
	"memoryz/server/internal/planner"
)

// The previous server validated with zod; these helpers keep its shapes and its Korean messages.
// A field that fails a bound without a dedicated message answers the generic 400 (zod's English
// default is not part of the contract the client shows).
const (
	msgInput    = "입력값을 확인해 주세요."
	msgRequired = "내용을 입력해 주세요."
	msgDate     = "올바른 날짜를 입력해 주세요."
	msgTime     = "시간 형식을 확인해 주세요."
)

var (
	timeShape = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
	uuidShape = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// validator records the first failure; a handler checks every field, then asks for the verdict.
type validator struct{ err error }

func (v *validator) fail(message string) {
	if v.err == nil {
		v.err = apierr.New(400, message)
	}
}

// check fails with message unless ok.
func (v *validator) check(ok bool, message string) {
	if !ok {
		v.fail(message)
	}
}

// result is the first failure, or nil.
func (v *validator) result() error { return v.err }

func length(s string) int { return utf8.RuneCountInString(s) }

// text trims and requires 1..max characters (zod `text(max)`).
func (v *validator) text(value string, max int) string {
	value = strings.TrimSpace(value)
	if value == "" {
		v.fail(msgRequired)
	} else if length(value) > max {
		v.fail(msgInput)
	}
	return value
}

// optText is text for an optional field.
func (v *validator) optText(value *string, max int) *string {
	if value == nil {
		return nil
	}
	trimmed := v.text(*value, max)
	return &trimmed
}

// bounded requires at most max characters without trimming (zod `z.string().max(max)`).
func (v *validator) bounded(value string, max int) string {
	if length(value) > max {
		v.fail(msgInput)
	}
	return value
}

// id is any non-empty identifier up to 100 characters.
func (v *validator) id(value string) string {
	if value == "" || length(value) > 100 {
		v.fail(msgInput)
	}
	return value
}

// uuid requires a canonical lowercase UUID.
func (v *validator) uuid(value string) string {
	if !uuidShape.MatchString(value) {
		v.fail(msgInput)
	}
	return value
}

// enum requires one of the allowed values.
func (v *validator) enum(value string, allowed ...string) string {
	for _, a := range allowed {
		if value == a {
			return value
		}
	}
	v.fail(msgInput)
	return value
}

// date requires a real YYYY-MM-DD.
func (v *validator) date(value string) string {
	if !planner.ValidDate(value) {
		v.fail(msgDate)
	}
	return value
}

// clock requires HH:MM.
func (v *validator) clock(value string) string {
	if !timeShape.MatchString(value) {
		v.fail(msgTime)
	}
	return value
}

// intRange requires an integer in [min, max]; JSON numbers arrive as float64.
func (v *validator) intRange(value float64, min, max int) int {
	if value != float64(int(value)) || int(value) < min || int(value) > max {
		v.fail(msgInput)
	}
	return int(value)
}

// floatRange requires min <= value <= max.
func (v *validator) floatRange(value, min, max float64) float64 {
	if value < min || value > max {
		v.fail(msgInput)
	}
	return value
}
