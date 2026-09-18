// One-off evidence capture against `next dev` (:3000, proxying the Go dev API on :8080).
// Logs in through the dev proxy as the demo student and screenshots /community at phone width.
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { demoLogin } from './lib/goserve';
import { consoleErrors, launchChrome, openPage } from './lib/browser';

const base = 'http://127.0.0.1:3000';
const session = await demoLogin(base, 'STUDENT');
const chrome = await launchChrome();
try {
  const page = await openPage(chrome.cdp, {
    width: 390,
    height: 844,
    cookie: { name: session.name, value: session.value },
  });
  await page.send('Page.navigate', { url: `${base}/community` });
  await page.waitUntil('document.readyState === "complete"', 'load', 30000);
  await page
    .waitUntil(
      "document.body.innerText.includes('팔로잉')",
      'feed',
      30000,
    )
    .catch(async () => {
      await page.send('Page.reload');
      await page.waitUntil('document.readyState === "complete"', 'reload', 20000);
      await page.waitUntil("document.body.innerText.includes('팔로잉')", 'feed after reload', 30000);
    });
  writeFileSync('/tmp/community-feed-dev.png', await page.shot());
  console.log('FEED TEXT:', (await page.evaluate('document.body.innerText')).slice(0, 700));
  console.log('ERRORS:', JSON.stringify(consoleErrors(chrome.cdp, [/favicon/, /manifest/i])));
} finally {
  await chrome.close();
}
