import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

process.umask(0o077);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, '.data/postgres-native');
const bin = path.join(base, 'runtime/bin');
const data = path.join(base, 'data');
const socket = path.join(base, 'socket');
const backups = path.join(base, 'backups');
const source = new URL(process.env.DATABASE_URL ?? '');
assert(
  ['localhost', '127.0.0.1'].includes(source.hostname) &&
    source.port === '15444' &&
    source.pathname === '/memoryz',
  'Only dedicated loopback memoryz:15444 is supported',
);
const user = decodeURIComponent(source.username);
const password = decodeURIComponent(source.password);
const safeEnv = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR'].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
);
const q = (name) => '"' + name.replaceAll('"', '""') + '"';
const json = async (file) => JSON.parse(await readFile(path.join(base, file), 'utf8'));
const save = async (file, value) =>
  writeFile(path.join(base, file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const exists = async (file) => Boolean(await stat(file).catch(() => null));

function run(command, args, { port = 15444, database = 'memoryz', timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: {
        ...safeEnv,
        PGHOST: '127.0.0.1',
        PGPORT: String(port),
        PGDATABASE: database,
        PGUSER: user,
        PGPASSWORD: password,
        PGCONNECT_TIMEOUT: '15',
        PGOPTIONS: '-c timezone=UTC',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(command)} failed (${code}): ${output.slice(-1500)}`));
    });
  });
}

async function client(port, database = 'memoryz') {
  const connection = new pg.Client({
    host: '127.0.0.1',
    port,
    user,
    password,
    database,
    connectionTimeoutMillis: 15_000,
    query_timeout: 15_000,
  });
  await connection.connect();
  await connection.query("SET TIME ZONE 'UTC'");
  return connection;
}

async function fingerprint(connection) {
  const tables = (
    await connection.query(
      'SELECT tablename FROM pg_tables WHERE schemaname=\'public\' ORDER BY tablename COLLATE "C"',
    )
  ).rows;
  const result = {};
  for (const { tablename } of tables) {
    const rows = (
      await connection.query(`SELECT row_to_json(t)::text AS row FROM public.${q(tablename)} t`)
    ).rows
      .map(({ row }) => Buffer.from(row, 'utf8'))
      .sort(Buffer.compare);
    const digest = createHash('sha256');
    for (const row of rows) digest.update(String(row.length) + ':').update(row);
    result[tablename] = { rows: rows.length, sha256: digest.digest('hex') };
  }
  return result;
}

async function inspect(port, database = 'memoryz') {
  const connection = await client(port, database);
  try {
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const metadata = (
      await connection.query(
        "SELECT current_setting('server_version') AS version, current_setting('data_directory') AS directory, current_setting('TimeZone') AS timezone, current_setting('server_encoding') AS encoding",
      )
    ).rows[0];
    const tables = await fingerprint(connection);
    await connection.query('COMMIT');
    return { ...metadata, tables };
  } finally {
    await connection.end();
  }
}

async function nativePort() {
  if (!(await exists(path.join(data, 'postmaster.pid')))) return null;
  const lines = (await readFile(path.join(data, 'postmaster.pid'), 'utf8')).trim().split('\n');
  try {
    process.kill(Number(lines[0]), 0);
  } catch {
    return null;
  }
  return Number(lines[3]);
}

async function assertNative(port, database = 'postgres') {
  const connection = await client(port, database);
  try {
    const value = (
      await connection.query(
        "SELECT current_setting('data_directory') AS directory, current_setting('server_version') AS version, current_setting('listen_addresses') AS listen",
      )
    ).rows[0];
    assert.equal(value.directory, data, 'Refusing an unrelated PostgreSQL instance');
    assert.equal(value.version, '18.6');
    assert.equal(value.listen, '127.0.0.1');
  } finally {
    await connection.end();
  }
}

async function startNative(port) {
  assert([15444, 15445].includes(port));
  const active = await nativePort();
  if (active !== null) {
    assert.equal(active, port, 'Native PostgreSQL is already running on a different port');
    return;
  }
  await run(path.join(bin, 'pg_ctl'), [
    '-D',
    data,
    '-l',
    path.join(base, 'postgres.log'),
    '-o',
    `-p ${port}`,
    '-w',
    '-t',
    '30',
    'start',
  ]);
  await assertNative(port);
}

async function stopNative() {
  const port = await nativePort();
  if (port === null) return;
  await assertNative(port);
  await run(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop']);
}

async function initialize() {
  await mkdir(base, { recursive: true, mode: 0o700 });
  for (const directory of [socket, backups])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await exists(path.join(data, 'PG_VERSION'))) return;
  assert(
    !(await exists(data)),
    'An uninitialized data directory exists; inspect it instead of overwriting',
  );
  const secretPath = path.join(base, '.init-password-' + randomUUID());
  await writeFile(secretPath, password + '\n', { mode: 0o600 });
  try {
    await run(path.join(bin, 'initdb'), [
      '-D',
      data,
      '--username',
      user,
      '--pwfile',
      secretPath,
      '--auth-local=scram-sha-256',
      '--auth-host=scram-sha-256',
      '--locale=en_US.UTF-8',
      '--encoding=UTF8',
    ]);
  } finally {
    await rm(secretPath, { force: true });
  }
  await writeFile(
    path.join(data, 'postgresql.auto.conf'),
    [
      "listen_addresses = '127.0.0.1'",
      'port = 15445',
      `unix_socket_directories = '${socket.replaceAll("'", "''")}'`,
      "timezone = 'UTC'",
      "log_timezone = 'UTC'",
      'max_connections = 40',
      "shared_buffers = '64MB'",
      "maintenance_work_mem = '32MB'",
      "password_encryption = 'scram-sha-256'",
      'log_statement = none',
      'log_min_error_statement = panic',
      'log_parameter_max_length_on_error = 0',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
}

async function assertSource() {
  const raw = await run('docker', [
    'inspect',
    'memoryz-postgres',
    '--format',
    '{{json .NetworkSettings.Ports}}',
  ]);
  const ports = JSON.parse(raw);
  assert(
    ports['5432/tcp']?.some(
      (binding) => binding.HostPort === '15444' && binding.HostIp === '127.0.0.1',
    ),
    'Dedicated Docker source port binding changed',
  );
  const connection = await client(15444);
  try {
    const metadata = (
      await connection.query(
        "SELECT current_setting('server_version') AS version, current_setting('data_directory') AS directory",
      )
    ).rows[0];
    assert.equal(metadata.version, '18.6');
    assert.notEqual(metadata.directory, data);
  } finally {
    await connection.end();
  }
}

async function capture(label) {
  await assertSource();
  const connection = await client(15444);
  const archive = path.join(
    backups,
    `${label}-${new Date().toISOString().replaceAll(':', '-')}.dump`,
  );
  try {
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await connection.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const tables = await fingerprint(connection);
    await run(path.join(bin, 'pg_dump'), [
      '--format=custom',
      '--no-owner',
      '--no-acl',
      '--lock-wait-timeout=10000',
      '--snapshot=' + snapshot,
      '--file=' + archive,
    ]);
    await chmod(archive, 0o600);
    await connection.query('COMMIT');
    const listing = await run(path.join(bin, 'pg_restore'), ['--list', archive]);
    assert(listing.includes('TABLE DATA public'), 'Archive lacks application table data');
    const result = {
      archive,
      sha256: createHash('sha256')
        .update(await readFile(archive))
        .digest('hex'),
      capturedAt: new Date().toISOString(),
      tables,
    };
    await save(label + '-backup.json', result);
    return result;
  } finally {
    await connection.end();
  }
}

async function restore(backup, database = 'memoryz') {
  assert(['memoryz', 'memoryz_rollback_check'].includes(database));
  await assertNative(15445);
  assert.equal(
    createHash('sha256')
      .update(await readFile(backup.archive))
      .digest('hex'),
    backup.sha256,
    'Backup checksum changed',
  );
  const connection = await client(15445, 'postgres');
  try {
    await connection.query(`DROP DATABASE IF EXISTS ${q(database)} WITH (FORCE)`);
    await connection.query(
      `CREATE DATABASE ${q(database)} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8'`,
    );
  } finally {
    await connection.end();
  }
  await run(
    path.join(bin, 'pg_restore'),
    [
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-acl',
      '--dbname=' + database,
      backup.archive,
    ],
    { port: 15445, database },
  );
  const restored = await inspect(15445, database);
  assert.deepEqual(
    restored.tables,
    backup.tables,
    'Restored rows differ from the exported snapshot',
  );
  assert.equal(restored.encoding, 'UTF8');
  assert.equal(restored.timezone, 'UTC');
  return restored;
}

async function probes(port) {
  const durations = [];
  for (let index = 0; index < 50; index++) {
    const started = performance.now();
    const connection = new pg.Client({
      host: '127.0.0.1',
      port,
      user,
      password,
      database: 'memoryz',
      connectionTimeoutMillis: 2000,
      query_timeout: 1000,
    });
    try {
      await connection.connect();
      assert.equal((await connection.query('SELECT 1 AS value')).rows[0].value, 1);
    } finally {
      await connection.end();
    }
    durations.push(Math.round((performance.now() - started) * 100) / 100);
  }
  durations.sort((a, b) => a - b);
  const result = {
    connections: durations.length,
    p50Ms: durations[24],
    p95Ms: durations[47],
    maxMs: durations[49],
  };
  assert(
    result.p95Ms < 500 && result.maxMs < 1500,
    'Native database latency is not reliable enough',
  );
  return result;
}

async function appStopped() {
  assert(
    process.argv.includes('--app-stopped'),
    'Pause application traffic and pass --app-stopped before switching',
  );
  const listening = await new Promise((resolve) => {
    const connection = net.createConnection({ host: '127.0.0.1', port: 3000 });
    connection.setTimeout(1000);
    connection.once('connect', () => {
      connection.destroy();
      resolve(true);
    });
    connection.once('error', () => resolve(false));
    connection.once('timeout', () => {
      connection.destroy();
      resolve(false);
    });
  });
  assert.equal(listening, false, 'Application port 3000 is still accepting traffic');
}

async function assertSetupAllowed() {
  if (!(await exists(path.join(base, 'cutover-verification.json')))) return;
  const state = await json('cutover-verification.json');
  assert.notEqual(
    state.stage,
    'ACTIVE',
    'Native database is ACTIVE. Refusing to prepare or repeat cutover, even when stopped. Use start/status, or an explicit fresh-backup migration workflow to preserve current history.',
  );
}

async function prepare() {
  await assertSetupAllowed();
  await initialize();
  await startNative(15445);
  const backup = await capture('staging');
  await restore(backup);
  await restore(backup, 'memoryz_rollback_check');
  await stopNative();
  await startNative(15445);
  assert.deepEqual((await inspect(15445)).tables, backup.tables);
  assert.deepEqual((await inspect(15445, 'memoryz_rollback_check')).tables, backup.tables);
  const result = {
    stage: 'READY',
    verifiedAt: new Date().toISOString(),
    tables: Object.keys(backup.tables).length,
    backupSha256: backup.sha256,
    rollback: 'Separate staging database restored from archive; restart retained identical rows',
    latency: await probes(15445),
  };
  await save('staging-verification.json', result);
  console.log('NATIVE_STAGING_READY ' + JSON.stringify(result));
}

async function cutover() {
  await assertSetupAllowed();
  await appStopped();
  assert.equal(await nativePort(), 15445, 'Staging must be ready before cutover');
  assert.equal((await json('staging-verification.json')).stage, 'READY');
  const connection = await client(15444);
  try {
    assert.equal(
      Number(
        (await connection.query('SELECT count(*) FROM "AiRun" WHERE status = \'RUNNING\'')).rows[0]
          .count,
      ),
      0,
      'An AI run is still active',
    );
  } finally {
    await connection.end();
  }
  const backup = await capture('cutover');
  await restore(backup);
  await restore(backup, 'memoryz_rollback_check');
  assert.deepEqual(
    (await inspect(15444)).tables,
    backup.tables,
    'Source changed after capture; stop all writes and retry',
  );
  await stopNative();
  try {
    await run('docker', ['stop', '--time', '30', 'memoryz-postgres']);
    await startNative(15444);
    assert.deepEqual((await inspect(15444)).tables, backup.tables);
    const result = {
      stage: 'ACTIVE',
      activatedAt: new Date().toISOString(),
      backupSha256: backup.sha256,
      tables: Object.keys(backup.tables).length,
      latency: await probes(15444),
      rollback:
        'Only permitted while the native data matches the captured source; otherwise backup and restore new writes first',
    };
    await save('cutover-verification.json', result);
    console.log('NATIVE_CUTOVER_COMPLETE ' + JSON.stringify(result));
  } catch (error) {
    // Traffic is still stopped. The source has not been modified and can be restored safely.
    await stopNative();
    await run('docker', ['start', 'memoryz-postgres']);
    throw error;
  }
}

async function rollback() {
  await appStopped();
  assert.equal(await nativePort(), 15444);
  const backup = await json('cutover-backup.json');
  assert.deepEqual(
    (await inspect(15444)).tables,
    backup.tables,
    'Native data changed after cutover. Refusing stale rollback: create a fresh native backup and restore it into Docker before switching.',
  );
  await stopNative();
  try {
    await run('docker', ['start', 'memoryz-postgres']);
    assert.deepEqual(
      (await inspect(15444)).tables,
      backup.tables,
      'Docker source no longer matches the safe rollback snapshot',
    );
    await save('rollback-verification.json', {
      restoredAt: new Date().toISOString(),
      backupSha256: backup.sha256,
    });
    const cutover = await json('cutover-verification.json');
    await save('cutover-verification.json', { ...cutover, stage: 'ROLLED_BACK' });
    console.log('NATIVE_ROLLBACK_COMPLETE original Docker data matches the native snapshot');
  } catch (error) {
    await run('docker', ['stop', '--time', '30', 'memoryz-postgres']);
    await startNative(15444);
    throw error;
  }
}

async function verify() {
  const provenance = await json('source.json');
  const staging = await json('staging-verification.json');
  const cutover = await json('cutover-verification.json');
  const backup = await json('cutover-backup.json');
  assert.equal(provenance.version, '18.6');
  assert.equal(
    provenance.sha256,
    '555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f',
  );
  assert.equal(staging.stage, 'READY');
  assert.equal(cutover.stage, 'ACTIVE');
  assert.equal(cutover.backupSha256, backup.sha256);
  assert.equal(
    createHash('sha256')
      .update(await readFile(backup.archive))
      .digest('hex'),
    backup.sha256,
  );
  assert.equal((await stat(backup.archive)).mode & 0o777, 0o600);
  assert.equal(await nativePort(), 15444);
  await assertNative(15444);
  assert.deepEqual(
    (await inspect(15444, 'memoryz_rollback_check')).tables,
    backup.tables,
    'The separately restored rollback database must still match every captured source row',
  );
  const container = (
    await run('docker', ['inspect', 'memoryz-postgres', '--format', '{{.State.Running}}'])
  ).trim();
  assert.equal(container, 'false', 'Original Docker runtime should be retained but stopped');
  const latency = await probes(15444);
  console.log(
    'NATIVE_DATABASE_VERIFIED ' +
      JSON.stringify({
        version: provenance.version,
        preservedTables: cutover.tables,
        archiveSha256: backup.sha256,
        rollbackRehearsal: staging.rollback,
        latency,
        loopbackOnly: true,
      }),
  );
}

const operation = process.argv[2] ?? 'status';
switch (operation) {
  case 'prepare':
    await prepare();
    break;
  case 'cutover':
    await cutover();
    break;
  case 'rollback':
    await rollback();
    break;
  case 'verify':
    await verify();
    break;
  case 'start': {
    const state = await json('cutover-verification.json').catch(() => null);
    await startNative(state?.stage === 'ACTIVE' ? 15444 : 15445);
    console.log('NATIVE_STARTED port=' + (await nativePort()));
    break;
  }
  case 'stop':
    await stopNative();
    console.log('NATIVE_STOPPED');
    break;
  case 'status':
    console.log(
      JSON.stringify({
        root: base,
        port: await nativePort(),
        source: await json('source.json').catch(() => null),
      }),
    );
    break;
  default:
    throw new Error(
      'Usage: node scripts/native-db.mjs prepare|cutover|rollback|verify|start|stop|status [--app-stopped]',
    );
}
