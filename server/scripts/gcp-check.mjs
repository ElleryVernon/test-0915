// Read-only checks of the memoryz-prod infrastructure (gates leaf-3.1 I1–I4). Every gcloud call
// goes through the dedicated `memoryz` configuration and only describes or lists; nothing here
// mutates a resource or reads a secret's value.
// Usage: node server/scripts/gcp-check.mjs project|sql|valkey|infra
import { execFileSync } from 'node:child_process';

const PROJECT = 'memoryz-prod';
const REGION = 'asia-northeast3';
const BILLING = '0129C6-80A834-97FE3F';
const SA = 'serviceAccount:memoryz-run@memoryz-prod.iam.gserviceaccount.com';

const gcloud = (...args) =>
  execFileSync('gcloud', args, { encoding: 'utf8', env: { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: 'memoryz' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const json = (...args) => JSON.parse(gcloud(...args, '--format=json'));
const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

const checks = {
  project() {
    const state = gcloud('projects', 'describe', PROJECT, '--format=value(lifecycleState)');
    const billing = gcloud('billing', 'projects', 'describe', PROJECT, '--format=value(billingAccountName,billingEnabled)');
    const apis = lines(gcloud('services', 'list', '--enabled', `--project=${PROJECT}`, '--format=value(config.name)'));
    const need = ['sqladmin', 'memorystore', 'run', 'storage', 'secretmanager', 'artifactregistry', 'servicenetworking', 'networkconnectivity', 'cloudtrace', 'monitoring', 'logging', 'telemetry'].map((s) => `${s}.googleapis.com`);
    const missing = need.filter((a) => !apis.includes(a));
    // The developer's default configuration must remain untouched.
    const configs = execFileSync('gcloud', ['config', 'configurations', 'list', '--format=value(name,is_active,properties.core.project)'], { encoding: 'utf8' });
    const defaultActive = /^default\s+True\s+sinsin-486209$/m.test(configs);
    const ok = state === 'ACTIVE' && billing.includes(BILLING) && /True/.test(billing) && missing.length === 0 && defaultActive;
    return [ok, `PROJECT_READY ${state} apis=${apis.length}`, `PROJECT_NOT_READY state=${state} billing=${billing} missing=${missing} defaultActive=${defaultActive}`];
  },
  sql() {
    const i = json('sql', 'instances', 'describe', 'memoryz-pg', `--project=${PROJECT}`);
    const flags = (i.settings.databaseFlags ?? []).map((f) => `${f.name}=${f.value}`);
    const ips = (i.ipAddresses ?? []).map((a) => a.type);
    const dbs = lines(gcloud('sql', 'databases', 'list', '--instance=memoryz-pg', `--project=${PROJECT}`, '--format=value(name)'));
    const users = lines(gcloud('sql', 'users', 'list', '--instance=memoryz-pg', `--project=${PROJECT}`, '--format=value(name)'));
    const ok =
      i.state === 'RUNNABLE' && i.region === REGION && /^POSTGRES_1[78]$/.test(i.databaseVersion) && flags.includes('cloudsql.iam_authentication=on') &&
      ips.includes('PRIVATE') && ips.includes('PRIMARY') && !(i.settings.ipConfiguration.authorizedNetworks ?? []).length &&
      i.settings.deletionProtectionEnabled === true && dbs.includes('memoryz') && users.includes('memoryz-run@memoryz-prod.iam');
    const detail = `${i.state} ${i.databaseVersion} ${i.settings.tier} ips=${ips} flags=${flags} dbs=${dbs.length} users=${users.length} deletionProtection=${i.settings.deletionProtectionEnabled}`;
    return [ok, `SQL_READY ${detail}`, `SQL_NOT_READY ${detail}`];
  },
  valkey() {
    const v = json('memorystore', 'instances', 'describe', 'memoryz-cache', `--location=${REGION}`, `--project=${PROJECT}`);
    const endpoints = JSON.stringify(v.endpoints ?? v.discoveryEndpoints ?? v.pscAutoConnections ?? '');
    const ok = v.state === 'ACTIVE' && v.nodeType === 'SHARED_CORE_NANO' && /CLUSTER_DISABLED/.test(v.mode ?? '') && /10\.|172\.|192\./.test(endpoints) &&
      v.authorizationMode === 'IAM_AUTH' && v.transitEncryptionMode === 'SERVER_AUTHENTICATION';
    const detail = `${v.state} ${v.nodeType} ${v.mode} ${v.engineVersion} auth=${v.authorizationMode} tls=${v.transitEncryptionMode}`;
    return [ok, `VALKEY_READY ${detail}`, `VALKEY_NOT_READY ${detail} endpoints=${endpoints}`];
  },
  infra() {
    const b = json('storage', 'buckets', 'describe', 'gs://memoryz-prod-uploads');
    const ar = gcloud('artifacts', 'repositories', 'describe', 'memoryz', `--location=${REGION}`, `--project=${PROJECT}`, '--format=value(format)');
    const policy = json('projects', 'get-iam-policy', PROJECT);
    const roles = policy.bindings.filter((x) => x.members.includes(SA)).map((x) => x.role);
    // telemetry.* are the OTLP ingestion roles (telemetry.googleapis.com); cloudtrace/monitoring stay for the console.
    const need = ['roles/cloudsql.client', 'roles/cloudsql.instanceUser', 'roles/logging.logWriter', 'roles/monitoring.metricWriter', 'roles/cloudtrace.agent', 'roles/memorystore.dbConnectionUser', 'roles/telemetry.tracesWriter', 'roles/telemetry.metricsWriter'];
    const missingRoles = need.filter((r) => !roles.includes(r));
    const bucketPolicy = json('storage', 'buckets', 'get-iam-policy', 'gs://memoryz-prod-uploads');
    const bucketOk = bucketPolicy.bindings.some((x) => x.role === 'roles/storage.objectAdmin' && x.members.includes(SA));
    const secrets = ['AUTH_SECRET', 'DB_PASSWORD', 'OPENROUTER_API_KEY'];
    const secretState = secrets.map((s) => {
      const versions = lines(gcloud('secrets', 'versions', 'list', s, `--project=${PROJECT}`, '--filter=state=ENABLED', '--format=value(name)'));
      const accessor = json('secrets', 'get-iam-policy', s, `--project=${PROJECT}`).bindings?.some((x) => x.role === 'roles/secretmanager.secretAccessor' && x.members.includes(SA)) ?? false;
      return `${s}:${versions.length}v:${accessor ? 'accessor' : 'NO-ACCESSOR'}`;
    });
    const secretsOk = secretState.every((s) => /:[1-9]\d*v:accessor$/.test(s));
    // `gcloud storage buckets describe` uses snake_case keys.
    const ok = b.location === 'ASIA-NORTHEAST3' && b.uniform_bucket_level_access === true && b.public_access_prevention === 'enforced' &&
      ar === 'DOCKER' && missingRoles.length === 0 && bucketOk && secretsOk;
    const detail = `bucket=${b.location}/ubla=${b.uniform_bucket_level_access}/${b.public_access_prevention} ar=${ar} missingRoles=${missingRoles} bucketIam=${bucketOk} secrets=${secretState.join(',')}`;
    return [ok, `INFRA_READY ${detail}`, `INFRA_NOT_READY ${detail}`];
  },
  // memoryz.kr: Cloud DNS zone, records, and the global HTTPS load balancer in front of Cloud Run (docs/CLOUD.md 도메인).
  domain() {
    const zone = json('dns', 'managed-zones', 'describe', 'memoryz-kr', `--project=${PROJECT}`);
    const ns = (zone.nameServers ?? []).filter((n) => /^ns-cloud-[a-e][1-4]\.googledomains\.com\.$/.test(n));
    const dnssec = zone.dnssecConfig?.state === 'on';
    const ip = gcloud('compute', 'addresses', 'describe', 'memoryz-ip', '--global', `--project=${PROJECT}`, '--format=value(address)');
    const records = json('dns', 'record-sets', 'list', '--zone=memoryz-kr', `--project=${PROJECT}`);
    const a = (name) => records.find((r) => r.name === name && r.type === 'A');
    const rootOk = a('memoryz.kr.')?.rrdatas?.[0] === ip && a('www.memoryz.kr.')?.rrdatas?.[0] === ip;
    // Only Google's CAs may issue for the domain (the managed certificate uses one of them).
    const caa = (records.find((r) => r.name === 'memoryz.kr.' && r.type === 'CAA')?.rrdatas ?? []).slice().sort().join('|');
    const caaOk = caa === '0 issue "letsencrypt.org"|0 issue "pki.goog"';
    const neg = json('compute', 'network-endpoint-groups', 'describe', 'memoryz-neg', `--region=${REGION}`, `--project=${PROJECT}`);
    const backend = json('compute', 'backend-services', 'describe', 'memoryz-backend', '--global', `--project=${PROJECT}`);
    const lbMap = json('compute', 'url-maps', 'describe', 'memoryz-lb', `--project=${PROJECT}`);
    const urlMap = lbMap.defaultService ?? '';
    // www is served only as a 301 to the apex, on both ports.
    const wwwToApex = (map) => {
      const rule = (map.hostRules ?? []).find((h) => (h.hosts ?? []).includes('www.memoryz.kr'));
      const redirect = (map.pathMatchers ?? []).find((m) => m.name === rule?.pathMatcher)?.defaultUrlRedirect;
      return redirect?.hostRedirect === 'memoryz.kr' && redirect?.httpsRedirect === true && redirect?.redirectResponseCode === 'MOVED_PERMANENTLY_DEFAULT';
    };
    const cert = json('compute', 'ssl-certificates', 'describe', 'memoryz-cert', '--global', `--project=${PROJECT}`);
    const https = json('compute', 'forwarding-rules', 'describe', 'memoryz-https', '--global', `--project=${PROJECT}`);
    const http = json('compute', 'forwarding-rules', 'describe', 'memoryz-http', '--global', `--project=${PROJECT}`);
    const redirect = json('compute', 'url-maps', 'describe', 'memoryz-http-redirect', `--project=${PROJECT}`);
    const certDomains = (cert.managed?.domains ?? []).slice().sort().join(',');
    const lbOk = neg.networkEndpointType === 'SERVERLESS' && neg.cloudRun?.service === 'memoryz' &&
      backend.loadBalancingScheme === 'EXTERNAL_MANAGED' && (backend.backends ?? []).some((b) => /memoryz-neg$/.test(b.group)) &&
      /memoryz-backend$/.test(urlMap) && certDomains === 'memoryz.kr,www.memoryz.kr' &&
      https.IPAddress === ip && https.portRange === '443-443' && /memoryz-https-proxy$/.test(https.target) &&
      http.IPAddress === ip && http.portRange === '80-80' && /memoryz-http-proxy$/.test(http.target) &&
      redirect.defaultUrlRedirect?.httpsRedirect === true && redirect.defaultUrlRedirect?.redirectResponseCode === 'MOVED_PERMANENTLY_DEFAULT' &&
      wwwToApex(lbMap) && wwwToApex(redirect);
    const ok = ns.length === 4 && dnssec && rootOk && caaOk && lbOk;
    const detail = `zone=${zone.dnsName} ns=${ns.length} dnssec=${zone.dnssecConfig?.state} ip=${ip} records=${rootOk} caa=${caaOk} lb=${lbOk ? 'ready' : 'incomplete'} www=${wwwToApex(lbMap) && wwwToApex(redirect) ? 'apex' : 'served'} cert=${cert.managed?.status}`;
    return [ok, `DOMAIN_INFRA_OK ${detail}`, `DOMAIN_INFRA_NOT_READY ${detail}`];
  },
  // After the registrar delegates: public NS, certificate ACTIVE, the site answers on https, http redirects.
  'domain-live'() {
    const dig = (type, name) => { try { return execFileSync('dig', ['+short', type, name, '@8.8.8.8'], { encoding: 'utf8' }).trim(); } catch { return ''; } };
    const nsPublic = lines(dig('NS', 'memoryz.kr'));
    const delegated = nsPublic.length >= 2 && nsPublic.every((n) => /^ns-cloud-e[1-4]\.googledomains\.com\.$/.test(n));
    const cert = json('compute', 'ssl-certificates', 'describe', 'memoryz-cert', '--global', `--project=${PROJECT}`);
    const active = cert.managed?.status === 'ACTIVE';
    // Requests go to the address public DNS gives (not this machine's possibly stale resolver cache).
    const publicA = (name) => lines(dig('A', name))[0] ?? '';
    const pin = ['memoryz.kr', 'www.memoryz.kr'].flatMap((h) => [80, 443].map((port) => ['--resolve', `${h}:${port}:${publicA(h)}`])).flat();
    const curl = (...args) => { try { return execFileSync('curl', ['-sS', '--max-time', '15', ...pin, ...args], { encoding: 'utf8' }); } catch (e) { return `ERR ${e.message.split('\n')[0]}`; } };
    const health = curl('https://memoryz.kr/api/health');
    // The load balancer writes the default port into Location ("https://memoryz.kr:443/"); URL parsing
    // drops it, which is also what browsers do.
    const redirectOf = (target) => {
      const [code, location = ''] = curl('-o', '/dev/null', '-w', '%{http_code} %{redirect_url}', target).trim().split(' ');
      try { return `${code} ${new URL(location).href}`; } catch { return `${code} ${location}`; }
    };
    const redirect = redirectOf('http://memoryz.kr/');
    const wwwHttps = redirectOf('https://www.memoryz.kr/study?x=1');
    const wwwHttp = redirectOf('http://www.memoryz.kr/');
    const healthOk = /"status"\s*:\s*"ok"/.test(health);
    const redirectOk = redirect === '301 https://memoryz.kr/';
    const wwwOk = wwwHttps === '301 https://memoryz.kr/study?x=1' && wwwHttp === '301 https://memoryz.kr/';
    const ok = delegated && active && healthOk && redirectOk && wwwOk;
    const detail = `publicNS=${nsPublic.join('|') || 'none'} cert=${cert.managed?.status} health=${healthOk ? 'ok' : health.slice(0, 80)} http=${redirect} www=${wwwHttps}|${wwwHttp}`;
    return [ok, `DOMAIN_LIVE_OK ${detail}`, `DOMAIN_NOT_LIVE ${detail}`];
  },
  // DNSSEC end to end: the registrar published the zone's DS, and a validating resolver marks answers authenticated.
  dnssec() {
    const ds = gcloud('dns', 'dns-keys', 'describe', '0', '--zone=memoryz-kr', `--project=${PROJECT}`, '--format=value(ds_record())');
    let parent = '';
    let flags = '';
    try { parent = execFileSync('dig', ['+short', 'DS', 'memoryz.kr', '@8.8.8.8'], { encoding: 'utf8' }).trim(); } catch {}
    try { flags = execFileSync('dig', ['+dnssec', 'A', 'memoryz.kr', '@8.8.8.8'], { encoding: 'utf8' }).match(/;; flags:([^;]*);/)?.[1] ?? ''; } catch {}
    const norm = (v) => v.toUpperCase().replace(/\s+/g, ' ').trim();
    const published = parent.split('\n').some((line) => line && norm(line) === norm(ds));
    const authenticated = /\bad\b/.test(flags);
    const ok = published && authenticated;
    const detail = `zoneDS="${ds}" parentDS=${parent ? parent.split('\n').length : 0} match=${published} flags=[${flags.trim()}]`;
    return [ok, `DNSSEC_SECURE ${detail}`, `DNSSEC_NOT_SECURE ${detail}`];
  },
};

const which = process.argv[2];
if (!checks[which]) {
  console.error(`usage: node server/scripts/gcp-check.mjs ${Object.keys(checks).join('|')}`);
  process.exit(2);
}
const [ok, pass, fail] = checks[which]();
console.log(ok ? pass : fail);
process.exit(ok ? 0 : 1);
