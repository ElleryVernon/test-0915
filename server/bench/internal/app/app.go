// Package app holds the handler bodies shared by every framework candidate.
// Each candidate wires these into its own router, so only routing, parameter
// extraction and the framework's own JSON helpers differ between candidates.
package app

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PoolMaxConns is the pgxpool size shared by every candidate.
const PoolMaxConns = 16

// LookupSQL is the single query behind GET /db?id=N.
const LookupSQL = "SELECT id, name, score FROM bench WHERE id=$1"

// SeedRows is the number of rows seeded into the bench table.
const SeedRows = 10000

// Hello is the GET /json payload.
type Hello struct {
	Message string `json:"message"`
	TS      int64  `json:"ts"`
}

// NewHello builds the GET /json payload.
func NewHello() Hello { return Hello{Message: "hello", TS: time.Now().UnixMilli()} }

// User is the GET /users/{id} payload.
type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Score int    `json:"score"`
}

// NewUser echoes the path parameter.
func NewUser(id string) User { return User{ID: id, Name: "user-" + id, Score: 42} }

// EchoBody is the ~1KB document decoded and re-encoded by POST /echo.
type EchoBody struct {
	ID      string `json:"id"`
	Text    string `json:"text"`
	Numbers []int  `json:"numbers"`
	Nested  Nested `json:"nested"`
}

// Nested is the nested object inside EchoBody.
type Nested struct {
	Name    string   `json:"name"`
	Count   int      `json:"count"`
	Enabled bool     `json:"enabled"`
	Tags    []string `json:"tags"`
}

// SampleEchoJSON is the request body oha posts to /echo: 1002 bytes, an
// 820-character string, 20 ints and a nested object. It is embedded so the
// exact bytes are part of the module and the oha command is reproducible.
//
//go:embed echo-body.json
var SampleEchoJSON []byte

// SampleEchoBody decodes SampleEchoJSON.
func SampleEchoBody() (EchoBody, error) {
	var b EchoBody
	err := json.Unmarshal(SampleEchoJSON, &b)
	return b, err
}

// Row is the GET /db payload.
type Row struct {
	ID    int    `json:"id"`
	Name  string `json:"name"`
	Score int    `json:"score"`
}

// ErrorBody is the JSON error envelope.
type ErrorBody struct {
	Error string `json:"error"`
}

// Handler errors, mapped to HTTP statuses by StatusFor.
var (
	ErrBadID    = errors.New("id must be a positive integer")
	ErrNotFound = errors.New("row not found")
	ErrNoDB     = errors.New("database not configured")
)

// ParseID parses the ?id= query value.
func ParseID(s string) (int, error) {
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return 0, ErrBadID
	}
	return n, nil
}

// StatusFor maps handler errors to HTTP status codes.
func StatusFor(err error) int {
	switch {
	case errors.Is(err, ErrBadID):
		return http.StatusBadRequest
	case errors.Is(err, ErrNotFound):
		return http.StatusNotFound
	// jitter: none — benchmark harness only; never deployed, so no client retries this 503 [site server/bench/internal/app/app.go:115]
	case errors.Is(err, ErrNoDB):
		return http.StatusServiceUnavailable
	default:
		return http.StatusInternalServerError
	}
}

// SeedName is the deterministic name of seed row id.
func SeedName(id int) string { return "user-" + strconv.Itoa(id) }

// SeedScore is the deterministic score of seed row id.
func SeedScore(id int) int { return (id * 7919) % 100 }

// SeedSQL creates and fills the bench table with SeedRows deterministic rows
// (names/scores match SeedName/SeedScore).
var SeedSQL = []string{
	"CREATE TABLE bench (id serial PRIMARY KEY, name text NOT NULL, score int NOT NULL)",
	fmt.Sprintf("INSERT INTO bench (name, score) SELECT 'user-' || g, (g * 7919) %% 100 FROM generate_series(1, %d) AS g", SeedRows),
	"ANALYZE bench",
}

// Store runs the /db query through the shared pgxpool.
type Store struct{ pool *pgxpool.Pool }

// NewPool opens the pool configuration shared by every candidate (MaxConns=16).
func NewPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("pool config: %w", err)
	}
	cfg.MaxConns = PoolMaxConns
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pool ping: %w", err)
	}
	return pool, nil
}

// NewStore wraps a pool; a nil pool answers ErrNoDB.
func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// Close releases the pool.
func (s *Store) Close() {
	if s != nil && s.pool != nil {
		s.pool.Close()
	}
}

// Lookup is the GET /db handler body: one query, one row.
func (s *Store) Lookup(ctx context.Context, id int) (Row, error) {
	var row Row
	if s == nil || s.pool == nil {
		return row, ErrNoDB
	}
	err := s.pool.QueryRow(ctx, LookupSQL, id).Scan(&row.ID, &row.Name, &row.Score)
	if errors.Is(err, pgx.ErrNoRows) {
		return row, ErrNotFound
	}
	if err != nil {
		return row, fmt.Errorf("query: %w", err)
	}
	return row, nil
}

// LookupByQuery parses the raw ?id= value and looks the row up.
func (s *Store) LookupByQuery(ctx context.Context, raw string) (Row, error) {
	id, err := ParseID(raw)
	if err != nil {
		return Row{}, err
	}
	return s.Lookup(ctx, id)
}

// WriteJSON is the encoding/json response helper for the candidates whose
// handlers receive the raw http.ResponseWriter (net/http, chi).
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// ReadJSON is the encoding/json request helper for net/http and chi.
func ReadJSON(r io.Reader, v any) error { return json.NewDecoder(r).Decode(v) }

// WriteError writes the error envelope with the status mapped by StatusFor.
func WriteError(w http.ResponseWriter, err error) {
	WriteJSON(w, StatusFor(err), ErrorBody{Error: err.Error()})
}
