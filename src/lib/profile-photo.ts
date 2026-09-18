export const PROFILE_PHOTO_MAX_BYTES = 5_000_000;
export const PROFILE_PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp';

export function profilePhotoError(file: { size: number; type: string }): string | null {
  if (!PROFILE_PHOTO_ACCEPT.split(',').includes(file.type))
    return 'JPG, PNG, WebP 사진을 선택해 주세요.';
  if (file.size === 0 || file.size > PROFILE_PHOTO_MAX_BYTES)
    return '사진은 5MB 이하로 선택해 주세요.';
  return null;
}

/** Browsers apply EXIF orientation before drawing. The preview and stored crop are identical. */
export async function prepareProfilePhoto(file: File): Promise<Blob> {
  const problem = profilePhotoError(file);
  if (problem) throw new Error(problem);
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => {
    throw new Error('사진을 읽지 못했어요. 다른 JPG, PNG, WebP 사진을 선택해 주세요.');
  });
  try {
    if (bitmap.width * bitmap.height > 24_000_000 || bitmap.width > 12000 || bitmap.height > 12000)
      throw new Error('사진은 2,400만 화소 이하로 선택해 주세요.');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('사진을 준비하지 못했어요. 다시 선택해 주세요.');
    const side = Math.min(bitmap.width, bitmap.height);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 512, 512);
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      512,
      512,
    );
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error('사진을 준비하지 못했어요. 다시 선택해 주세요.')),
        'image/jpeg',
        0.9,
      ),
    );
  } finally {
    bitmap.close();
  }
}
