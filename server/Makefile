.PHONY: build run check test sqlc migrate

build:
	go build -ldflags "-X main.version=$$(git -C .. rev-parse --short HEAD 2>/dev/null || echo dev)" -o bin/server ./cmd/server

run: build
	./bin/server serve

# Static checks the ledger gate runs: compile, vet, formatting, generated code up to date.
check:
	go build ./... && go vet ./... && test -z "$$(gofmt -l ./cmd ./internal)" && sqlc diff

test:
	go test ./... -count=1

sqlc:
	sqlc generate

migrate: build
	./bin/server migrate up
