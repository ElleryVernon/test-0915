package blob

import (
	"bytes"
	"context"
	"errors"
	"io"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PG keeps objects in ops.blob. It is the local-development driver; every checkout that shares the
// database can serve every file. Postgres hands a bytea back whole, so a Get holds the object in
// memory for the request — acceptable for the 10 MB cap in development, which is why the cloud
// service uses the streaming Cloud Storage driver.
type PG struct {
	pool *pgxpool.Pool
}

// NewPG returns the Postgres driver.
func NewPG(pool *pgxpool.Pool) *PG { return &PG{pool: pool} }

func (s *PG) Name() string { return "pg" }

func (s *PG) Put(ctx context.Context, key, contentType string, data []byte) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO ops.blob (key, content_type, size, data) VALUES ($1, $2, $3, $4)
		ON CONFLICT (key) DO UPDATE SET content_type = EXCLUDED.content_type, size = EXCLUDED.size, data = EXCLUDED.data`,
		key, contentType, len(data), data)
	return err
}

func (s *PG) Get(ctx context.Context, key string) (*Object, error) {
	var data []byte
	var contentType string
	err := s.pool.QueryRow(ctx, `SELECT data, content_type FROM ops.blob WHERE key = $1`, key).Scan(&data, &contentType)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &Object{ReadCloser: io.NopCloser(bytes.NewReader(data)), Size: int64(len(data)), ContentType: contentType}, nil
}

func (s *PG) Delete(ctx context.Context, key string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM ops.blob WHERE key = $1`, key)
	return err
}

func (s *PG) List(ctx context.Context, prefix string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT key FROM ops.blob WHERE left(key, length($1::text)) = $1::text ORDER BY key`, prefix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	keys := []string{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return keys, rows.Err()
}

func (s *PG) DeletePrefix(ctx context.Context, prefix string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM ops.blob WHERE left(key, length($1::text)) = $1::text`, prefix)
	return err
}
