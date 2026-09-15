// The AI run input hash exactly as the Go server computes it (server/internal/api/airuns.go):
// sha256 over the skill kind and the canonical JSON of the input — object keys sorted, undefined
// entries dropped, arrays in order. QA scripts use it to predict idempotency keys.
import { createHash } from 'node:crypto';

export function inputHash(kind: string, input: unknown) {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .filter(([, entry]) => entry !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : value;
  return createHash('sha256').update(JSON.stringify({ kind, input: canonical(input) })).digest('hex');
}
