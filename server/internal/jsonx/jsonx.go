// Package jsonx holds the JSON conventions the web client relies on: timestamps formatted exactly
// like JavaScript's Date.prototype.toISOString() and tri-state optional fields for PATCH bodies.
package jsonx

import (
	"bytes"
	"encoding/json"
	"time"
)

// Time marshals as "2006-01-02T15:04:05.000Z", byte-identical to the previous server's output.
type Time time.Time

// MarshalJSON formats in UTC with millisecond precision.
func (t Time) MarshalJSON() ([]byte, error) {
	return json.Marshal(Format(time.Time(t)))
}

// UnmarshalJSON accepts RFC 3339 strings.
func (t *Time) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	parsed, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return err
	}
	*t = Time(parsed)
	return nil
}

// Format renders t the way JavaScript would.
func Format(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// TimePtr converts a nullable database timestamp.
func TimePtr(t *time.Time) *Time {
	if t == nil {
		return nil
	}
	v := Time(*t)
	return &v
}

// Opt is a field that may be absent, null or present in a JSON body.
type Opt[T any] struct {
	Set   bool
	Null  bool
	Value T
}

// UnmarshalJSON records whether the field was null; encoding/json only calls it for present keys.
func (o *Opt[T]) UnmarshalJSON(data []byte) error {
	o.Set = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		o.Null = true
		return nil
	}
	return json.Unmarshal(data, &o.Value)
}

// Present reports whether the field carried a non-null value.
func (o Opt[T]) Present() bool { return o.Set && !o.Null }

// Raw keeps a JSON document as-is (jsonb columns).
type Raw []byte

// MarshalJSON writes the stored document verbatim, or null when empty.
func (r Raw) MarshalJSON() ([]byte, error) {
	if len(r) == 0 {
		return []byte("null"), nil
	}
	return r, nil
}

// UnmarshalJSON keeps a copy of the document.
func (r *Raw) UnmarshalJSON(data []byte) error {
	*r = append((*r)[:0], data...)
	return nil
}
