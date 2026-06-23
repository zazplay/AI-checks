import axios from 'axios';
import type {
  Invoice,
  InvoicePage,
  InvoicePageParams,
  InvoiceStatus,
} from '../types/invoice';
import type {
  AskResponse,
  AssistantStep,
  ChatTurn,
  Insights,
} from '../types/assistant';
import type { InvoiceStats } from '../types/stats';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export const http = axios.create({ baseURL: API_URL });

const TOKEN_STORAGE_KEY = 'invoice-system.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
  else localStorage.removeItem(TOKEN_STORAGE_KEY);
}

// Attach the stored key unless the caller set its own (login probes a candidate).
http.interceptors.request.use((config) => {
  const token = getToken();
  if (token && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/**
 * Drive the SSE chat endpoint with fetch + a stream reader. Parses `data:` SSE
 * frames into `{type:'step'|'result'|'error'}` messages, forwarding steps to
 * `onStep` and resolving on the result (or throwing on error/no-result).
 */
async function askStream(
  body: { message: string; history?: ChatTurn[]; confirm?: { token: string } },
  onStep: (step: AssistantStep) => void,
  signal?: AbortSignal,
): Promise<AskResponse> {
  const token = getToken();
  const res = await fetch(`${API_URL}/assistant/messages/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Stream failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: AskResponse | null = null;

  const handleFrame = (raw: string) => {
    // An SSE frame may carry multiple `data:` lines; join their payloads.
    const payload = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!payload) return;
    const msg = JSON.parse(payload) as
      | { type: 'step'; step: AssistantStep }
      | { type: 'result'; result: AskResponse }
      | { type: 'error'; message: string };
    if (msg.type === 'step') onStep(msg.step);
    else if (msg.type === 'result') result = msg.result;
    else throw new Error(msg.message);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (frame.trim()) handleFrame(frame);
    }
  }
  if (buffer.trim()) handleFrame(buffer);

  if (!result) throw new Error('Stream ended without a result.');
  return result;
}

export const api = {
  login: (username: string, password: string) =>
    http
      .post<{ accessToken: string }>('/auth/login', { username, password })
      .then((r) => r.data),

  listInvoices: (status?: InvoiceStatus) =>
    http
      .get<Invoice[]>('/invoices', { params: status ? { status } : undefined })
      .then((r) => r.data),

  /** One page of the invoice list (server-side filter/sort/paginate). */
  listInvoicesPage: (p: InvoicePageParams) =>
    http
      .get<InvoicePage>('/invoices', {
        params: {
          page: p.page,
          limit: p.limit,
          ...(p.status ? { status: p.status } : {}),
          ...(p.search ? { search: p.search } : {}),
          ...(p.sort ? { sort: p.sort } : {}),
          ...(p.dir ? { dir: p.dir } : {}),
        },
      })
      .then((r) => r.data),

  getInvoice: (id: string) =>
    http.get<Invoice>(`/invoices/${id}`).then((r) => r.data),

  uploadInvoice: (file: File, onProgress?: (pct: number) => void) => {
    const form = new FormData();
    form.append('file', file);
    return http
      .post<Invoice>('/invoices', form, {
        onUploadProgress: (e) =>
          onProgress?.(e.total ? Math.round((e.loaded / e.total) * 100) : 0),
      })
      .then((r) => r.data);
  },

  getInvoiceFile: (id: string) =>
    http
      .get<Blob>(`/invoices/${id}/file`, { responseType: 'blob' })
      .then((r) => r.data),

  /** Fetch an export (xlsx/csv/zip) as a blob via a relative API path (auth attached). */
  downloadExport: (relativeUrl: string) =>
    http.get<Blob>(relativeUrl, { responseType: 'blob' }).then((r) => r.data),

  deleteInvoice: (id: string) =>
    http.delete(`/invoices/${id}`).then(() => undefined),

  retryInvoice: (id: string) =>
    http.post<Invoice>(`/invoices/${id}/retry`).then((r) => r.data),

  ask: (
    message: string,
    history?: ChatTurn[],
    confirm?: { token: string },
    signal?: AbortSignal,
  ) =>
    http
      .post<AskResponse>('/assistant/messages', { message, history, confirm }, { signal })
      .then((r) => r.data),

  /**
   * Streaming chat: posts the same body as `ask` to the SSE endpoint, invokes
   * `onStep` for each live progress step, and resolves with the final
   * AskResponse. Uses fetch (not EventSource, which can't POST or send the auth
   * header). On any transport/parse failure it rejects so the caller can fall
   * back to the plain `ask`.
   */
  askStream: (
    message: string,
    history: ChatTurn[] | undefined,
    confirm: { token: string } | undefined,
    onStep: (step: AssistantStep) => void,
    signal?: AbortSignal,
  ): Promise<AskResponse> => askStream({ message, history, confirm }, onStep, signal),

  getStats: () => http.get<InvoiceStats>('/invoices/stats').then((r) => r.data),

  analyze: () => http.post<Insights>('/assistant/analyze').then((r) => r.data),

  explainInvoice: (id: string) =>
    http
      .post<{ summary: string }>(`/assistant/invoices/${id}/explain`)
      .then((r) => r.data),

  getModels: () =>
    http
      .get<{ current: string; available: string[] }>('/ai/models')
      .then((r) => r.data),

  setModel: (model: string) =>
    http
      .put<{ current: string; available: string[] }>('/ai/model', { model })
      .then((r) => r.data),

  getAssistantEngine: () =>
    http
      .get<{ current: EngineChoice; options: EngineOption[] }>('/ai/assistant-engine')
      .then((r) => r.data),

  setAssistantEngine: (provider: AssistantProvider, model: string) =>
    http
      .put<{ current: EngineChoice; options: EngineOption[] }>('/ai/assistant-engine', {
        provider,
        model,
      })
      .then((r) => r.data),
};

export type AssistantProvider = 'gemini' | 'groq' | 'claude';
export interface EngineChoice {
  provider: AssistantProvider;
  model: string;
}
export interface EngineOption {
  provider: AssistantProvider;
  model: string;
  available: boolean;
}

/** Human-readable message from an axios/Nest error (Nest may return string[]). */
export function apiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { message?: string | string[] } | undefined;
    if (data?.message) {
      return Array.isArray(data.message) ? data.message.join('; ') : data.message;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'Unknown error';
}
