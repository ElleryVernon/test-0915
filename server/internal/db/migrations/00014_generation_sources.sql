-- +goose Up
CREATE TABLE "GenerationSources" (
 "materialId" text PRIMARY KEY REFERENCES "Material"("id") ON DELETE CASCADE,
 "sources" jsonb NOT NULL CHECK (jsonb_typeof("sources")='array' AND jsonb_array_length("sources") BETWEEN 2 AND 5),
 "topic" text NOT NULL DEFAULT '',
 "createdAt" timestamptz NOT NULL DEFAULT now()
);
-- +goose StatementBegin
CREATE FUNCTION memoryz_immutable_generation_material() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM "GenerationSources" WHERE "materialId"=OLD."id") AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Generation source snapshots cannot be edited' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER immutable_generation_material BEFORE UPDATE ON "Material" FOR EACH ROW EXECUTE FUNCTION memoryz_immutable_generation_material();
-- +goose Down
DROP TRIGGER immutable_generation_material ON "Material";
DROP FUNCTION memoryz_immutable_generation_material();
DROP TABLE "GenerationSources";
