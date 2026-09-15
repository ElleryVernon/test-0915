// Moves files written by earlier versions (".data/uploads/<id>" next to whichever server received them)
// into the database, and re-reads PDFs that predate page and image extraction. A material whose text is
// still exactly the old extraction gets the new text; an edited one keeps its words and loses only the
// page offsets it never had. Dry run by default; pass --yes to write.
// Usage: npx tsx scripts/uploads-to-db.ts [--yes] <uploads-dir> [<uploads-dir> …]
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PDFParse } from 'pdf-parse';
import { db } from '../src/lib/server/db';
import { extractPdf } from '../src/lib/server/pdf-extract';
import { textHash } from '../src/lib/server/uploads';

const write = process.argv.includes('--yes');
const dirs = process.argv.slice(2).filter((arg) => !arg.startsWith('--')).map((dir) => resolve(dir));
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
async function oldExtraction(bytes: Uint8Array) {
  const parser = new PDFParse({ data: bytes.slice() });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

const report = { moved: 0, missing: [] as string[], reread: 0, replacedText: 0, keptEditedText: 0 };
const uploads = await db.upload.findMany({
  select: { id: true, mime: true, size: true, pages: true, blob: { select: { uploadId: true } }, material: { select: { id: true, content: true } } },
  orderBy: { createdAt: 'asc' },
});
for (const upload of uploads) {
  let bytes: Uint8Array | null = null;
  if (!upload.blob) {
    const file = dirs.map((dir) => join(dir, upload.id)).find((path) => existsSync(path) && statSync(path).size === upload.size);
    if (!file) {
      report.missing.push(upload.id);
      continue;
    }
    bytes = new Uint8Array(readFileSync(file));
    if (write) {
      await db.uploadBlob.create({ data: { uploadId: upload.id, data: bytes } });
      await db.upload.update({ where: { id: upload.id }, data: { sha256: sha256(bytes) } });
    }
    report.moved++;
    console.log(`move  ${upload.id} ${upload.mime} ${upload.size} bytes from ${file}`);
  }
  if (upload.mime !== 'application/pdf' || upload.pages !== null) continue;
  bytes ??= new Uint8Array((await db.uploadBlob.findUniqueOrThrow({ where: { uploadId: upload.id } })).data);
  const result = await extractPdf(bytes);
  const unedited = !!upload.material && (await oldExtraction(bytes)).trim() === upload.material.content.trim();
  console.log(
    `read  ${upload.id} ${result.pages} pages, ${result.images.length} images, ${result.method}` +
      (upload.material ? ` · material ${upload.material.id} ${unedited ? 'gets the new text' : 'was edited, keeps its text'}` : ''),
  );
  report.reread++;
  if (upload.material) unedited ? report.replacedText++ : report.keptEditedText++;
  if (!write) continue;
  await db.$transaction(async (tx) => {
    await tx.upload.update({
      where: { id: upload.id },
      data: { pages: result.pages, pageBreaks: result.pageBreaks, extraction: result.method, textHash: textHash(result.text) },
    });
    await tx.uploadImage.deleteMany({ where: { uploadId: upload.id } });
    if (result.images.length)
      await tx.uploadImage.createMany({
        data: result.images.map((image) => ({
          uploadId: upload.id,
          page: image.page,
          order: image.order,
          paragraph: image.paragraph,
          anchor: image.anchor,
          ...image.box,
          width: image.width,
          height: image.height,
          mime: image.mime,
          context: image.context,
          data: new Uint8Array(image.data),
        })),
      });
    if (upload.material)
      await tx.material.update({
        where: { id: upload.material.id },
        data: unedited
          ? { content: result.text, pageBreaks: result.pageBreaks, extraction: result.method }
          : { pageBreaks: [], extraction: 'manual' },
      });
  });
}
console.log(`${write ? 'wrote' : 'dry run'} · ${JSON.stringify(report)}`);
await db.$disconnect();
if (report.missing.length) process.exitCode = 1;
