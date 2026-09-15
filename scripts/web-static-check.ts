// Gate leaf-2.1 W2/W4 (and leaf-2.2 D2): the static build served by the Go server, over HTTP and
// in a real headless Chrome. Sections: shell (paths, headers, gate), compression (precompressed
// siblings), browser (demo login, home renders bootstrap data, no console errors), materials
// (leaf-2.2: excerpt list, lazy detail fetch). `--only=a,b` limits the run; `WEB_STATIC_OK` is
// printed only when every selected section passed.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, openPage } from './lib/browser';
import { demoLogin, serveStatic } from './lib/goserve';

const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '--only=shell,compression,browser').slice(7).split(',');
let checks = 0;
const check = (ok: unknown, message: string) => {
  assert.ok(ok, message);
  checks++;
};
const server = await serveStatic();
const { url } = server;
const get = (path: string, init: RequestInit = {}) => fetch(url + path, { redirect: 'manual', ...init });
try {
  if (only.includes('shell')) {
    const student = await demoLogin(url, 'STUDENT');
    for (const path of ['/', '/study', '/subjects/abc', '/planner']) {
      const res = await get(path);
      const html = await res.text();
      check(res.status === 200 && /text\/html/.test(res.headers.get('content-type') ?? '') && res.headers.get('cache-control') === 'no-cache' && /^"[^"]+"$|^W\/"[^"]+"$/.test(res.headers.get('etag') ?? '') && /\/_next\/static\//.test(html), `${path} is the shell (${res.status} ${res.headers.get('cache-control')} ${res.headers.get('etag')})`);
    }
    const exported = await get('/study');
    const root = await get('/');
    check((await exported.text()).length > 1000 && (await root.text()).length > 1000, 'exported route pages are full documents');
    const sw = await get('/sw.js');
    check(sw.status === 200 && sw.headers.get('cache-control') === 'no-cache, no-store, must-revalidate' && /javascript/.test(sw.headers.get('content-type') ?? ''), `sw.js headers ${sw.status} ${sw.headers.get('cache-control')}`);
    const manifest = await get('/manifest.webmanifest');
    check(manifest.status === 200 && /manifest\+json|application\/json/.test(manifest.headers.get('content-type') ?? ''), `manifest ${manifest.status} ${manifest.headers.get('content-type')}`);
    const headers = await get('/');
    check(headers.headers.get('x-content-type-options') === 'nosniff' && headers.headers.get('x-frame-options') === 'DENY' && headers.headers.get('referrer-policy') === 'strict-origin-when-cross-origin', 'security headers on the shell');
    const gated = await get('/parent', { headers: { cookie: student.header } });
    check(gated.status === 403 && /이 계정에서 볼 수 없는 화면이에요/.test(await gated.text()), `student on /parent is the 403 page (${gated.status})`);
    const broken = await get('/study', { headers: { cookie: 'memoryz_session=' + 'a'.repeat(64) } });
    check(broken.status === 302 && broken.headers.get('location') === '/', `broken cookie on /study goes home (${broken.status})`);
    const missing = await get('/api/nope');
    check(missing.status === 404 && /json/.test(missing.headers.get('content-type') ?? ''), 'unknown api path is a JSON 404');
    const notFile = await get('/_next/static/nope.js');
    check(notFile.status === 404, 'a missing static asset is 404, not the shell');
  }

  if (only.includes('compression')) {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
    const files = walk('out').filter((f) => /\.(html|js|css|svg|json|webmanifest|txt)$/.test(f) && statSync(f).size >= 1024);
    const missingBr = files.filter((f) => !existsSync(f + '.br') || statSync(f + '.br').size >= statSync(f).size);
    const missingGz = files.filter((f) => !existsSync(f + '.gz') || statSync(f + '.gz').size >= statSync(f).size);
    check(files.length > 10 && missingBr.length === 0 && missingGz.length === 0, `every compressible file has smaller .br/.gz siblings (${files.length} files; missing br=${missingBr.slice(0, 3)} gz=${missingGz.slice(0, 3)})`);
    const chunk = files.find((f) => f.startsWith('out/_next/static/') && f.endsWith('.js'))!.slice(3);
    const br = await get(chunk, { headers: { 'accept-encoding': 'br' } });
    check(br.status === 200 && br.headers.get('content-encoding') === 'br' && /javascript/.test(br.headers.get('content-type') ?? '') && /accept-encoding/i.test(br.headers.get('vary') ?? '') && br.headers.get('cache-control') === 'public, max-age=31536000, immutable', `brotli chunk ${br.status} ${br.headers.get('content-encoding')} ${br.headers.get('content-type')} ${br.headers.get('cache-control')}`);
    const gz = await get(chunk, { headers: { 'accept-encoding': 'gzip' } });
    check(gz.status === 200 && gz.headers.get('content-encoding') === 'gzip', `gzip chunk ${gz.headers.get('content-encoding')}`);
    const plain = await get(chunk, { headers: { 'accept-encoding': 'identity' } });
    const identity = await plain.arrayBuffer();
    check(plain.status === 200 && !plain.headers.get('content-encoding') && identity.byteLength === statSync('out' + chunk).size, 'identity serves the original bytes');
    const brBytes = await br.arrayBuffer();
    check(brBytes.byteLength === identity.byteLength, 'fetch transparently decodes brotli to the same bytes');
    const shellBr = await get('/', { headers: { 'accept-encoding': 'br' } });
    check(shellBr.status === 200 && /text\/html/.test(shellBr.headers.get('content-type') ?? ''), 'the shell answers a brotli-accepting client');
  }

  if (only.includes('browser') || only.includes('materials')) {
    const student = await demoLogin(url, 'STUDENT');
    const chrome = await launchChrome();
    try {
      const page = await openPage(chrome.cdp, { width: 390, height: 844, cookie: { name: student.name, value: student.value } });
      const errors: string[] = [];
      const requests: string[] = [];
      chrome.cdp.on((m) => {
        if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text ?? 'exception');
        if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(JSON.stringify(m.params.args.map((a: any) => a.value ?? a.description)));
        if (m.method === 'Network.requestWillBeSent') requests.push(new URL(m.params.request.url).pathname);
      });
      if (only.includes('browser')) {
        await page.send('Page.navigate', { url: url + '/' });
        try {
          await page.waitUntil(`document.body && document.body.innerText.includes('김지우')`, 'home renders bootstrap data', 15000);
        } catch (error) {
          const text: string = await page.evaluate('document.body ? document.body.innerText.slice(0, 400) : ""');
          throw new Error(`${(error as Error).message}; page text: ${JSON.stringify(text)}; console errors: ${errors.slice(0, 3).join(' | ')}; requests: ${requests.slice(0, 12).join(',')}`);
        }
        const text: string = await page.evaluate('document.body.innerText');
        check(/김지우|과목/.test(text), `home shows the demo student's data: ${text.slice(0, 80).replace(/\n/g, ' ')}`);
        check(requests.some((p) => p === '/api/bootstrap'), 'the app called /api/bootstrap');
        await page.send('Page.navigate', { url: url + '/study' });
        await page.waitUntil(`location.pathname === '/study' && document.body.innerText.length > 50`, 'study screen', 15000);
        check(errors.length === 0, `no console errors: ${errors.slice(0, 3).join(' | ')}`);
      }
      if (only.includes('materials')) {
        requests.length = 0;
        await page.send('Page.navigate', { url: url + '/study' });
        await page.waitUntil(`document.body.innerText.includes('과목')`, 'study screen', 15000);
        const subjectId: string = await page.evaluate(`(async()=>{const r=await fetch('/api/bootstrap');const j=await r.json();const m=j.data.materials[0];return m?m.subjectId+':'+m.id+':'+('content' in m):''})()`);
        check(subjectId && subjectId.endsWith(':false'), `bootstrap materials carry no content (${subjectId})`);
        const [sid, mid] = subjectId.split(':');
        await page.send('Page.navigate', { url: `${url}/subjects/${sid}` });
        await page.waitUntil(`document.querySelector('[data-material-id]')`, 'material list', 15000);
        check(!requests.some((p) => p.startsWith('/api/materials/')), 'listing materials fetches no detail');
        const open = async () => {
          await page.click(`[data-material-id="${mid}"]`);
          await page.waitFor('[data-material-open]', 10000);
          await page.click('[data-material-open]');
          await page.waitUntil(`document.querySelector('[data-material-content]') && document.querySelector('[data-material-content]').textContent.length > 20`, 'material body', 15000);
        };
        await open();
        check(requests.filter((p) => p === `/api/materials/${mid}`).length === 1, 'opening a material fetches its detail once');
        await page.click('[data-close-material]');
        await page.waitUntil(`!document.querySelector('[data-material-content]')`, 'viewer closed', 10000);
        await page.evaluate(`document.querySelector('[data-close-sheet]') && document.querySelector('[data-close-sheet]').click()`);
        await open();
        check(requests.filter((p) => p === `/api/materials/${mid}`).length === 1, 'reopening the same material is served from memory');
        check(errors.length === 0, `no console errors: ${errors.slice(0, 3).join(' | ')}`);
        console.log('MATERIALS_LAZY_OK');
      }
    } finally {
      await chrome.close();
    }
  }
  console.log(`WEB_STATIC_OK (${checks} checks)`);
} catch (error) {
  console.error(error);
  console.error(`--- server (tail) ---\n${server.output().slice(-2000)}`);
  process.exitCode = 1;
} finally {
  await server.stop();
}
