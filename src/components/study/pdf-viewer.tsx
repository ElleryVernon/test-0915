'use client';

// Continuous PDF preview: every page is laid out at once (so the scroll position is the reading
// position), rendered only when it comes near the viewport, re-rendered on zoom, with a live page
// indicator. The bytes are fetched first so HTTP failures (410 gone, 401 signed out, 404, offline)
// are reported precisely instead of as pdf.js's generic loading error.
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, Minus, Plus, RotateCw } from '@/components/icons';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { describeFailure, nextZoom, ZOOM_STEPS, type ViewerFailure } from './material-layout';
import { PDF_ASSET_BASE, renderPdfPage } from './pdf-render';

type PageSize = { width: number; height: number };

export default function PdfViewer({
  url,
  title,
  initialPage = 1,
  onPageCount,
}: {
  url: string;
  title: string;
  /** Page to scroll to once the document is laid out (a citation's page). */
  initialPage?: number;
  onPageCount?: (pages: number) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState<number>(ZOOM_STEPS[0]);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<ViewerFailure | null>(null);
  const [current, setCurrent] = useState(1);
  const [reload, setReload] = useState(0);
  const [visible, setVisible] = useState<Set<number>>(new Set());

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => setWidth(Math.floor(viewport.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  // Load: fetch the bytes (precise HTTP errors), then let pdf.js parse them.
  useEffect(() => {
    let active = true;
    let document: PDFDocumentProxy | undefined;
    setPdf(null);
    setSizes([]);
    setLoading(true);
    setFailure(null);
    setCurrent(1);
    async function load() {
      try {
        let response: Response;
        try {
          // jitter: none — one fetch a person starts (45 s deadline); retry is only the manual retry button [site src/components/study/pdf-viewer.tsx:61]
          response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(45_000) });
        } catch (reason) {
          if (!active) return;
          setFailure(reason instanceof Error && reason.name === 'TimeoutError' ? { pdf: 'timeout' } : { network: true });
          return;
        }
        if (!response.ok) {
          if (active) setFailure({ status: response.status });
          return;
        }
        const data = new Uint8Array(await response.arrayBuffer());
        if (!active) return;
        const pdfjs = await import('pdfjs-dist');
        if (!active) return;
        pdfjs.GlobalWorkerOptions.workerSrc = `${PDF_ASSET_BASE}/pdf.worker.min.mjs`;
        const task = pdfjs.getDocument({
          data,
          cMapUrl: `${PDF_ASSET_BASE}/cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${PDF_ASSET_BASE}/standard_fonts/`,
          wasmUrl: `${PDF_ASSET_BASE}/wasm/`,
          isEvalSupported: false,
          enableXfa: false,
        });
        task.onPassword = () => {
          if (active) setFailure({ pdf: 'password' });
          void task.destroy().catch(() => {});
        };
        document = await task.promise;
        if (!active) return;
        const pageSizes: PageSize[] = [];
        for (let n = 1; n <= document.numPages; n++) {
          const page = await document.getPage(n);
          const { width, height } = page.getViewport({ scale: 1 });
          pageSizes.push({ width, height });
        }
        if (!active) return;
        setSizes(pageSizes);
        setPdf(document);
        onPageCount?.(document.numPages);
      } catch (reason) {
        if (!active) return;
        const name = reason instanceof Error ? reason.name : '';
        setFailure((prev) => prev ?? (name === 'InvalidPDFException' ? { pdf: 'invalid' } : { network: true }));
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
      void document?.destroy().catch(() => {});
    };
    // onPageCount is a notification, not an input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, reload]);

  // Which pages are near the viewport, and which one is being read.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !pdf) return;
    const slots = [...viewport.querySelectorAll<HTMLElement>('[data-page-slot]')];
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const page = Number((entry.target as HTMLElement).dataset.pageSlot);
            if (entry.isIntersecting) next.add(page);
            else next.delete(page);
          }
          return next;
        });
      },
      { root: viewport, rootMargin: '150% 0px' },
    );
    slots.forEach((slot) => observer.observe(slot));
    const onScroll = () => {
      const top = viewport.scrollTop + viewport.clientHeight * 0.35;
      let page = 1;
      for (const slot of slots) if (slot.offsetTop <= top) page = Number(slot.dataset.pageSlot);
      setCurrent(page);
    };
    onScroll();
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', onScroll);
    };
  }, [pdf, sizes, zoom, width]);

  // Jump to the requested page once the layout exists.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !pdf || initialPage <= 1) return;
    const slot = viewport.querySelector<HTMLElement>(`[data-page-slot="${initialPage}"]`);
    if (slot) viewport.scrollTo({ top: slot.offsetTop });
  }, [pdf, initialPage, width]);

  const pageWidth = Math.max(1, Math.floor(width * zoom));
  const busy = loading || (!width && !failure);
  const problem = failure ? describeFailure(failure) : null;
  return (
    <section aria-label="PDF 미리보기" className="pdf-preview" data-pdf-preview>
      <div className="pdf-preview-bar">
        <button type="button" aria-label="축소" data-zoom-out disabled={!pdf || zoom === ZOOM_STEPS[0]} onClick={() => setZoom((z) => nextZoom(z, -1))}>
          <Minus size={18} />
        </button>
        <p aria-live="polite" data-page-indicator className="pdf-preview-indicator">
          {pdf ? `${current} / ${pdf.numPages} 쪽` : 'PDF 미리보기'}
          {zoom !== 1 && pdf ? ` · ${Math.round(zoom * 100)}%` : ''}
        </p>
        <button type="button" aria-label="확대" data-zoom-in disabled={!pdf || zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]} onClick={() => setZoom((z) => nextZoom(z, 1))}>
          <Plus size={18} />
        </button>
      </div>
      <div ref={viewportRef} aria-busy={busy} className="pdf-preview-viewport">
        {busy && !failure && (
          <div role="status" className="pdf-preview-state">
            <LoaderCircle size={24} className="animate-spin" />
            PDF를 불러오고 있어요
          </div>
        )}
        {problem && (
          <div role="alert" className="pdf-preview-state" data-preview-error>
            <AlertCircle size={24} className="text-muted" />
            <p>{problem.message}</p>
            {problem.retry && (
              <button type="button" data-preview-retry onClick={() => setReload((v) => v + 1)} className="pdf-preview-retry">
                <RotateCw size={16} /> 다시 시도
              </button>
            )}
          </div>
        )}
        {pdf && !problem && (
          <div className="pdf-preview-pages" style={{ width: pageWidth }}>
            {sizes.map((size, i) => (
              <PageSlot key={i} pdf={pdf} page={i + 1} width={pageWidth} height={Math.round((size.height / size.width) * pageWidth)} render={visible.has(i + 1)} title={title} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function PageSlot({ pdf, page, width, height, render, title }: { pdf: PDFDocumentProxy; page: number; width: number; height: number; render: boolean; title: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element || !render) return;
    let active = true;
    let task: RenderTask | undefined;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${title}, ${page}쪽`);
    canvas.dataset.pageCanvas = String(page);
    canvas.className = 'pdf-preview-canvas';
    setDrawn(false);
    (async () => {
      try {
        const proxy = await pdf.getPage(page);
        if (!active) return;
        task = renderPdfPage(proxy, canvas, width, window.devicePixelRatio || 1);
        await task.promise;
        if (active) {
          element.replaceChildren(canvas);
          setDrawn(true);
        }
      } catch {
        /* a cancelled render (zoom, unmount) draws nothing; the slot keeps its size */
      }
    })();
    return () => {
      active = false;
      task?.cancel();
      canvas.remove();
    };
  }, [pdf, page, width, render, title]);
  return (
    <div data-page-slot={page} data-page-drawn={drawn ? 'true' : 'false'} className="pdf-preview-slot" style={{ width, height }}>
      <div ref={host} className="pdf-preview-slot-host" />
      <span className="pdf-preview-page-badge">{page}</span>
    </div>
  );
}
