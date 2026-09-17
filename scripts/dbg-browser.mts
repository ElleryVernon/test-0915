import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { db, useServer } from './lib/db';
import { createSession } from './lib/session';
import { serveStatic } from './lib/goserve';
import { launchChrome, openPage, consoleErrors } from './lib/browser';

const prefix = 'qa-dbg-' + randomUUID();
const server = await serveStatic();
useServer(server.url);
const base = server.url;
const u = await db.user.create({ data: { id: prefix, name: 'dbg', nickname: prefix.slice(0, 12), role: 'STUDENT' } });
const sc = (await createSession(u.id, new Request(base))).split(';')[0];
const chrome = await launchChrome();
const page = await openPage(chrome.cdp, { width: 390, height: 844, cookie: { name: 'memoryz_session', value: sc.split('=')[1] } });
chrome.cdp.on((m) => {
  if (m.method === 'Network.requestWillBeSent')
    console.log('REQ', m.params.request.url.slice(-70));
  if (m.method === 'Network.responseReceived')
    console.log('RES', m.params.response.status, m.params.response.url.slice(-70));
  if (m.method === 'Network.loadingFailed')
    console.log('FAIL', m.params.errorText, m.params.type);
});
await page.send('Page.navigate', { url: `${base}/community` });
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const state = await page.evaluate('document.readyState + "|" + (document.querySelector(".postTitle") ? "FEED" : document.body.innerText.slice(0,60).replace(/\\n/g," / "))');
  console.log(i + 's', state);
  if (state.includes('FEED')) break;
}
console.log('ERRORS:', consoleErrors(chrome.cdp));
await chrome.close();
await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
await db.$disconnect();
await server.stop();
