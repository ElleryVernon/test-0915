// Package ids makes the identifiers rows and tokens carry.
package ids

import (
	"crypto/rand"
	"encoding/hex"

	"github.com/google/uuid"
)

// New returns a time-ordered UUID (v7) as text: unique across instances and friendly to B-tree
// indexes, which the previous cuid identifiers were not.
func New() string {
	id, err := uuid.NewV7()
	if err != nil {
		// Only when the system's randomness source fails; a v4 built on crypto/rand still panics then.
		id = uuid.New()
	}
	return id.String()
}

// Token returns n random bytes as lowercase hex (2n characters).
func Token(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("ids: randomness unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)
}
