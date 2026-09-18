// demo-export prints the seeded sample materials with their quiz and essay items as JSON, for
// offline evaluations that must not touch a database.
package main

import (
	"encoding/json"
	"os"

	"memoryz/server/internal/demo"
)

func main() {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(demo.Items()); err != nil {
		os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(1)
	}
}
