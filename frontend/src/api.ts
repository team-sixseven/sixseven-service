import type { ServerEvent } from './types';

const TOKEN_KEY = 'token';
export const getToken = () => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t: string | null) => {
  try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* 저장 불가 */ }
};

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
    cache: 'no-store',
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token && !path.startsWith('/auth/')) onUnauthorized();
    const detail = data?.detail;
    throw new ApiError(res.status, typeof detail === 'string' ? detail : '요청을 처리하지 못했습니다.');
  }
  return data as T;
}

export function connectEvents(onEvent: (e: ServerEvent) => void, onClose: (code: number) => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry = 0;
  const open = () => {
    const token = getToken();
    if (!token || stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/ws?token=${encodeURIComponent(token)}`);
    ws.onmessage = (m) => { retry = 0; try { onEvent(JSON.parse(m.data)); } catch { /* 무시 */ } };
    ws.onclose = (e) => {
      if (stopped) return;
      if (e.code === 1008) { onClose(1008); return; }
      setTimeout(open, Math.min(1000 * 2 ** retry++, 10000));
    };
  };
  open();
  return () => { stopped = true; ws?.close(); };
}
