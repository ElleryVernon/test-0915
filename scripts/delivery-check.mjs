import fs from 'node:fs';
import assert from 'node:assert/strict';
const read=p=>fs.readFileSync(p,'utf8');
for(const p of ['README.md','docs/LEARNING_METHODS.md','docs/THIRD_PARTY_NOTICES.md','docs/VERIFICATION.md','docs/SERVER.md','docs/CLOUD.md','Dockerfile','.env.example','compose.yml','public/sw.js','public/manifest.webmanifest','public/fonts/OFL-Pretendard.txt','public/fonts/OFL-Outfit.txt','scripts/oauth-wizard.sh'])assert.ok(read(p).length>30,`Missing delivery artifact ${p}`);
assert.equal(JSON.parse(read('package-lock.json')).packages[''].name,'memoryz');
// The README states the deployment as it is: GCP, the public origin, Go migrations, the OAuth setup path.
for(const phrase of ['DEMO_MODE=true','https://memoryz.kr','server migrate up','docs/CLOUD.md','oauth-wizard.sh','node server/scripts/regression.mjs'])assert.ok(read('README.md').includes(phrase),phrase);
for(const stale of ['외부 배포는 수행하지 않았습니다','npx prisma migrate deploy','scripts/backend-check.ts','Amazon Bedrock us-east-1을 먼저'])assert.ok(!read('README.md').includes(stale),`stale README claim: ${stale}`);
assert.ok(read('.env.example').includes('DEMO_MODE="false"'));
assert.ok(read('.env.example').includes('OPENROUTER_PROVIDER_ORDER="openai/fast,amazon-bedrock/us-east-1"'),'.env.example provider order');
assert.ok(fs.readdirSync('server/internal/db/migrations').filter(p=>p.endsWith('.sql')).length>=4,'Go migrations');
assert.ok(read('docs/VERIFICATION.md').includes('브라우저'));
assert.ok(read('public/fonts/OFL-Pretendard.txt').includes('SIL OPEN FONT LICENSE'));
assert.ok(read('public/fonts/OFL-Outfit.txt').includes('SIL OPEN FONT LICENSE'));
assert.ok(fs.readdirSync('prisma/migrations').filter(p=>fs.statSync('prisma/migrations/'+p).isDirectory()).length>=2);
console.log('MEMORYZ_DELIVERY_OK');
