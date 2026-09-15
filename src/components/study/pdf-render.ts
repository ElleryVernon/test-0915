import type { PDFPageProxy } from 'pdfjs-dist';

export const PDF_ASSET_BASE = '/pdfjs/5.4.296';

/** Render each page into its own canvas, so cancelled pages never share a drawing surface. */
export function renderPdfPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  width: number,
  pixelRatio = 1,
) {
  const natural = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.max(1, width) / natural.width });
  // Keep large lecture slides and high-DPI phones within a predictable memory budget.
  const outputScale = Math.min(
    Math.max(1, pixelRatio),
    2,
    Math.sqrt(4_000_000 / (viewport.width * viewport.height)),
    8192 / Math.max(viewport.width, viewport.height),
  );
  canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
  canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  return page.render({
    canvas,
    viewport,
    transform: [outputScale, 0, 0, outputScale, 0, 0],
    background: '#ffffff',
  });
}
