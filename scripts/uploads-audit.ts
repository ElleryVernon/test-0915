// Audits stored uploads in the local database: every upload has its bytes (matching its hash), every
// PDF has pages and page offsets, materials that still hold the extracted text carry those offsets and
// no page markers, and every card image resolves to stored bytes.
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { db } from '../src/lib/server/db';
import { textHash } from '../src/lib/server/uploads';
import { assertLoopbackDatabase } from './lib/browser';

assertLoopbackDatabase();
const problems: string[] = [];
const uploads = await db.upload.findMany({
  include: { blob: true, material: { select: { id: true, content: true, pageBreaks: true } }, _count: { select: { images: true } } },
});
let pdfs = 0;
for (const upload of uploads) {
  if (!upload.blob) {
    problems.push(`${upload.id}: no stored bytes`);
    continue;
  }
  if (upload.blob.data.length !== upload.size) problems.push(`${upload.id}: ${upload.blob.data.length} bytes stored, ${upload.size} recorded`);
  if (upload.sha256 !== createHash('sha256').update(upload.blob.data).digest('hex')) problems.push(`${upload.id}: hash mismatch`);
  if (upload.mime !== 'application/pdf') continue;
  pdfs++;
  if (!upload.pages || upload.pageBreaks.length !== upload.pages || !upload.extraction || !upload.textHash)
    problems.push(`${upload.id}: pages ${upload.pages}, offsets ${upload.pageBreaks.length}, extraction ${upload.extraction}`);
  const material = upload.material;
  if (material && textHash(material.content) === upload.textHash) {
    if (JSON.stringify(material.pageBreaks) !== JSON.stringify(upload.pageBreaks)) problems.push(`${material.id}: page offsets differ from its file`);
    if (/-- \d+ of \d+ --/.test(material.content)) problems.push(`${material.id}: page markers in the text`);
  }
}
const cards = await db.card.findMany({ where: { image: { startsWith: '/api/uploads/' } }, select: { id: true, image: true } });
for (const card of cards) {
  const id = card.image!.split('/').pop()!;
  if (!(await db.uploadBlob.count({ where: { uploadId: id } }))) problems.push(`card ${card.id}: image bytes missing`);
}
const report = await db.material.findFirst({ where: { url: '/api/uploads/ff43b24c-5f90-4b5c-ac49-7d3aff7aabf5' }, include: { upload: { select: { pages: true, _count: { select: { images: true } } } } } });
const userPdf = report
  ? { pages: report.upload?.pages, offsets: report.pageBreaks.length, markers: (report.content.match(/-- \d+ of \d+ --/g) ?? []).length, images: report.upload?._count.images }
  : null;
if (userPdf && (userPdf.pages !== 18 || userPdf.offsets !== 18 || userPdf.markers !== 0 || !userPdf.images)) problems.push(`the 18-page upload: ${JSON.stringify(userPdf)}`);
console.log(`uploads ${uploads.length} (pdf ${pdfs}) · card images ${cards.length} · 18-page upload ${JSON.stringify(userPdf)}`);
await db.$disconnect();
if (problems.length) {
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log('UPLOADS_ALL_STORED');
