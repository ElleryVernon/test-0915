package db

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// The schema uses TIMESTAMP (without time zone) columns holding UTC instants, as the previous
// server wrote them. pgx encodes a time.Time for such a column by dropping its zone and keeping the
// wall clock, so a value in the process's local zone would land hours off. This codec converts to
// UTC first, making every timestamp written through the pool an instant regardless of the zone the
// caller happened to use.

type utcTimestampCodec struct{ pgtype.TimestampCodec }

func (c *utcTimestampCodec) PlanEncode(m *pgtype.Map, oid uint32, format int16, value any) pgtype.EncodePlan {
	inner := c.TimestampCodec.PlanEncode(m, oid, format, value)
	if inner == nil {
		return nil
	}
	return utcEncodePlan{inner: inner}
}

type utcEncodePlan struct{ inner pgtype.EncodePlan }

// Encode sees the value after pgx has wrapped a time.Time into a TimestampValuer; the instant is
// moved to UTC before the inner plan drops the zone.
func (p utcEncodePlan) Encode(value any, buf []byte) ([]byte, error) {
	if v, ok := value.(pgtype.TimestampValuer); ok {
		ts, err := v.TimestampValue()
		if err != nil {
			return nil, err
		}
		if ts.Valid && ts.InfinityModifier == pgtype.Finite {
			ts.Time = ts.Time.UTC()
		}
		return p.inner.Encode(ts, buf)
	}
	if t, ok := value.(time.Time); ok {
		return p.inner.Encode(t.UTC(), buf)
	}
	return p.inner.Encode(value, buf)
}

// registerUTCTimestamps installs the codec on a fresh connection.
func registerUTCTimestamps(_ context.Context, conn *pgx.Conn) error {
	conn.TypeMap().RegisterType(&pgtype.Type{Name: "timestamp", OID: pgtype.TimestampOID, Codec: &utcTimestampCodec{}})
	return nil
}
