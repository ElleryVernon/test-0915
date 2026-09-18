import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const dir = new URL('../data/schools/', import.meta.url);
const source = 'https://open.neis.go.kr/portal/data/sheet/searchSheetData.do';
const params = {infId:'OPEN17020190531110010104913',infSeq:'1',rows:'1000',ATPT_OFCDC_SC_CODE:'',SCHUL_NM:'',LCTN_SC_NM:'',FOND_SC_NM:'',downloadType:'',SCHUL_KND_SC_NM:'고등학교'};
function validate(snapshot) {
  assert.equal(snapshot.raw.length, snapshot.sourceTotal);
  assert(snapshot.schools.length > 2000);
  const codes = new Set();
  for (const s of snapshot.schools) {
    assert(s.name && s.address && s.province && s.id && s.officeCode);
    assert(!codes.has(s.id), `Duplicate code ${s.code}`); codes.add(s.id);
    assert(['고등학교','방송통신고등학교'].includes(s.kind));
    assert.notEqual(s.officeCode, 'V10');
  }
  assert.equal(snapshot.schools.length + snapshot.excluded.length, snapshot.raw.length);
  assert.equal(new Set(snapshot.schools.map(s => s.officeCode)).size, 17);
}
if (process.argv.includes('--verify')) {
  const data = JSON.parse(await readFile(new URL('high-schools.json', dir), 'utf8'));
  validate(data);
  console.log(`SCHOOL_DIRECTORY_VERIFIED schools=${data.schools.length} source=${data.sourceTotal} excluded=${data.excluded.length}`);
} else {
  await mkdir(dir, {recursive:true});
  const raw = []; let total;
  for (let page = 1; ; page++) {
    const url = new URL(source); url.search = new URLSearchParams({...params,page:String(page)});
    const response = await fetch(url, {signal:AbortSignal.timeout(30000)});
    assert(response.ok, `HTTP ${response.status}`);
    const result = await response.json();
    assert(Array.isArray(result.data) && result.data.length, JSON.stringify(result));
    total ??= result.total; assert.equal(result.total, total, 'Source changed while collecting; rerun');
    raw.push(...result.data);
    console.log(`page ${page}: ${raw.length}/${total}`);
    if(raw.length >= total) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  await writeFile(new URL("source-raw.json",dir),JSON.stringify({sourceTotal:total,raw},null,2));
  const excluded = [], schools = [];
  for(const row of raw) {
    if(row.ATPT_OFCDC_SC_CODE === 'V10' || row.LCTN_SC_NM === '국외') {
      excluded.push({code:row.SD_SCHUL_CODE,name:row.SCHUL_NM,reason:'재외한국학교교육청 분류(국내 교육청 목록에서 제외)'}); continue;
    }
    schools.push({id:row.SD_SCHUL_CODE.trim() || 'unassigned-'+createHash('sha256').update(row.ATPT_OFCDC_SC_CODE+row.SCHUL_NM).digest('hex').slice(0,16),code:row.SD_SCHUL_CODE.trim(),codeStatus:row.SD_SCHUL_CODE.trim()?'assigned':'unassigned',officeCode:row.ATPT_OFCDC_SC_CODE,name:row.SCHUL_NM,province:row.LCTN_SC_NM,address:(row.ORG_RDNMA??'').trim() || (row.SCHUL_NM==='한국과학영재학교'?'부산광역시 부산진구 백양관문로 105-47':''),addressSource:(row.ORG_RDNMA??'').trim()?'NEIS':'https://www.ksa.hs.kr/',addressDetail:(row.ORG_RDNDA??'').trim(),postalCode:(row.ORG_RDNZC??'').trim(),kind:row.SCHUL_KND_SC_NM,type:row.HS_SC_NM,establishment:row.FOND_SC_NM,sourceUpdatedAt:row.LOAD_DTM});
  }
  schools.sort((a,b)=>a.province.localeCompare(b.province,'ko')||a.name.localeCompare(b.name,'ko')||a.code.localeCompare(b.code));
  const snapshot = {collectedAt:new Date().toISOString(),source,parameters:params,sourceTotal:total,schools,excluded,raw};
  validate(snapshot);
  await writeFile(new URL('../server/internal/schools/directory.json', import.meta.url), JSON.stringify(schools.filter(s=>s.code).map(s=>({id:s.code,name:s.name,address:s.address,province:s.province}))));
  await writeFile(new URL('high-schools.json',dir),JSON.stringify(snapshot,null,2)+'\n');
  const fields=['kind','codeStatus','code','name','province','address','addressDetail','postalCode','officeCode','type','establishment','sourceUpdatedAt'];
  const labels=['학교종류','학교코드상태','학교코드','학교명','시도','도로명주소','상세주소','우편번호','교육청코드','학교유형','설립구분','원본수정일'];
  const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';
  await writeFile(new URL('high-schools.csv',dir),'\uFEFF'+[labels,...schools.map(s=>fields.map(f=>s[f]))].map(r=>r.map(quote).join(',')).join('\r\n')+'\r\n');
  console.log(`Collected ${schools.length} domestic high schools; excluded ${excluded.length}`);
}
