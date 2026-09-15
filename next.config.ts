import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

// The web is a static build served by the Go server (server/), which also answers /api on the same
// origin. In development `next dev` fronts a locally running Go server through a rewrite; at build
// time the app is exported to out/ (and precompressed by scripts/precompress.mjs). Security headers
// and cache rules live in the Go server (httpx.SecurityHeaders, httpx.NewSPA), not here.
const config = (phase: string): NextConfig => ({
  poweredByHeader: false,
  ...(phase === PHASE_DEVELOPMENT_SERVER
    ? {
        async rewrites() {
          const api = process.env.GO_API_URL ?? 'http://127.0.0.1:8080';
          return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
        },
      }
    : { output: 'export' }),
});
export default config;
