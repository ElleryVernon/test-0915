#!/usr/bin/env node
// Local-only corpus harness. Full book text and PDF-derived artifacts stay in
// ignored .unlazy storage. No API, database, upload, or model credentials used.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (key, fallback) => { const at = args.indexOf(key); return at < 0 ? fallback : args[at+1]; };
const input = resolve(root, value('--input', '.unlazy/university-learning/corpus'));
const output = resolve(root, value('--output', '.unlazy/university-learning/extraction/current'));
if (!args.includes('--verify')) {
  const cmd = ['run','./cmd/corpus-audit','--input',input,'--output',output];
  if (args.includes('--match')) cmd.push('--match',value('--match',''));
  const result = spawnSync('go',cmd,{cwd:resolve(root,'server'),stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const report = JSON.parse(readFileSync(resolve(output,'audit.json'),'utf8'));
const expected = Number(value('--expect-files','59'));
if (report.files.length !== expected) throw Error(`Expected ${expected} files, found ${report.files.length}`);
let pages = 0, chars = 0, images = 0, sparse = 0, replacement = 0, privateUse = 0;
let rawUnmapped = 0, rawControl = 0, vectorPaths = 0, imageObjects = 0, twoColumnPages = 0, imagesOmittedByLimit = 0;
const rows = [];
const seen = new Set();
for (const item of report.files) {
  if (seen.has(item.file)) throw Error(`Duplicate file: ${item.file}`);
  seen.add(item.file);
  if (item.error) throw Error(`${item.file}: ${item.error}`);
  const data = readFileSync(resolve(input,item.file));
  if (createHash('sha256').update(data).digest('hex') !== item.sha256 || data.length !== item.bytes) throw Error(`Source changed since extraction: ${item.file}`);
  const info = spawnSync('pdfinfo',[resolve(input,item.file)],{encoding:'utf8'});
  if (info.status !== 0) throw Error(`pdfinfo failed: ${item.file}`);
  const count = Number(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
  if (count !== item.pageCount) throw Error(`Independent page count differs: ${item.file}: ${count} / ${item.pageCount}`);
  const text = readFileSync(resolve(output,item.textPath),'utf8');
  const perPage = JSON.parse(readFileSync(resolve(output,item.pagesPath),'utf8'));
  if ([...text].length !== item.chars || text.length !== item.utf16 || perPage.length !== count || perPage.map(p=>p.text).join('') !== text) throw Error(`Invalid extraction artifacts: ${item.file}`);
  if (item.diagnostics && item.diagnostics.length !== count) throw Error(`Missing page diagnostics: ${item.file}`);
  for (const img of item.images) {
    const p = perPage[img.page-1];
    if (!p || img.anchorUTF16 < p.startUTF16 || img.anchorUTF16 > p.endUTF16 || img.bytes <= 0 || !Object.values(img.box).every(Number.isFinite)) throw Error(`Invalid image metadata: ${item.file}`);
  }
  pages+=count; chars+=item.chars; images+=item.images.length; sparse+=item.sparsePages.length; replacement+=item.glyphs.replacement; privateUse+=item.glyphs.privateUse;
  for (const p of item.diagnostics ?? []) { rawUnmapped+=p.unmappedCharacters; rawControl+=p.controlCharacters; vectorPaths+=p.vectorPaths; imageObjects+=p.imageObjects; twoColumnPages+=Number(p.twoColumns); }
  imagesOmittedByLimit+=item.imagesOmittedByLimit ?? 0;
  rows.push(`${item.file}\t${item.bytes}\t${count}\t${item.chars}\t${item.images.length}\t${item.glyphs.replacement}\t${item.glyphs.privateUse}\t${item.durationMs}\t${item.warning}`);
}
const summary = {files:report.files.length,pages,chars,images,sparsePages:sparse,replacement,privateUse,rawUnmapped,rawControl,vectorPaths,imageObjects,twoColumnPages,imagesOmittedByLimit,durationMs:report.durationMs,warmupMs:report.warmupMs};
writeFileSync(resolve(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');
writeFileSync(resolve(output,'audit.tsv'),'file\tbytes\tpages\tchars\timages\treplacement\tprivateUse\tdurationMs\twarning\n'+rows.join('\n')+'\n');
console.log('CORPUS_VERIFIED',JSON.stringify(summary));
