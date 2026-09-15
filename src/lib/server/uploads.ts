import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from './db';
import { ApiError } from './errors';
import type { User } from './generated/client';
import { aiAvailable } from './provider';
import { extractImageText } from './ai';
import { extractPdf, type ExtractedImage } from './pdf-extract';

const MAX_BYTES = 10_000_000;
const MAX_TEXT = 200_000;
const DAY = 86_400_000;
const ID = /^[a-f0-9-]{36}$/;
const BOM = String.fromCharCode(0xfeff);
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
/** Identifies extracted text, so a material can tell whether it still holds it unedited. */
export const textHash = (text: string) => sha256(text.normalize('NFC'));
export const uploadUrl = (uploadId: string) => `/api/uploads/${uploadId}`;
/** Where files lived before they moved into the database; read once, then copied in. */
const legacyDirectories = () => [
  ...(process.env.UPLOAD_LEGACY_DIRS ?? '').split(path.delimiter).filter(Boolean),
  path.join(process.cwd(), '.data', 'uploads'),
];
const imageMeta = (uploadId: string) => (image: { id: string; page: number; order: number; paragraph: number; anchor: number; x: number; y: number; w: number; h: number; width: number; height: number; context: string }) => ({
  id: image.id,
  url: `${uploadUrl(uploadId)}/images/${image.id}`,
  page: image.page,
  order: image.order,
  paragraph: image.paragraph,
  anchor: image.anchor,
  box: { x: image.x, y: image.y, w: image.w, h: image.h },
  width: image.width,
  height: image.height,
  context: image.context,
});
const IMAGE_META = { id: true, page: true, order: true, paragraph: true, anchor: true, x: true, y: true, w: true, h: true, width: true, height: true, context: true } as const;
export async function uploadImages(uploadId: string) {
  const images = await db.uploadImage.findMany({ where: { uploadId }, select: IMAGE_META, orderBy: [{ page: 'asc' }, { order: 'asc' }] });
  return images.map(imageMeta(uploadId));
}

export async function handleUpload(request: Request, user: User) {
  if (Number(request.headers.get('content-length') ?? 0) > 11_000_000) throw new ApiError(413, '파일은 10MB 이하로 올려 주세요.');
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new ApiError(400, '파일을 선택해 주세요.');
  if (!file.size || file.size > MAX_BYTES) throw new ApiError(413, '빈 파일이거나 10MB를 초과했어요.');
  const buffer = Buffer.from(await file.arrayBuffer());
  const extension = file.name.split('.').pop()?.toLowerCase();
  let type: 'TXT' | 'PDF' | 'IMAGE';
  let mime: string;
  let content = '';
  let extraction: string;
  let pages: number | null = null;
  let pageBreaks: number[] = [];
  let images: ExtractedImage[] = [];
  let warning: string | undefined;
  if (extension === 'txt') {
    if (buffer.includes(0)) throw new ApiError(400, 'UTF-8 텍스트 파일을 올려 주세요.');
    type = 'TXT';
    mime = 'text/plain; charset=utf-8';
    content = buffer.toString('utf8').replace(/\r\n?/g, '\n').normalize('NFC');
    if (content.startsWith(BOM)) content = content.slice(1);
    extraction = 'text';
  } else if (extension === 'pdf' && buffer.subarray(0, 5).toString() === '%PDF-') {
    type = 'PDF';
    mime = 'application/pdf';
    try {
      const result = await extractPdf(new Uint8Array(buffer), {
        ocr: aiAvailable() ? (png) => extractImageText(png, 'image/png') : undefined,
      });
      ({ pages, pageBreaks, images, warning } = result);
      content = result.text;
      extraction = result.method;
    } catch {
      throw new ApiError(422, 'PDF를 읽지 못했어요. 암호를 해제하거나 다른 파일로 올려 주세요.');
    }
  } else if (['png', 'jpg', 'jpeg', 'webp'].includes(extension ?? '')) {
    const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    const webp = buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
    if (!png && !jpeg && !webp) throw new ApiError(400, '이미지 파일 내용을 확인해 주세요.');
    type = 'IMAGE';
    mime = png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp';
    if (aiAvailable()) content = (await extractImageText(buffer, mime)).normalize('NFC');
    extraction = content ? 'image-ocr' : 'manual';
  } else throw new ApiError(415, 'TXT, PDF, PNG, JPG, WebP 파일을 올려 주세요.');
  if (content.length > MAX_TEXT) throw new ApiError(413, '본문이 너무 길어요. 자료를 나누어 올려 주세요.');
  await collectUnlinked(user.id);
  const uploadId = randomUUID();
  // The row, its bytes and its images land together or not at all.
  await db.$transaction(async (tx) => {
    await tx.upload.create({
      data: { id: uploadId, userId: user.id, mime, name: file.name.slice(0, 200), size: buffer.length, sha256: sha256(buffer), pages, pageBreaks, extraction, textHash: textHash(content) },
    });
    await tx.uploadBlob.create({ data: { uploadId, data: buffer } });
    if (images.length)
      await tx.uploadImage.createMany({
        data: images.map((image) => ({
          uploadId,
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
  });
  return {
    uploadId,
    url: uploadUrl(uploadId),
    content,
    type,
    title: file.name.replace(/\.[^.]+$/, '').slice(0, 200),
    pages,
    pageBreaks,
    extraction,
    images: await uploadImages(uploadId),
    ...(warning ? { warning } : !content ? { warning: '추출된 본문이 없어요. 학습 내용을 직접 입력해 주세요.' } : {}),
  };
}

/** Uploads a day old that no material or card uses are left from abandoned sheets; they go. */
async function collectUnlinked(userId: string) {
  const stale = await db.upload.findMany({ where: { userId, createdAt: { lt: new Date(Date.now() - DAY) }, material: null }, select: { id: true } });
  if (!stale.length) return;
  const urls = stale.map((upload) => uploadUrl(upload.id));
  const used = new Set([
    ...(await db.card.findMany({ where: { userId, image: { in: urls } }, select: { image: true } })).map((card) => card.image),
    ...(await db.material.findMany({ where: { userId, url: { in: urls } }, select: { url: true } })).map((material) => material.url),
  ]);
  const unused = stale.filter((upload) => !used.has(uploadUrl(upload.id))).map((upload) => upload.id);
  if (unused.length) await db.upload.deleteMany({ where: { userId, id: { in: unused } } });
}

/** Copies a file written by an earlier version into the database the first time it is asked for. */
async function migrateLegacy(upload: { id: string; size: number }): Promise<Uint8Array | null> {
  for (const directory of legacyDirectories()) {
    let file: Buffer;
    try {
      file = await readFile(path.join(directory, upload.id));
    } catch {
      continue;
    }
    if (file.length !== upload.size) continue;
    await db.uploadBlob.upsert({ where: { uploadId: upload.id }, create: { uploadId: upload.id, data: new Uint8Array(file) }, update: {} });
    await db.upload.update({ where: { id: upload.id }, data: { sha256: sha256(file) } });
    return file;
  }
  return null;
}

const fileHeaders = (etag: string) => ({
  ETag: etag,
  'Cache-Control': 'private, max-age=31536000, immutable',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
});
export async function readUpload(uploadId: string, user: User, request: Request) {
  if (!ID.test(uploadId)) throw new ApiError(404, '파일을 찾을 수 없어요.');
  const upload = await db.upload.findFirst({ where: { id: uploadId, userId: user.id }, select: { id: true, mime: true, name: true, size: true, sha256: true } });
  if (!upload) throw new ApiError(404, '파일을 찾을 수 없어요.');
  const blob = await db.uploadBlob.findUnique({ where: { uploadId } });
  const data = blob?.data ?? (await migrateLegacy(upload));
  if (!data) throw new ApiError(410, '원본 파일을 찾을 수 없어요. 본문은 그대로 볼 수 있고, 파일은 다시 올려야 해요.', 'UPLOAD_MISSING');
  let digest = upload.sha256;
  if (!digest) {
    digest = sha256(data);
    await db.upload.update({ where: { id: upload.id }, data: { sha256: digest } });
  }
  const etag = `"${digest}"`;
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: fileHeaders(etag) });
  const download = new URL(request.url).searchParams.get('download') === '1';
  return new Response(new Uint8Array(data), {
    headers: {
      ...fileHeaders(etag),
      'Content-Type': upload.mime,
      'Content-Length': String(data.length),
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(upload.name)}`,
      'Accept-Ranges': 'none',
    },
  });
}
export async function readUploadImage(uploadId: string, imageId: string, user: User, request: Request) {
  if (!ID.test(uploadId)) throw new ApiError(404, '그림을 찾을 수 없어요.');
  const image = await db.uploadImage.findFirst({ where: { id: imageId, uploadId, upload: { userId: user.id } }, select: { id: true, mime: true, data: true } });
  if (!image) throw new ApiError(404, '그림을 찾을 수 없어요.');
  const etag = `"${image.id}"`;
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: fileHeaders(etag) });
  return new Response(new Uint8Array(image.data), {
    headers: { ...fileHeaders(etag), 'Content-Type': image.mime, 'Content-Length': String(image.data.length) },
  });
}
