# Memoryz: one image, one process — the Go server serving the API and the static web build.
# Stage 1 builds the web (Next.js static export + precompressed siblings), stage 2 the Go binary
# (CGO off, pdfium via wasm), stage 3 is distroless base: glibc only, no shell — the webp decoder
# (gen2brain/webp via purego) links the dynamic loader even with CGO off, so `static` cannot run it.
# Build for Cloud Run:
#   docker buildx build --platform linux/amd64 -t <registry>/server:<tag> --push .
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY next.config.ts tsconfig.json postcss.config.* ./
COPY public ./public
COPY src ./src
COPY scripts/precompress.mjs ./scripts/precompress.mjs
ENV NEXT_TELEMETRY_DISABLED=1
RUN node_modules/.bin/next build && node scripts/precompress.mjs out

FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS server
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server ./
ARG TARGETOS=linux
ARG TARGETARCH=amd64
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /out/server ./cmd/server

FROM gcr.io/distroless/base-debian12:nonroot
WORKDIR /srv
COPY --from=server /out/server /srv/server
COPY --from=web /app/out /srv/web
ENV STATIC_DIR=/srv/web PORT=8080 HOST=
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/srv/server"]
CMD ["serve"]
