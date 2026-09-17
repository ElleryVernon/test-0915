'use client';
import { sessionFetch } from '@/lib/session-boundary';


// Continuous PDF preview: every page is laid out at once (so the scroll position is the reading
// position), rendered only when it comes near the viewport, re-rendered on zoom, with a live page
// indicator. The bytes are fetched first so HTTP failures (410 gone, 401 signed out, 404, offline)
// are reported precisely instead of as pdf.js's generic loading error.
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, Minus, Plus, RotateCw } from '@/components/icons';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { describeFailure, nextZoom, ZOOM_STEPS, type ViewerFailure } from './material-layout';
import { PDF_ASSET_BASE, renderPdfPage } from './pdf-render';
import { evidencePdfUrl, matchPdfEvidence, type PdfEvidencePage } from './pdf-evidence';

type PageSize = { width: number; height: number; page: number; documentPage: number };

export default function PdfViewer({
  url,
  title,
  initialPage = 1,
  onPageCount,
  evidence,
}: {
  url: string;
  title: string;
  /** Page to scroll to once the document is laid out (a citation's page). */
  initialPage?: number;
  onPageCount?: (pages: number) => void;
  /** Restrict both the downloaded PDF and rendered pages to verified evidence. */
  evidence?: PdfEvidencePage[];
}) {
  const evidenceKey = JSON.stringify(evidence);
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
    const controller = new AbortController();
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
          const requestUrl = evidence ? evidencePdfUrl(url, evidence) : url;
          if (!requestUrl) { setFailure({ pdf: 'invalid' }); return; }
          response = await sessionFetch(requestUrl, { credentials: 'same-origin', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]) });
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
        if (!active) { await document.destroy(); return; }
        if (evidence && document.numPages !== evidence.length) {
          setFailure({ pdf: 'invalid' });
          return;
        }
        const pageSizes: PageSize[] = [];
        for (let n = 1; n <= document.numPages; n++) {
          const page = await document.getPage(n);
          const { width, height } = page.getViewport({ scale: 1 });
          pageSizes.push({ width, height, page: evidence?.[n - 1].page ?? n, documentPage: n });
        }
        if (!active) return;
        setSizes(pageSizes);
        setPdf(document);
        if (!evidence) onPageCount?.(document.numPages);
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
      controller.abort();
      void document?.destroy().catch(() => {});
    };
    // onPageCount is a notification, not an input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, reload, evidenceKey]);

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
      let page = sizes[0]?.page ?? 1;
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
          {pdf ? evidence ? `PDF ${current}쪽 · 근거 ${sizes.length}쪽` : `${current} / ${pdf.numPages} 쪽` : 'PDF 미리보기'}
          {zoom !== 1 && pdf ? ` · ${Math.round(zoom * 100)}%` : ''}
        </p>
        <button type="button" aria-label="확대" data-zoom-in disabled={!pdf || zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]} onClick={() => setZoom((z) => nextZoom(z, 1))}>
          <Plus size={18} />
        </button>
      </div>
      {evidence && sizes.length > 1 && <nav className="pdf-evidence-pages" aria-label="근거 페이지">
        {sizes.map((size) => <button key={size.page} type="button" aria-current={current === size.page ? 'page' : undefined} onClick={() => {
          const viewport = viewportRef.current;
          const slot = viewport?.querySelector<HTMLElement>(`[data-page-slot="${size.page}"]`);
          if (viewport && slot) viewport.scrollTo({ top: slot.offsetTop });
        }}>{size.page}쪽</button>)}
      </nav>}
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
              <PageSlot key={size.page} pdf={pdf} page={size.page} documentPage={size.documentPage} quote={evidence?.[i]?.quote} width={pageWidth} height={Math.round((size.height / size.width) * pageWidth)} render={visible.has(size.page)} title={title} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function PageSlot({ pdf, page, documentPage, quote, width, height, render, title }: { pdf: PDFDocumentProxy; page: number; documentPage: number; quote?: string; width: number; height: number; render: boolean; title: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(false);
  const [highlightCount, setHighlightCount] = useState<number | null>(null);
  useEffect(() => {
    const element = host.current;
    if (!element || !render) { setDrawn(false); return; }
    let active = true;
    let task: RenderTask | undefined;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${title}, ${page}쪽`);
    canvas.dataset.pageCanvas = String(page);
    canvas.className = 'pdf-preview-canvas';
    setDrawn(false);
    setHighlightCount(null);
    (async () => {
      try {
        const proxy = await pdf.getPage(documentPage);
        if (!active) return;
        task = renderPdfPage(proxy, canvas, width, window.devicePixelRatio || 1);
        await task.promise;
        if (active) {
          element.replaceChildren(canvas);
          setDrawn(true);
        }
        if (quote && active) {
          const layer = await evidenceHighlights(proxy, width, quote);
          if (active) {
            element.append(layer);
            setHighlightCount(layer.childElementCount);
          }
        }
      } catch {
        if (active && quote) setHighlightCount(0);
        /* a cancelled render (zoom, unmount) draws nothing; the slot keeps its size */
      }
    })();
    return () => {
      active = false;
      task?.cancel();
      element.replaceChildren();
    };
  }, [pdf, page, documentPage, quote, width, render, title]);
  return (
    <div data-page-slot={page} data-page-drawn={drawn ? 'true' : 'false'} className="pdf-preview-slot" style={{ width, height }}>
      <div ref={host} className="pdf-preview-slot-host" />
      <span className="pdf-preview-page-badge">{page}</span>
      {quote && drawn && highlightCount === 0 && <span className="pdf-evidence-unmatched">강조 위치를 확인하지 못했어요 · 원본으로 확인해 주세요</span>}
    </div>
  );
}

async function evidenceHighlights(page: PDFPageProxy, width: number, quote: string): Promise<HTMLDivElement> {
  const content = await page.getTextContent();
  const items = content.items.filter((item): item is TextItem => 'str' in item);
  const matches = matchPdfEvidence(items, quote);
  const natural = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / natural.width });
  const layer = document.createElement('div');
  layer.className = 'pdf-evidence-highlights';
  layer.setAttribute('aria-hidden', 'true');
  const measuring = document.createElement('canvas').getContext('2d');
  if (!measuring) return layer;
  for (const match of matches) {
    const item = items[match.item];
    const [a, b, c, d, e, f] = viewport.transform;
    const tx = item.transform;
    // Horizontal text: the actual PDF glyph run determines the rectangle.
    // Do not invent rectangles for rotated labels whose geometry is ambiguous.
    if (Math.abs(b * tx[0] + d * tx[1]) > 0.1) continue;
    const x = a * tx[4] + c * tx[5] + e;
    const y = b * tx[4] + d * tx[5] + f;
    const fontHeight = Math.hypot(a * tx[2] + c * tx[3], b * tx[2] + d * tx[3]);
    const style = content.styles[item.fontName];
    measuring.font = `${fontHeight}px ${style?.fontFamily || 'sans-serif'}`;
    const full = measuring.measureText(item.str).width;
    if (!full || !fontHeight) continue;
    const from = measuring.measureText(item.str.slice(0, match.start)).width / full;
    const to = measuring.measureText(item.str.slice(0, match.end)).width / full;
    const mark = document.createElement('span');
    mark.dataset.evidenceHighlight = '';
    mark.title = item.str.slice(match.start, match.end);
    Object.assign(mark.style, {
      left: `${x + item.width * viewport.scale * from}px`,
      top: `${y - fontHeight * (style?.ascent ?? 0.8)}px`,
      width: `${item.width * viewport.scale * (to - from)}px`,
      height: `${fontHeight * 1.12}px`,
    });
    layer.append(mark);
  }
  return layer;
}
