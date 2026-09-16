// Material bodies are not part of the bootstrap payload (it carries contentLength, an excerpt and
// a hash). Screens that need the text ask for the detail once and keep it for the session; the
// hash in the key means an edited material is fetched again while an unchanged one never is.
import { useEffect, useState } from 'react';
import type { Material, MaterialDetail } from './contracts';

/** An API failure with its HTTP status, so screens can tell "signed out" from "gone" from "offline". */
export class DetailError extends Error {
  constructor(message: string, readonly status?: number, readonly network = false) {
    super(message);
  }
}

async function loadDetail(id: string): Promise<MaterialDetail> {
  let response: Response;
  try {
    // jitter: none — one fetch a person starts, single-flight per id + content hash; retried only by the next open or the retry button [site src/lib/materials.ts:17]
    response = await fetch(`/api/materials/${id}`, { signal: AbortSignal.timeout(20000) });
  } catch {
    throw new DetailError('연결이 끊겼어요. 연결을 확인하고 다시 시도해 주세요.', undefined, true);
  }
  const result = await response.json().catch(() => ({ error: '응답을 읽을 수 없어요. 다시 시도해 주세요.' }));
  if (!response.ok) throw new DetailError(result.error || '자료를 불러오지 못했어요.', response.status);
  return result.data as MaterialDetail;
}

// jitter: none — no TTL: entries are keyed by id + content hash and never expire on a timer, like every client cache, so none expire together [site src/lib/materials.ts:31]
const details = new Map<string, Promise<MaterialDetail>>();

const keyOf = (material: Pick<Material, 'id' | 'contentHash'>) => `${material.id}:${material.contentHash}`;

/** The full material (body, page breaks, images), fetched at most once per id and content hash. */
export function fetchMaterialDetail(material: Pick<Material, 'id' | 'contentHash'>): Promise<MaterialDetail> {
  const key = keyOf(material);
  let pending = details.get(key);
  if (!pending) {
    pending = loadDetail(material.id).catch((error) => {
      details.delete(key); // a failure is not remembered; the next open retries
      throw error;
    });
    details.set(key, pending);
  }
  return pending;
}

/** Remembers one body under its id and content hash; rememberSavedMaterial decides when that is right. */
export function rememberMaterialDetail(detail: MaterialDetail) {
  details.set(keyOf(detail), Promise.resolve(detail));
}

/**
 * Seeds the cache from a save that answered with the material (create, edit, the sample chapter).
 * That answer carries the body but not the file's images or page count — only GET /api/materials/:id
 * has them — so it is the whole detail by itself for a material saved without a file. With a file,
 * the images and the page count belong to the upload and a save does not change them: they come from
 * the detail the screen already had. Without that detail nothing is remembered, so a material is
 * never shown missing its images; the next open fetches it as before.
 */
export function rememberSavedMaterial(saved: Material, loaded?: MaterialDetail | null) {
  if (saved.content === undefined) return;
  const body = { ...saved, content: saved.content };
  if (!saved.uploadId) rememberMaterialDetail({ ...body, images: [], pages: undefined });
  else if (loaded && loaded.id === saved.id && loaded.uploadId === saved.uploadId)
    rememberMaterialDetail({ ...body, images: loaded.images, pages: loaded.pages });
}

/**
 * The material as it stands after a save. The answer is the row alone: it has no page count and no
 * image count, which the bootstrap summary carries and screens show in the material's meta line.
 * Both belong to the uploaded file, which a save does not touch, so they stay from the material that
 * was saved over; an answer that does carry them wins.
 */
export function mergeSavedMaterial(previous: Material, saved: Material): Material {
  return { ...saved, pages: saved.pages ?? previous.pages, imageCount: saved.imageCount ?? previous.imageCount };
}

/** Drops every remembered body (sign-out). */
export function forgetMaterialDetails() {
  details.clear();
}

export type MaterialDetailState = { detail: MaterialDetail | null; loading: boolean; error: string; failure: DetailError | null; retry: () => void };

/** React view of fetchMaterialDetail for the material currently open (null closes it). */
export function useMaterialDetail(material: Pick<Material, 'id' | 'contentHash'> | null): MaterialDetailState {
  const key = material ? keyOf(material) : '';
  const [state, setState] = useState<{ key: string; detail: MaterialDetail | null; error: string; failure: DetailError | null; attempt: number }>({ key: '', detail: null, error: '', failure: null, attempt: 0 });
  const attempt = state.key === key ? state.attempt : 0;
  useEffect(() => {
    if (!material) return;
    let live = true;
    fetchMaterialDetail(material).then(
      (detail) => live && setState({ key, detail, error: '', failure: null, attempt }),
      (error: Error) =>
        live && setState({ key, detail: null, error: error.message || '자료를 불러오지 못했어요.', failure: error instanceof DetailError ? error : new DetailError(error.message), attempt }),
    );
    return () => {
      live = false;
    };
    // The material identity is its key; attempt re-runs the fetch after a retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  const current = state.key === key ? state : { key, detail: null, error: '', failure: null, attempt };
  return {
    detail: current.detail,
    loading: !!material && !current.detail && !current.error,
    error: current.error,
    failure: current.failure,
    retry: () => setState({ key, detail: null, error: '', failure: null, attempt: current.attempt + 1 }),
  };
}
