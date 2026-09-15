// Writes .br and .gz siblings for every compressible file of a static build so the Go server can
// answer Accept-Encoding without compressing on the request path (server/internal/httpx/static.go).
// Skips files that compress worse than the original. Usage: node scripts/precompress.mjs out
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/precompress.mjs <dir>');
  process.exit(2);
}
const compressible = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.webmanifest', '.txt', '.map', '.xml', '.wasm']);
let files = 0;
let saved = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    if (!compressible.has(extname(entry.name))) continue;
    const data = readFileSync(path);
    if (data.length < 1024) continue; // a header costs more than it saves
    const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
    const gz = gzipSync(data, { level: 9 });
    if (br.length < data.length) writeFileSync(`${path}.br`, br);
    if (gz.length < data.length) writeFileSync(`${path}.gz`, gz);
    files++;
    saved += data.length - Math.min(br.length, data.length);
  }
};
if (!statSync(root).isDirectory()) throw new Error(`${root} is not a directory`);
walk(root);
console.log(`PRECOMPRESS_OK files=${files} savedBytes=${saved}`);
