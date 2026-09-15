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

/** Seeds the cache from a response that already carried the body (create, edit). */
export function rememberMaterialDetail(detail: MaterialDetail) {
  details.set(keyOf(detail), Promise.resolve(detail));
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
