export async function api<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    signal: AbortSignal.timeout(path === '/bootstrap' ? 20000 : 150000),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response
    .json()
    .catch(() => ({ error: '응답을 읽을 수 없어요. 다시 시도해 주세요.' }));
  if (!response.ok) throw new Error(result.error || '요청을 처리하지 못했어요.');
  return result.data as T;
}
