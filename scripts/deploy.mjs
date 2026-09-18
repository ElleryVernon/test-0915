// Cloud deployment of memoryz (project memoryz-prod, asia-northeast3), reproducible and idempotent.
// Every gcloud call uses the dedicated `memoryz` configuration; nothing here touches the default
// gcloud project. Subcommands (each prints one success token the gate ledgers expect):
//   image          build linux/amd64 with buildx, push to Artifact Registry as server:<git sha>
//   verify-image   pull-free checks on the pushed image (digest, size, version, static bundle)
//   jobs           create/update + run memoryz-migrate (migrate up) and memoryz-seed (seed-demo)
//   service        deploy the Cloud Run service with the capacity model's settings
//   verify-service assert the deployed spec and readiness
//   sweep          create/update memoryz-sweep job + daily Cloud Scheduler trigger, run it once
//   alerts         uptime check, e-mail channel, six alert policies (uptime, 5xx, p95, pool, Cloud SQL CPU, disk)
//   verify-alerts  assert they exist
//   verify-oauth   assert the OAuth secrets exist with an accessor binding (values never read)
//   verify-judge   assert the TypeSafe judge secret exists with an accessor binding and the spec ships AI_JUDGE
// Usage: node scripts/deploy.mjs <subcommand> [--tag <tag>]
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = 'memoryz-prod';
const PROJECT_NUMBER = '201536310409';
const REGION = 'asia-northeast3';
const SERVICE = 'memoryz';
const SA = 'memoryz-run@memoryz-prod.iam.gserviceaccount.com';
const REGISTRY = `${REGION}-docker.pkg.dev/${PROJECT}/memoryz/server`;
const SQL_INSTANCE = 'memoryz-prod:asia-northeast3:memoryz-pg';
const VALKEY_ADDR = '10.178.0.4:6379'; // Memorystore PSC primary endpoint (gcp-check valkey shows it)
const BUCKET = 'memoryz-prod-uploads';
const ALERT_EMAIL = 'innovoedutech@gmail.com';
// The public origin after the domain cutover (docs/CLOUD.md 도메인). The load balancer fronts the
// service there; direct run.app access is closed by ingress once the service serves it.
const DOMAIN_ORIGIN = 'https://memoryz.kr';

const args = process.argv.slice(2);
const command = args[0];
const tagArg = args.indexOf('--tag') >= 0 ? args[args.indexOf('--tag') + 1] : undefined;
const env = { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: 'memoryz', CLOUDSDK_CORE_DISABLE_PROMPTS: '1' };
const gcloud = (...a) => execFileSync('gcloud', [...a, `--project=${PROJECT}`], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gcloudJSON = (...a) => JSON.parse(gcloud(...a, '--format=json'));
const tryGcloud = (...a) => { try { return gcloud(...a); } catch { return null; } };
const sha = () => execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: 'server', encoding: 'utf8' }).trim();
// A clean tree is tagged with its commit. An uncommitted tree gets a tag derived from its content, so
// two different dirty trees never share a tag (a reused "-dirty" tag once let verify-image pass for an
// older image after a failed push, 2026-09-16).
const IMAGE_INPUTS = ['server', 'src', 'public', 'Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'next.config.ts', 'tsconfig.json', 'scripts/precompress.mjs'];
function treeTag() {
  const dirty = spawnSync('git', ['status', '--porcelain', '--', ...IMAGE_INPUTS], { encoding: 'utf8' }).stdout.trim();
  if (!dirty) return sha();
  const hash = createHash('sha256');
  hash.update(spawnSync('git', ['diff', 'HEAD', '--binary', '--', ...IMAGE_INPUTS], { encoding: 'utf8', maxBuffer: 256 << 20 }).stdout);
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...IMAGE_INPUTS], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout.split('\n').filter(Boolean).sort();
  for (const file of untracked) hash.update(`\0${file}\0`).update(readFileSync(file));
  return `${sha()}-dirty-${hash.digest('hex').slice(0, 10)}`;
}
const tag = tagArg ?? treeTag();
const image = `${REGISTRY}:${tag}`;
const fail = (message) => { console.error(message); process.exit(1); };
// Docker runs with its own config: Artifact Registry authenticates through gcloud (config `memoryz`),
// Docker Hub base images are pulled anonymously, and the user's builder, contexts and CLI plugins are
// shared by symlink. The user's desktop credential store is never consulted — a hung desktop helper
// once stalled every build at "load metadata for docker.io/…" (2026-09-16).
function dockerEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'memoryz-docker-'));
  const home = join(homedir(), '.docker');
  let currentContext;
  try { currentContext = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).currentContext; } catch {}
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ credHelpers: { [`${REGION}-docker.pkg.dev`]: 'gcloud' }, ...(currentContext ? { currentContext } : {}) }));
  for (const shared of ['cli-plugins', 'contexts', 'buildx']) if (existsSync(join(home, shared))) symlinkSync(join(home, shared), join(dir, shared));
  return { ...env, DOCKER_CONFIG: dir };
}
const dockerEnvOnce = (() => { let value; return () => (value ??= dockerEnv()); })();
/** The deployed service (or null) and its environment as a name → value map (secrets as `secret:<name>`). */
function describeService() {
  const raw = tryGcloud('run', 'services', 'describe', SERVICE, `--region=${REGION}`, '--format=json');
  if (!raw) return null;
  const s = JSON.parse(raw);
  const env = Object.fromEntries((s.spec.template.spec.containers[0].env ?? []).map((e) => [e.name, e.value ?? `secret:${e.valueFrom?.secretKeyRef?.name}`]));
  return { s, env };
}
/** Whether an origin is a custom domain rather than Cloud Run's own run.app address. */
const isCustom = (origin) => !!origin && !new URL(origin).host.endsWith('.run.app');
/** The origin learners use: the service's APP_URL, else its run.app URL, else the deterministic first URL. */
function publicOrigin() {
  const current = describeService();
  return current?.env.APP_URL || current?.s.status?.url || `https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app`;
}
async function monitoring(method, path, body) {
  const token = gcloud('auth', 'print-access-token');
  const res = await fetch(`https://monitoring.googleapis.com/v3/projects/${PROJECT}/${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) fail(`monitoring ${method} ${path}: ${res.status} ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : {};
}

/** The load balancer's forwarding-rule address: it appends itself to X-Forwarded-For after the client. */
const lbAddress = (() => {
  let value;
  return () => (value ??= tryGcloud('compute', 'addresses', 'describe', 'memoryz-ip', '--global', '--format=value(address)') || fail('memoryz-ip address not found (the custom domain needs the load balancer)'));
})();

// Environment shared by the service and the jobs (secrets are referenced, never copied). Behind the
// custom domain the load balancer's own address is a trusted proxy, so the client (rate-limit key)
// is the X-Forwarded-For entry before it.
const runtimeEnv = (appURL) => [
  'ENV=production', `GOOGLE_CLOUD_PROJECT=${PROJECT}`, 'LOG_FORMAT=json', 'LOG_LEVEL=info',
  `DB_INSTANCE=${SQL_INSTANCE}`, 'DB_USER=memoryz-run@memoryz-prod.iam', 'DB_NAME=memoryz', 'DB_IAM_AUTH=true', 'DB_IP_TYPE=private', 'DB_POOL_MAX=6',
  'BLOB_STORE=gcs', `GCS_BUCKET=${BUCKET}`, `VALKEY_ADDR=${VALKEY_ADDR}`, 'VALKEY_IAM_AUTH=true',
  'OTEL_EXPORTER=gcp', 'OTEL_SAMPLE_RATIO=1', 'TRUST_PROXY=true', 'DEMO_MODE=true', 'PDF_WORKERS=2', 'AI_RATE_PER_MINUTE=10', 'AI_RATE_PER_DAY=200',
  'OPENROUTER_MODEL=openai/gpt-5.6-luna', 'OPENROUTER_REASONING_EFFORT=high',
  // The Jev judge runs in shadow first: verdicts are recorded beside every grade and generation
  // review, no path changes, the display-only quick verdict is served. Flip to on after the
  // agreement rate has been read (docs/TYPESAFE_JEV_EVALUATION.md).
  'TYPESAFE_MODEL=jev-latest', `AI_JUDGE=${JUDGE_MODE}`,
  ...(appURL ? [`APP_URL=${appURL}`] : []),
  ...(isCustom(appURL) ? [`TRUSTED_PROXIES=${lbAddress()}`] : []),
].join(',');
const JUDGE_MODE = 'shadow';
const secretEnv = 'AUTH_SECRET=AUTH_SECRET:latest,OPENROUTER_API_KEY=OPENROUTER_API_KEY:latest,VALKEY_CA_PEM=VALKEY_CA_PEM:latest,TYPESAFE_API_KEY=TYPESAFE_API_KEY:latest';
const oauthSecretNames = ['GOOGLE', 'NAVER', 'KAKAO'].flatMap(provider => [`${provider}_CLIENT_ID`, `${provider}_CLIENT_SECRET`]);
const oauthSecretEnv = oauthSecretNames.map(name => `${name}=${name}:latest`).join(',');
const requireOAuthSecrets = () => {
  for (const name of oauthSecretNames) if (!tryGcloud('secrets', 'versions', 'describe', 'latest', `--secret=${name}`, '--format=value(name)')) fail(`OAuth secret unavailable: ${name}`);
  return oauthSecretEnv;
};
const vpc = ['--network=default', `--subnet=default`, '--vpc-egress=private-ranges-only'];

function runJob(name, jobArgs, timeout) {
  const exists = !!tryGcloud('run', 'jobs', 'describe', name, `--region=${REGION}`);
  // Production config validation wants the public origin; jobs never serve it, but they carry the same one.
  const appURL = publicOrigin();
  const shared = [
    `--region=${REGION}`, `--image=${image}`, `--service-account=${SA}`, `--args=${jobArgs}`, `--set-env-vars=${runtimeEnv(appURL)}`, `--set-secrets=${secretEnv}`,
    `--set-cloudsql-instances=${SQL_INSTANCE}`, ...vpc, '--cpu=1', '--memory=1Gi', `--task-timeout=${timeout}`, '--max-retries=0', '--tasks=1',
  ];
  gcloud('run', 'jobs', exists ? 'update' : 'create', name, ...shared, '--format=value(name)');
  const execution = gcloud('run', 'jobs', 'execute', name, `--region=${REGION}`, '--wait', '--format=value(metadata.name)');
  const status = gcloudJSON('run', 'jobs', 'executions', 'describe', execution, `--region=${REGION}`);
  const succeeded = status.status?.succeededCount === 1 && (status.status?.conditions ?? []).some((c) => c.type === 'Completed' && c.status === 'True');
  return { execution, succeeded };
}

function jobLogs(execution) {
  return tryGcloud('logging', 'read', `resource.type="cloud_run_job" AND labels."run.googleapis.com/execution_name"="${execution}"`, '--limit=50', '--format=value(textPayload,jsonPayload.message,jsonPayload)') ?? '';
}

const commands = {
  migrate() {
    const result = runJob('memoryz-migrate', 'migrate,up', '600s');
    if (!result.succeeded) fail(`MIGRATION_FAILED ${result.execution}`);
    console.log(`MIGRATION_OK ${result.execution}`);
  },
  image() {
    const build = spawnSync('docker', ['buildx', 'build', '--platform', 'linux/amd64', '--build-arg', `VERSION=${tag}`, '-t', image, '--push', '.'], { stdio: 'inherit', env: dockerEnvOnce() });
    if (build.status !== 0) fail('docker build/push failed');
    console.log(`IMAGE_PUSHED ${image}`);
  },
  'verify-image'() {
    const info = gcloudJSON('artifacts', 'docker', 'images', 'describe', image);
    const digest = info.image_summary?.digest ?? '';
    // Size from the local build cache of the same tag (buildx --push leaves no local image; pull the manifest instead).
    const inspect = spawnSync('docker', ['manifest', 'inspect', image], { encoding: 'utf8', env: dockerEnvOnce() });
    const manifest = inspect.status === 0 ? JSON.parse(inspect.stdout) : null;
    const platform = manifest?.manifests ? manifest.manifests.find((m) => m.platform?.architecture === 'amd64') : null;
    const layersOf = (m) => (m?.layers ?? []).reduce((sum, l) => sum + (l.size ?? 0), m?.config?.size ?? 0);
    let size = layersOf(manifest);
    if (!size && platform) {
      const sub = spawnSync('docker', ['manifest', 'inspect', `${REGISTRY}@${platform.digest}`], { encoding: 'utf8', env: dockerEnvOnce() });
      if (sub.status === 0) size = layersOf(JSON.parse(sub.stdout));
    }
    const run = spawnSync('docker', ['run', '--rm', '--platform', 'linux/amd64', image, 'version'], { encoding: 'utf8', env: dockerEnvOnce() });
    const version = `${run.stdout}${run.stderr}`.trim();
    const serve = spawnSync('docker', ['run', '--rm', '--platform', 'linux/amd64', '-e', 'DATABASE_URL=nope', image, 'serve'], { encoding: 'utf8', env: dockerEnvOnce() });
    const configRefused = serve.status !== 0 && /DATABASE_URL must be a postgres:\/\/ URL/.test(`${serve.stdout}${serve.stderr}`);
    const listed = spawnSync('docker', ['run', '--rm', '--platform', 'linux/amd64', '--entrypoint', '/srv/server', image, 'help'], { encoding: 'utf8', env: dockerEnvOnce() });
    if (!digest) fail('image not found in Artifact Registry');
    if (version !== tag) fail(`image version ${version} != ${tag}`);
    if (!configRefused) fail(`serve did not refuse a bad config: ${(serve.stdout + serve.stderr).slice(-300)}`);
    if (listed.status !== 0) fail('help failed');
    const sizeMB = Math.round(size / 1_000_000);
    if (size && sizeMB >= 200) fail(`image is ${sizeMB} MB`);
    console.log(`IMAGE_OK sha=${tag} size=${sizeMB}MB digest=${digest.slice(0, 19)} static=bundled`);
  },
  jobs() {
    // jitter: none — a single migrator task per deploy (--tasks=1, --max-retries=0); nothing concurrent to spread [site scripts/deploy.mjs:130]
    const migrate = runJob('memoryz-migrate', 'migrate,up', '600s');
    if (!migrate.succeeded) fail(`migrate job failed: ${jobLogs(migrate.execution).slice(-1500)}`);
    const status = runJob('memoryz-migrate-status', 'migrate,status', '300s');
    const statusLog = jobLogs(status.execution);
    const pending = /"pending":\s*(\d+)/.exec(statusLog)?.[1] ?? /pending[^0-9]*(\d+)/.exec(statusLog)?.[1];
    const seed = runJob('memoryz-seed', 'seed-demo', '600s');
    const seedOk = seed.succeeded && /DEMO_SEED_OK/.test(jobLogs(seed.execution));
    if (!seedOk) fail(`seed job failed: ${jobLogs(seed.execution).slice(-1500)}`);
    console.log(`JOBS_OK migrate=succeeded pending=${pending ?? 'unknown'} seed=succeeded`);
  },
  service() {
    const current = describeService();
    const existing = current?.s.status?.url;
    // `--app-url https://memoryz.kr` moves the public origin to the custom domain once the load balancer
    // serves it (gcp-check domain-live). A later plain redeploy keeps whatever custom origin is configured,
    // so a routine release never reverts the cutover. With a custom origin the service accepts traffic only
    // from the load balancer (ingress internal-and-cloud-load-balancing); run.app stays open otherwise.
    const requested = args.includes('--app-url') ? args[args.indexOf('--app-url') + 1] : '';
    if (requested && !/^https:\/\/[a-z0-9.-]+$/.test(requested)) fail(`--app-url must be an https origin: ${requested}`);
    const custom = requested || (isCustom(current?.env.APP_URL) ? current.env.APP_URL : '');
    const ingress = custom ? 'internal-and-cloud-load-balancing' : 'all';
    // jitter: none — clients hold no persistent connections, so a new revision starts no reconnect wave [site scripts/deploy.mjs:152]
    const deploy = (appURL) => gcloud('run', 'deploy', SERVICE, `--region=${REGION}`, `--image=${image}`, `--service-account=${SA}`, '--platform=managed', '--allow-unauthenticated',
      '--min-instances=1', '--max-instances=3', '--concurrency=80', '--cpu=1', '--memory=1Gi', '--timeout=300', '--cpu-boost', '--port=8080', `--ingress=${ingress}`, '--execution-environment=gen2',
      `--set-cloudsql-instances=${SQL_INSTANCE}`, ...vpc, `--update-env-vars=${runtimeEnv(appURL)}`, `--update-secrets=${secretEnv},${requireOAuthSecrets()}`,
      // jitter: none — one startup probe per instance, paced from that instance's own start; the database check belongs here [site scripts/deploy.mjs:154]
      '--startup-probe=httpGet.path=/api/health,httpGet.port=8080,initialDelaySeconds=2,periodSeconds=3,failureThreshold=20,timeoutSeconds=3',
      // Liveness asks only whether the process serves HTTP (/api/live, no I/O): a liveness check that
      // needs the shared database would restart every instance together during a database blip.
      // The startup probe keeps the database check.
      // jitter: none — the shared-database restart wave is fixed structurally (/api/live), not by jitter [site scripts/deploy.mjs:155]
      '--liveness-probe=httpGet.path=/api/live,httpGet.port=8080,periodSeconds=30,failureThreshold=3,timeoutSeconds=3',
      '--labels=app=memoryz', '--format=value(status.url)');
    // APP_URL is the public origin and the production config refuses to start without it. Cloud Run's
    // deterministic URL (service-projectnumber.region.run.app) lets the first deploy be a real one; if the
    // platform hands out a different URL the service is deployed once more with it.
    let url = deploy(custom || existing || `https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app`);
    const configured = gcloud('run', 'services', 'describe', SERVICE, `--region=${REGION}`, '--format=value(spec.template.spec.containers[0].env)');
    if (!custom && !configured.includes(url)) url = deploy(url);
    // A prior rollback can pin traffic to an explicit revision. Deploying a new
    // image preserves that pin, so explicitly promote this release after startup.
    gcloud('run', 'services', 'update-traffic', SERVICE, `--region=${REGION}`, '--to-latest');
    console.log(`SERVICE_DEPLOYED ${custom || url} ingress=${ingress} image=${image}`);
  },
  'verify-service'() {
    const s = gcloudJSON('run', 'services', 'describe', SERVICE, `--region=${REGION}`);
    const t = s.spec.template;
    const a = t.metadata.annotations ?? {};
    const c = t.spec.containers[0];
    const envs = Object.fromEntries((c.env ?? []).map((e) => [e.name, e.value ?? `secret:${e.valueFrom?.secretKeyRef?.name}`]));
    const url = s.status.url;
    const problems = [];
    const expect = (ok, what) => { if (!ok) problems.push(what); };
    expect(a['autoscaling.knative.dev/minScale'] === '1', 'minScale 1');
    expect(a['autoscaling.knative.dev/maxScale'] === '3', 'maxScale 3');
    expect(t.spec.containerConcurrency === 80, 'concurrency 80');
    expect(t.spec.timeoutSeconds === 300, 'timeout 300');
    expect(t.spec.serviceAccountName === SA, 'service account');
    expect(c.resources.limits.cpu === '1' || c.resources.limits.cpu === '1000m', 'cpu 1');
    expect(c.resources.limits.memory === '1Gi', 'memory 1Gi');
    expect(a['run.googleapis.com/startup-cpu-boost'] === 'true', 'startup cpu boost');
    expect(a['run.googleapis.com/vpc-access-egress'] === 'private-ranges-only', 'vpc egress private-ranges-only');
    expect((a['run.googleapis.com/network-interfaces'] ?? '').includes('"network":"default"'), 'direct vpc network');
    expect(a['run.googleapis.com/cloudsql-instances'] === SQL_INSTANCE, 'cloud sql instance');
    expect(!!c.startupProbe?.httpGet && c.startupProbe.httpGet.path === '/api/health', 'startup probe');
    expect(!!c.livenessProbe?.httpGet && c.livenessProbe.httpGet.path === '/api/live', `liveness probe on /api/live (${c.livenessProbe?.httpGet?.path})`);
    for (const name of ['AUTH_SECRET', 'OPENROUTER_API_KEY', 'VALKEY_CA_PEM', 'TYPESAFE_API_KEY', ...['GOOGLE', 'NAVER', 'KAKAO'].flatMap((provider) => [`${provider}_CLIENT_ID`, `${provider}_CLIENT_SECRET`])]) expect(envs[name] === `secret:${name}`, `secret env ${name}`);
    expect(envs.AI_JUDGE === JUDGE_MODE && envs.TYPESAFE_MODEL === 'jev-latest', `judge ${envs.AI_JUDGE} ${envs.TYPESAFE_MODEL}`);
    expect(envs.ENV === 'production' && envs.OTEL_EXPORTER === 'gcp' && envs.DB_IAM_AUTH === 'true' && envs.BLOB_STORE === 'gcs' && envs.VALKEY_IAM_AUTH === 'true', 'runtime env');
    // The public origin is either the run.app URL (ingress all) or, after the cutover, the custom domain
    // behind the load balancer (ingress internal-and-cloud-load-balancing).
    const custom = isCustom(envs.APP_URL);
    const ingress = s.metadata.annotations?.['run.googleapis.com/ingress'];
    expect(custom ? envs.APP_URL === DOMAIN_ORIGIN : envs.APP_URL === url, `APP_URL ${envs.APP_URL} (run.app ${url}, domain ${DOMAIN_ORIGIN})`);
    expect(ingress === (custom ? 'internal-and-cloud-load-balancing' : 'all'), `ingress ${ingress}`);
    expect(custom ? envs.TRUSTED_PROXIES === lbAddress() : !envs.TRUSTED_PROXIES, `TRUSTED_PROXIES ${envs.TRUSTED_PROXIES ?? '(unset)'} (load balancer ${custom ? lbAddress() : 'none'})`);
    const latest = s.status.latestReadyRevisionName;
    expect(latest === s.status.latestCreatedRevisionName, 'newest revision is ready');
    expect(c.image === image, 'requested image is deployed');
    const revision = gcloudJSON('run', 'revisions', 'describe', latest, `--region=${REGION}`);
    expect(revision.status?.conditions?.some((condition) => condition.type === 'Active' && condition.status === 'True'), 'serving revision is active');
    const traffic = (s.status.traffic ?? []).find((x) => x.latestRevision || x.revisionName === latest);
    expect(traffic && traffic.percent === 100, 'latest revision takes 100% traffic');
    const ready = (s.status.conditions ?? []).find((x) => x.type === 'Ready')?.status;
    expect(ready === 'True', 'service ready');
    if (problems.length) fail(`SERVICE_NOT_OK: ${problems.join('; ')}`);
    console.log(`SERVICE_OK url=${envs.APP_URL} runUrl=${url} ingress=${ingress} revision=${latest} image=${c.image.split(':').pop()} ready=${ready}`);
  },
  sweep() {
    const job = runJob('memoryz-sweep', 'sweep', '900s');
    if (!job.succeeded) fail(`sweep job failed: ${jobLogs(job.execution).slice(-1500)}`);
    const name = 'memoryz-sweep';
    const uri = `https://${REGION}-run.googleapis.com/apis/run.v1/namespaces/${PROJECT}/jobs/${name}:run`;
    // jitter: none — one scheduler job, one actor, daily at 04:00 KST outside class and night-study hours [site scripts/deploy.mjs:208]
    const schedulerArgs = [`--location=${REGION}`, '--schedule=0 4 * * *', '--time-zone=Asia/Seoul', `--uri=${uri}`, '--http-method=POST', `--oauth-service-account-email=${SA}`, '--description=Daily cleanup of unlinked uploads and orphan blobs'];
    if (tryGcloud('scheduler', 'jobs', 'describe', name, `--location=${REGION}`)) gcloud('scheduler', 'jobs', 'update', 'http', name, ...schedulerArgs, '--format=value(name)');
    else gcloud('scheduler', 'jobs', 'create', 'http', name, ...schedulerArgs, '--format=value(name)');
    const s = gcloudJSON('scheduler', 'jobs', 'describe', name, `--location=${REGION}`);
    console.log(`SWEEP_OK job=succeeded schedule="${s.schedule}" tz=${s.timeZone}`);
  },
  async alerts() {
    // Cloud Monitoring through its REST API (no gcloud alpha/beta components needed). The uptime check
    // watches the origin learners use (the custom domain after the cutover).
    const host = new URL(publicOrigin()).host;
    const channels = (await monitoring('GET', 'notificationChannels')).notificationChannels ?? [];
    let channel = channels.find((c) => c.type === 'email' && c.labels?.email_address === ALERT_EMAIL)?.name;
    if (!channel) channel = (await monitoring('POST', 'notificationChannels', { type: 'email', displayName: 'memoryz ops', labels: { email_address: ALERT_EMAIL }, enabled: true })).name;
    const uptimes = (await monitoring('GET', 'uptimeCheckConfigs')).uptimeCheckConfigs ?? [];
    let uptime = uptimes.find((u) => u.displayName === 'memoryz-health');
    const uptimeBody = {
      displayName: 'memoryz-health',
      monitoredResource: { type: 'uptime_url', labels: { project_id: PROJECT, host } },
      httpCheck: { path: '/api/health', port: 443, useSsl: true, validateSsl: true, requestMethod: 'GET', acceptedResponseStatusCodes: [{ statusClass: 'STATUS_CLASS_2XX' }], contentType: 'TYPE_UNSPECIFIED' },
      contentMatchers: [{ content: '"database":"connected"', matcher: 'CONTAINS_STRING' }],
      // jitter: none — about 3 external checks a minute on Google's own schedule, unrelated to class timing [site scripts/deploy.mjs:228]
      period: '60s',
      timeout: '10s',
      selectedRegions: ['ASIA_PACIFIC', 'USA_OREGON', 'EUROPE'],
    };
    // The monitored resource (host) of a check is immutable: a host change makes a new check, repoints
    // the policy below, and removes the old check afterwards.
    let replaced = null;
    if (uptime && uptime.monitoredResource?.labels?.host !== host) {
      replaced = uptime;
      uptime = null;
    }
    if (!uptime) uptime = await monitoring('POST', 'uptimeCheckConfigs', uptimeBody);
    else {
      // The monitored resource of an existing check is immutable; everything else is updated in place.
      const { monitoredResource, ...mutable } = uptimeBody;
      uptime = await monitoring('PATCH', uptime.name.replace(`projects/${PROJECT}/`, '') + '?updateMask=httpCheck,contentMatchers,period,timeout,selectedRegions', { ...mutable, name: uptime.name });
    }
    const checkId = uptime.name.split('/').pop();
    const agg = (aligner, reducer, period = '300s', groupBy = ['resource.label.service_name']) => [{ alignmentPeriod: period, perSeriesAligner: aligner, crossSeriesReducer: reducer, groupByFields: groupBy }];
    const policies = [
      { displayName: 'memoryz: health check failing', conditionThreshold: { filter: `metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND resource.type="uptime_url" AND metric.label.check_id="${checkId}"`, aggregations: [{ alignmentPeriod: '120s', perSeriesAligner: 'ALIGN_NEXT_OLDER', crossSeriesReducer: 'REDUCE_COUNT_FALSE', groupByFields: ['resource.label.*'] }], comparison: 'COMPARISON_GT', thresholdValue: 1, duration: '120s', trigger: { count: 1 } } },
      // A 10 s bell is invisible in a 300 s ratio, so a 60 s count of 5xx answers sits beside it and
      // opens an incident on the first minute over 10 (no retest window). A client that left is a
      // 499, not a 5xx, so a classroom Wi-Fi drop does not trip it.
      // jitter: none — alerting windows that only read metrics; the 60 s 5xx count sits beside the 300 s ones [site scripts/deploy.mjs:249]
      { displayName: 'memoryz: 5xx ratio above 2%', conditionThreshold: { filter: `metric.type="run.googleapis.com/request_count" AND resource.type="cloud_run_revision" AND resource.label.service_name="${SERVICE}" AND metric.label.response_code_class="5xx"`, aggregations: agg('ALIGN_RATE', 'REDUCE_SUM'), denominatorFilter: `metric.type="run.googleapis.com/request_count" AND resource.type="cloud_run_revision" AND resource.label.service_name="${SERVICE}"`, denominatorAggregations: agg('ALIGN_RATE', 'REDUCE_SUM'), comparison: 'COMPARISON_GT', thresholdValue: 0.02, duration: '300s', trigger: { count: 1 } },
        extra: [{ displayName: 'memoryz: 5xx burst (10 in 60 s)', conditionThreshold: { filter: `metric.type="run.googleapis.com/request_count" AND resource.type="cloud_run_revision" AND resource.label.service_name="${SERVICE}" AND metric.label.response_code_class="5xx"`, aggregations: agg('ALIGN_DELTA', 'REDUCE_SUM', '60s'), comparison: 'COMPARISON_GT', thresholdValue: 10, duration: '0s', trigger: { count: 1 } } }] },
      { displayName: 'memoryz: p95 latency above 1s', conditionThreshold: { filter: `metric.type="run.googleapis.com/request_latencies" AND resource.type="cloud_run_revision" AND resource.label.service_name="${SERVICE}"`, aggregations: agg('ALIGN_DELTA', 'REDUCE_PERCENTILE_95'), comparison: 'COMPARISON_GT', thresholdValue: 1000, duration: '300s', trigger: { count: 1 } } },
      { displayName: 'memoryz: db pool saturated', conditionThreshold: { filter: `metric.type="prometheus.googleapis.com/memoryz.db.pool.connections/gauge" AND resource.type="prometheus_target" AND metric.label.state="acquired"`, aggregations: agg('ALIGN_MAX', 'REDUCE_MAX', '300s', []), comparison: 'COMPARISON_GT', thresholdValue: 5, duration: '300s', trigger: { count: 1 } } },
      // The shared-core db-f1-micro is the first thing to saturate; its disk grows with uploads' text.
      { displayName: 'memoryz: Cloud SQL CPU above 80%', conditionThreshold: { filter: `metric.type="cloudsql.googleapis.com/database/cpu/utilization" AND resource.type="cloudsql_database" AND resource.label.database_id="${SQL_INSTANCE.split(':').filter((_, i) => i !== 1).join(':')}"`, aggregations: agg('ALIGN_MEAN', 'REDUCE_MAX', '300s', ['resource.label.database_id']), comparison: 'COMPARISON_GT', thresholdValue: 0.8, duration: '300s', trigger: { count: 1 } } },
      { displayName: 'memoryz: Cloud SQL disk above 85%', conditionThreshold: { filter: `metric.type="cloudsql.googleapis.com/database/disk/utilization" AND resource.type="cloudsql_database" AND resource.label.database_id="${SQL_INSTANCE.split(':').filter((_, i) => i !== 1).join(':')}"`, aggregations: agg('ALIGN_MEAN', 'REDUCE_MAX', '300s', ['resource.label.database_id']), comparison: 'COMPARISON_GT', thresholdValue: 0.85, duration: '600s', trigger: { count: 1 } } },
    ];
    const existing = (await monitoring('GET', 'alertPolicies')).alertPolicies ?? [];
    for (const p of policies) {
      const body = { displayName: p.displayName, combiner: 'OR', enabled: true, notificationChannels: [channel], documentation: { content: `docs/OBSERVABILITY.md 의 알림 정책. 서비스 ${SERVICE} (${REGION}).`, mimeType: 'text/markdown' }, conditions: [{ displayName: p.displayName, conditionThreshold: p.conditionThreshold }, ...(p.extra ?? [])] };
      const found = existing.find((x) => x.displayName === p.displayName);
      if (found) await monitoring('PATCH', found.name.replace(`projects/${PROJECT}/`, '') + '?updateMask=displayName,combiner,enabled,notificationChannels,documentation,conditions', body);
      else await monitoring('POST', 'alertPolicies', body);
    }
    if (replaced) await monitoring('DELETE', replaced.name.replace(`projects/${PROJECT}/`, ''));
    console.log(`ALERTS_CONFIGURED uptime=${checkId} host=${host} channel=${channel.split('/').pop()}${replaced ? ` replaced=${replaced.monitoredResource?.labels?.host}` : ''}`);
  },
  async 'verify-alerts'() {
    const checks = ((await monitoring('GET', 'uptimeCheckConfigs')).uptimeCheckConfigs ?? []).filter((u) => u.displayName === 'memoryz-health');
    const uptime = checks.length;
    const host = checks[0]?.monitoredResource?.labels?.host;
    const wanted = new URL(publicOrigin()).host;
    const channels = ((await monitoring('GET', 'notificationChannels')).notificationChannels ?? []).filter((c) => c.labels?.email_address === ALERT_EMAIL);
    const policies = ((await monitoring('GET', 'alertPolicies')).alertPolicies ?? []).filter((p) => p.displayName?.startsWith('memoryz: ') && p.enabled && (p.notificationChannels ?? []).some((c) => channels.some((ch) => ch.name === c)));
    // The health policy must watch the current check, not a replaced one.
    const checkId = checks[0]?.name.split('/').pop();
    const healthPolicy = policies.find((p) => p.displayName === 'memoryz: health check failing');
    const watches = !!checkId && JSON.stringify(healthPolicy?.conditions ?? []).includes(`check_id=\\"${checkId}\\"`);
    // The 5xx policy carries the 300 s ratio and the 60 s burst count.
    const errors = policies.find((p) => p.displayName === 'memoryz: 5xx ratio above 2%');
    // The burst condition opens an incident on the first minute over 10 (no retest window: a 60 s
    // duration would need two bad minutes in a row, missing the one-minute bell it exists for).
    const burst = (errors?.conditions ?? []).some((c) => c.conditionThreshold?.aggregations?.[0]?.alignmentPeriod === '60s' && (c.conditionThreshold?.duration ?? '0s') === '0s');
    if (uptime !== 1 || host !== wanted || !watches || channels.length < 1 || policies.length !== 6 || !burst) fail(`ALERTS_NOT_OK uptime=${uptime} host=${host} wanted=${wanted} policyWatchesCheck=${watches} channels=${channels.length} policies=${policies.length} burst60s=${burst}`);
    console.log(`ALERTS_OK uptime=${uptime} host=${host} channels=1 policies=${policies.length} burst60s=${burst}`);
  },
  'verify-oauth'() {
    const versions = (name) => (tryGcloud('secrets', 'versions', 'list', name, '--filter=state=ENABLED', '--format=value(name)') ?? '').split('\n').filter(Boolean).length;
    const accessor = (name) => { const pol = tryGcloud('secrets', 'get-iam-policy', name, '--format=json'); return !!pol && (JSON.parse(pol).bindings ?? []).some((b) => b.role === 'roles/secretmanager.secretAccessor' && b.members.includes(`serviceAccount:${SA}`)); };
    for (const name of oauthSecretNames) {
      const enabled = versions(name);
      const allowed = accessor(name);
      if (!enabled || !allowed) fail(`OAUTH_SECRETS_NOT_OK ${name} enabled=${enabled} accessor=${allowed}`);
    }
    console.log(`OAUTH_SECRETS_OK providers=3 secrets=${oauthSecretNames.length} accessor=true`);
  },
  'verify-judge'() {
    const name = 'TYPESAFE_API_KEY';
    const enabled = (tryGcloud('secrets', 'versions', 'list', name, '--filter=state=ENABLED', '--format=value(name)') ?? '').split('\n').filter(Boolean).length;
    const pol = tryGcloud('secrets', 'get-iam-policy', name, '--format=json');
    const accessor = !!pol && (JSON.parse(pol).bindings ?? []).some((b) => b.role === 'roles/secretmanager.secretAccessor' && b.members.includes(`serviceAccount:${SA}`));
    const wired = secretEnv.includes(`${name}=${name}:latest`) && runtimeEnv('').includes(`AI_JUDGE=${JUDGE_MODE}`);
    if (!enabled || !accessor || !wired) fail(`JUDGE_SECRET_NOT_OK enabled=${enabled} accessor=${accessor} wired=${wired}`);
    console.log(`JUDGE_SECRET_OK secret=${name} versions=${enabled} accessor=true mode=${JUDGE_MODE}`);
  },
};
if (!commands[command]) {
  console.error(`usage: node scripts/deploy.mjs ${Object.keys(commands).join('|')} [--tag <tag>]`);
  process.exit(2);
}
await commands[command]();
