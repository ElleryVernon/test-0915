// Build beside the running site, then publish the complete export. Port 3000 can keep serving out/.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = process.cwd();
const release = `.data/web-build-${process.pid}`;
const stage = resolve(root, release);
const out = resolve(root, 'out');
const previous = resolve(root, `.data/web-previous-${process.pid}`);
mkdirSync(resolve(root, '.data'), { recursive: true });
const run = (args, env = process.env) => {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Web build failed (${result.status ?? 'signal'})`);
};
try {
  run(['node_modules/next/dist/bin/next', 'build'], { ...process.env, NEXT_EXPORT_DIR: release });
  run(['scripts/precompress.mjs', stage]);
  // Older open tabs may still request their immutable chunks after the new document is served.
  if (existsSync(join(out, '_next/static'))) {
    cpSync(join(out, '_next/static'), join(stage, '_next/static'), {
      recursive: true,
      force: false,
    });
  }
  if (existsSync(out)) renameSync(out, previous);
  try {
    renameSync(stage, out);
  } catch (error) {
    if (existsSync(previous)) renameSync(previous, out);
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
  console.log('WEB_PUBLISH_OK out');
} finally {
  rmSync(stage, { recursive: true, force: true });
}
