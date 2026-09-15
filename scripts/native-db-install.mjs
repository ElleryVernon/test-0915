import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, '.data/postgres-native');
const version = '18.6';
const checksum = '555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f';
const sourceUrl = `https://ftp.postgresql.org/pub/source/v${version}/postgresql-${version}.tar.bz2`;
const archive = path.join(base, `postgresql-${version}.tar.bz2`);
const source = path.join(base, `postgresql-${version}`);
const runtime = path.join(base, 'runtime');
await mkdir(base, { recursive: true, mode: 0o700 });
await chmod(base, 0o700);
const logPath = path.join(base, 'build.log');
const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
const safeEnv = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'SDKROOT', 'DEVELOPER_DIR'].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);

function run(command, args, cwd = base, timeout = 600_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: safeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error(`${path.basename(command)} failed (${code}); inspect ${logPath}`));
    });
  });
}

try {
  if (!(await stat(archive).catch(() => null))) {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Official source download failed (${response.status})`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  }
  const actualHash = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  if (actualHash !== checksum)
    throw new Error('Official source SHA256 mismatch; refusing execution');
  console.log(`SOURCE_VERIFIED PostgreSQL ${version} SHA256 ${actualHash}`);
  if (!(await stat(source).catch(() => null))) await run('tar', ['-xjf', archive]);
  if (!(await stat(path.join(runtime, 'bin/postgres')).catch(() => null))) {
    console.log('CONFIGURING repo-local PostgreSQL without optional ICU/readline');
    await run(
      './configure',
      [`--prefix=${runtime}`, '--without-icu', '--without-readline'],
      source,
    );
    console.log('BUILDING PostgreSQL with four workers');
    await run('make', ['-j4'], source);
    console.log('INSTALLING into .data/postgres-native/runtime');
    await run('make', ['install-strip'], source);
  }
  await run(path.join(runtime, 'bin/postgres'), ['--version']);
  await writeFile(
    path.join(base, 'source.json'),
    JSON.stringify(
      {
        version,
        sourceUrl,
        sha256: actualHash,
        license: 'PostgreSQL License',
        prefix: runtime,
        configuredWithout: ['icu', 'readline'],
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  console.log('NATIVE_POSTGRES_INSTALLED 18.6');
} finally {
  log.end();
}
