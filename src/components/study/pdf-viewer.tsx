'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, LoaderCircle, RotateCw } from '@/components/icons';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { PDF_ASSET_BASE, renderPdfPage } from './pdf-render';

export default function PdfViewer({ url, title }: { url: string; title: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => setWidth(Math.floor(viewport.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let loadFailure = '';
    setPdf(null);
    setPageNumber(1);
    setLoading(true);
    setError('');

    async function load() {
      try {
        // PDF.js touches browser APIs during import; keep it outside server rendering.
        const pdfjs = await import('pdfjs-dist');
        if (!active) return;
        pdfjs.GlobalWorkerOptions.workerSrc = `${PDF_ASSET_BASE}/pdf.worker.min.mjs`;
        task = pdfjs.getDocument({
          url,
          withCredentials: true,
          cMapUrl: `${PDF_ASSET_BASE}/cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${PDF_ASSET_BASE}/standard_fonts/`,
          wasmUrl: `${PDF_ASSET_BASE}/wasm/`,
          isEvalSupported: false,
          enableXfa: false,
        });
        task.onPassword = () => {
          loadFailure = '암호가 있는 PDF예요. 아래 원본 링크에서 열어 주세요.';
          if (active) {
            setError(loadFailure);
            setLoading(false);
          }
          void task?.destroy().catch(() => {});
        };
        timeout = setTimeout(() => {
          loadFailure =
            'PDF를 불러오는 데 시간이 걸리고 있어요. 연결을 확인하고 다시 시도해 주세요.';
          if (active) {
            setError(loadFailure);
            setLoading(false);
          }
          void task?.destroy().catch(() => {});
        }, 45_000);
        const document = await task.promise;
        if (active) setPdf(document);
      } catch (reason) {
        if (!active) return;
        const name = reason instanceof Error ? reason.name : '';
        setError(
          loadFailure ||
            (name === 'InvalidPDFException'
              ? 'PDF 파일을 읽을 수 없어요. 아래 원본과 본문을 확인해 주세요.'
              : 'PDF를 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.'),
        );
      } finally {
        if (timeout) clearTimeout(timeout);
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
      if (timeout) clearTimeout(timeout);
      void task?.destroy().catch(() => {});
    };
  }, [url, reload]);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!pdf || !width || !host) return;
    let active = true;
    let renderTask: RenderTask | undefined;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute(
      'aria-label',
      `${title}, ${pageNumber}페이지. 본문 텍스트는 아래에서 읽을 수 있어요.`,
    );
    canvas.className = 'block max-w-full bg-white';
    setRendering(true);
    setError('');
    host.replaceChildren();

    async function render() {
      try {
        const page = await pdf!.getPage(pageNumber);
        if (!active) return;
        renderTask = renderPdfPage(page, canvas, width, window.devicePixelRatio || 1);
        await renderTask.promise;
        if (active) host!.replaceChildren(canvas);
      } catch {
        if (active)
          setError('이 페이지를 표시하지 못했어요. 다시 시도하거나 아래 본문을 확인해 주세요.');
      } finally {
        if (active) setRendering(false);
      }
    }
    void render();
    return () => {
      active = false;
      renderTask?.cancel();
      canvas.remove();
    };
  }, [pdf, pageNumber, width, title]);

  const busy = loading || rendering || (!width && !error);
  return (
    <section
      aria-label="PDF 미리보기"
      className="overflow-hidden rounded-2xl border border-line bg-surface"
    >
      <div className="flex min-h-14 items-center justify-between gap-2 border-b border-line bg-white px-3">
        <button
          type="button"
          aria-label="이전 페이지"
          disabled={!pdf || busy || pageNumber <= 1}
          onClick={() => setPageNumber((page) => page - 1)}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-xl text-secondary disabled:opacity-30"
        >
          <ChevronLeft size={20} />
        </button>
        <p aria-live="polite" className="text-[13px] font-semibold tabular-nums text-secondary">
          {pdf ? `${pageNumber} / ${pdf.numPages} 페이지` : 'PDF 미리보기'}
        </p>
        <button
          type="button"
          aria-label="다음 페이지"
          disabled={!pdf || busy || pageNumber >= pdf.numPages}
          onClick={() => setPageNumber((page) => page + 1)}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-xl text-secondary disabled:opacity-30"
        >
          <ChevronRight size={20} />
        </button>
      </div>
      <div
        ref={viewportRef}
        aria-busy={busy}
        className="relative max-h-[55vh] min-h-64 overflow-auto overscroll-contain"
      >
        <div ref={canvasHostRef} className={busy || error ? 'hidden' : ''} />
        {busy && !error && (
          <div
            role="status"
            className="flex min-h-64 flex-col items-center justify-center gap-3 page-inset text-[14px] text-muted"
          >
            <LoaderCircle size={24} className="animate-spin" />
            {loading ? 'PDF를 불러오고 있어요' : '페이지를 준비하고 있어요'}
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center"
          >
            <AlertCircle size={24} className="text-muted" />
            <p className="text-[14px] leading-relaxed text-secondary">{error}</p>
            <button
              type="button"
              onClick={() => setReload((value) => value + 1)}
              className="mt-1 flex min-h-11 items-center gap-2 rounded-xl bg-white px-4 text-[14px] font-semibold"
            >
              <RotateCw size={16} /> 다시 불러오기
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
