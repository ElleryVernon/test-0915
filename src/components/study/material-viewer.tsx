'use client';

// The material screen: one full-screen sheet with [미리보기 | 본문]. The preview draws the uploaded
// PDF continuously (see pdf-viewer.tsx); the text view shows the extracted body page by page with
// the PDF's images back in place. Opened from a citation it goes straight to that sentence.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, DownloadSimple, LoaderCircle, RotateCw } from '@/components/icons';
import type { Material } from '@/lib/contracts';
import { useMaterialDetail } from '@/lib/materials';
import { Button, Sheet } from '@/components/ui';
import { describeFailure, displayTitle, findCitation, metaLabel, placeImages, type PageLayout } from './material-layout';
import PdfViewer from './pdf-viewer';

type Tab = 'preview' | 'text';

export function MaterialViewer({ material, citation, onClose }: { material: Material | null; citation?: string; onClose: () => void }) {
  return (
    <Sheet open={!!material} onClose={onClose} title={material ? displayTitle(material.title) : '자료'} description={material ? metaLabel(material) : undefined} fullScreen>
      {material && <MaterialScreen key={`${material.id}:${material.contentHash}:${citation ?? ''}`} material={material} citation={citation} onClose={onClose} />}
    </Sheet>
  );
}

function MaterialScreen({ material, citation, onClose }: { material: Material; citation?: string; onClose: () => void }) {
  const body = useMaterialDetail(material);
  const isPdf = !!material.url && material.type.toLowerCase().includes('pdf');
  const isImage = !!material.url && material.type.toLowerCase().includes('image');
  const [tab, setTab] = useState<Tab>(isPdf && !citation ? 'preview' : 'text');
  const [pages, setPages] = useState<number | undefined>(material.pages);
  const detail = body.detail;
  const located = useMemo(() => (detail && citation ? findCitation(detail.content, citation, detail.pageBreaks) : null), [detail, citation]);
  const layouts = useMemo<PageLayout[]>(() => (detail ? placeImages(detail.content, detail.pageBreaks, detail.images ?? []) : []), [detail]);
  // Figures are numbered in reading order (the stored order skips filtered logos and backgrounds).
  const figureNumbers = useMemo(() => {
    const numbers = new Map<string, number>();
    for (const page of layouts) for (const block of page.blocks) if (block.kind === 'image') numbers.set(block.image.id, numbers.size + 1);
    return numbers;
  }, [layouts]);
  const textRef = useRef<HTMLDivElement>(null);

  // A citation: scroll its sentence into view once the body is laid out.
  useEffect(() => {
    if (tab !== 'text' || !located) return;
    const mark = textRef.current?.querySelector<HTMLElement>('[data-citation]');
    mark?.scrollIntoView({ block: 'center' });
  }, [tab, located, layouts]);

  const failure = body.failure ? describeFailure({ status: body.failure.status, network: body.failure.network }) : null;
  const download = material.url ? `${material.url}${material.url.includes('?') ? '&' : '?'}download=1` : null;
  return (
    <div className="material-screen" data-material-viewer>
      {(isPdf || isImage) && (
        <div className="segmented" role="tablist" aria-label="보기 방식">
          {(
            [
              ['preview', '미리보기'],
              ['text', '본문'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} data-viewer-tab={id} className={tab === id ? 'is-active' : undefined} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {tab === 'preview' && isPdf && material.url && (
        <PdfViewer url={material.url} title={displayTitle(material.title)} initialPage={located?.page ?? 1} onPageCount={setPages} />
      )}
      {tab === 'preview' && isImage && material.url && (
        <div className="material-image-preview">
          <img src={material.url} alt={displayTitle(material.title)} />
        </div>
      )}
      {tab === 'text' && (
        <div ref={textRef} className="material-text" data-material-text>
          {citation && detail && (
            <p className="material-citation-note" data-citation-note>
              {located ? `${located.page}쪽에서 인용 문장을 찾았어요.` : '인용 문장을 본문에서 찾지 못했어요. 자료가 수정됐을 수 있어요.'}
            </p>
          )}
          {body.loading && (
            <p className="material-state" role="status" aria-busy="true">
              <LoaderCircle size={18} className="animate-spin" /> 본문을 불러오고 있어요
            </p>
          )}
          {failure && (
            <div className="material-state" role="alert" data-text-error>
              <AlertCircle size={20} className="text-muted" />
              <p>{failure.message}</p>
              {failure.retry && (
                <Button variant="secondary" data-text-retry onClick={body.retry}>
                  <RotateCw size={16} /> 다시 시도
                </Button>
              )}
            </div>
          )}
          {detail && !detail.content.trim() && (
            <p className="material-state">
              추출한 본문이 없어요. 미리보기로 원본을 보며 학습하거나 본문을 직접 입력해 주세요.
            </p>
          )}
          {detail && detail.content.trim() && (
            <div data-material-content>
              {layouts.map((page) => (
                <section key={page.page} className="material-page" data-text-page={page.page} aria-label={`${page.page}쪽`}>
                  {layouts.length > 1 && <h3 className="material-page-label">{page.page}쪽</h3>}
                  {page.blocks.map((block, i) =>
                    block.kind === 'paragraph' ? (
                      <p key={`p${i}`} className="material-paragraph">
                        {highlight(block.paragraph.text, block.paragraph.start, located)}
                      </p>
                    ) : (
                      <figure key={`i${i}`} className="material-figure" data-figure={block.image.id}>
                        {/* Small images stay at their natural size instead of being blown up to the column width. */}
                        <img src={block.image.url} alt={`${page.page}쪽 그림 ${figureNumbers.get(block.image.id)}`} width={block.image.width} height={block.image.height} loading="lazy" style={{ width: `min(100%, ${block.image.width}px)` }} />
                        <figcaption>
                          그림 {figureNumbers.get(block.image.id)} · {block.image.page}쪽
                        </figcaption>
                      </figure>
                    ),
                  )}
                </section>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="material-screen-actions">
        {download && (
          <a className="button button-secondary" href={download} download data-download>
            <DownloadSimple size={18} /> 파일 저장
          </a>
        )}
        <Button variant="ghost" data-close-material onClick={onClose}>
          닫기
        </Button>
      </div>
      {pages !== undefined && material.pages === undefined && <span hidden data-page-count={pages} />}
    </div>
  );
}

/** Wraps the cited span of a paragraph in a <mark>; other paragraphs are returned as they are. */
function highlight(text: string, start: number, located: { start: number; end: number } | null) {
  if (!located || located.end <= start || located.start >= start + text.length) return text;
  const from = Math.max(0, located.start - start);
  const to = Math.min(text.length, located.end - start);
  return (
    <>
      {text.slice(0, from)}
      <mark data-citation>{text.slice(from, to)}</mark>
      {text.slice(to)}
    </>
  );
}
