import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * API client and the two hooks every screen is built from.
 *
 * `useResource` polls; `useEventStream` subscribes to a live stream. The split matters:
 * anything that changes because *the server* did something — a job advancing,
 * a download's byte count, a log line — arrives over a stream, because polling it
 * fast enough to feel live would mean a request every few hundred
 * milliseconds per open tab. Everything else (the model list, the catalogue)
 * is fetched on demand and refetched when an action invalidates it.
 */

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError,
  ) {
    super(error.message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const body = text ? safeJson(text) : undefined;

  if (!response.ok) {
    const error = (body as { error?: ApiError })?.error ?? {
      code: 'HTTP_ERROR',
      message: `${response.status} ${response.statusText}`,
    };
    throw new ApiRequestError(response.status, error);
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<T>(path, { method: 'POST', body: form });
  },
};

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
}

/** Fetch a path, with an optional refresh interval. */
export function useResource<T>(path: string | null, intervalMs?: number): Resource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(Boolean(path));
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    // Guards against a slow first response overwriting a fast second one
    // after the path changed — switching model kinds quickly otherwise shows
    // the previous kind's list.
    let live = true;

    const load = async () => {
      try {
        const result = await api.get<T>(path);
        if (!live) return;
        setData(result);
        setError(undefined);
      } catch (err) {
        if (!live) return;
        setError(err instanceof ApiRequestError ? err.error : { code: 'NETWORK', message: String(err) });
      } finally {
        if (live) setLoading(false);
      }
    };

    void load();
    if (!intervalMs) return () => {
      live = false;
    };

    const timer = setInterval(() => void load(), intervalMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [path, intervalMs, nonce]);

  return { data, error, loading, reload };
}

/**
 * Subscribe to one of the server's live streams.
 *
 * Every stream URL answers both SSE and a WebSocket upgrade. The WebSocket is
 * tried first because Cloudflare quick tunnels — how a Kaggle deployment is
 * reached — do not pass SSE through at all; if the socket cannot open even
 * once, the hook falls back to `EventSource` for the rest of its life. A
 * dropped socket reconnects with backoff (what `EventSource` does on its own);
 * a normal close (code 1000) means the server ended the stream on purpose,
 * e.g. a finished job, and is left closed.
 *
 * `onEvent` is held in a ref rather than being a dependency: a handler defined
 * inline in a component is a new function on every render, and using it as a
 * dependency would tear down and re-open the stream on each one — which
 * on a log stream means losing the replay buffer several times a second.
 */
export function useEventStream(
  path: string | null,
  onEvent: (event: string, data: unknown) => void,
  events: string[],
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  const eventKey = events.join(',');

  useEffect(() => {
    if (!path) return;
    const names = new Set(eventKey.split(','));
    let stopped = false;
    let teardown = () => {};

    const openSse = () => {
      const source = new EventSource(path);
      source.onopen = () => setConnected(true);
      source.onerror = () => setConnected(false);
      for (const name of names) {
        source.addEventListener(name, (event: MessageEvent) => {
          try {
            handler.current(name, JSON.parse(event.data));
          } catch {
            // A malformed frame is not worth tearing the stream down for.
          }
        });
      }
      teardown = () => source.close();
    };

    let everOpened = false;
    let retryMs = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const openWs = () => {
      const url = new URL(path, window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url);
      socket.onopen = () => {
        everOpened = true;
        retryMs = 1000;
        setConnected(true);
      };
      socket.onmessage = (message) => {
        try {
          const { event, data } = JSON.parse(message.data as string) as { event: string; data: unknown };
          if (names.has(event)) handler.current(event, data);
        } catch {
          // A malformed frame is not worth tearing the stream down for.
        }
      };
      socket.onclose = (close) => {
        setConnected(false);
        if (stopped || close.code === 1000) return;
        if (!everOpened) {
          openSse();
          return;
        }
        retryTimer = setTimeout(openWs, retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      };
      teardown = () => {
        socket.onclose = null;
        socket.close();
      };
    };

    openWs();

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      teardown();
      setConnected(false);
    };
  }, [path, eventKey]);

  return { connected };
}

// --- Shared response types --------------------------------------------------

export type ModelKind = 'image' | 'video' | 'audio' | 'llm';

export interface ComponentFile {
  name: string;
  size: number;
  modified: number;
  slot: string;
  role?: string;
  ref?: string;
}

export interface BundleInfo {
  id: string;
  kind: ModelKind;
  name: string;
  manifest: Record<string, unknown> | null;
  loadMode: string;
  mode: 'image' | 'video';
  components: ComponentFile[];
  partials: { slot: string; name: string; received: number; total: number | null }[];
  /** Declared extras, e.g. `s2v` for a speech-conditioned video model. */
  capabilities: string[];
  size: number;
  modified: string;
  ready: boolean;
  readyReason?: string;
}

export interface DownloadTask {
  id: string;
  kind: ModelKind;
  bundle: string;
  slot: string;
  name: string;
  url: string;
  status: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled';
  received: number;
  total: number | null;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'text';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  step?: number;
  totalSteps?: number;
  params: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  attempts: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * Wait for a queued job to reach a terminal state.
 *
 * Audio and text screens submit a job and then need the one result, unlike the
 * image screen which watches a whole fleet of them over SSE. Polling a single
 * id is the smaller tool for that: no stream to tear down when the component
 * unmounts mid-generation, and the job survives the wait regardless.
 */
export async function waitForJob(id: string, intervalMs = 700): Promise<Job> {
  for (;;) {
    const job = await api.get<Job>(`/v1/jobs/${encodeURIComponent(id)}`);
    if (job.status !== 'queued' && job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export interface LogRecord {
  seq: number;
  time: number;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  source: string;
  msg: string;
  fields?: Record<string, unknown>;
}

export interface ArgDefinition {
  key: string;
  flag: string;
  label: string;
  description?: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  options?: string[];
  defaultValue?: string | number | boolean | null;
  locked?: boolean;
  min?: number;
  max?: number;
  value: string | number | boolean | null;
  overridden: boolean;
}

export interface BackendStatus {
  backend: 'sdcpp' | 'llamacpp' | 'audiocpp' | 'python' | 'vllm';
  label: string;
  kind: 'server' | 'cli';
  status: 'stopped' | 'installing' | 'starting' | 'ready' | 'unhealthy' | 'failed';
  installed: boolean;
  binaryPath?: string;
  releaseTag?: string;
  releaseRepo: string;
  pid?: number;
  startedAt?: string;
  lastError?: string;
  restarts: number;
  lastRestartReason?: string;
  /** Why it last stopped on its own (the idle timeout). */
  lastStopReason?: string;
  /** Requests or jobs using it right now. */
  inFlight: number;
  lastActivityAt?: string;
  /** When the idle timeout will stop it if nothing uses it first. */
  idleStopAt?: string;
  /** Why the last start was skipped (e.g. no audio models installed). */
  note?: string;
  idleTimeoutMs: number;
  stats?: { rssKb: number; swapKb: number | null };
  recentOutput: string[];
  args: ArgDefinition[];
  extraArgs: string[];
  argv: string[];
}

export interface ResourceSnapshot {
  sampledAt: string;
  cpu: { percent: number; cores: number };
  memory: { usedBytes: number; totalBytes: number };
  gpu: {
    name: string;
    count: number;
    percent: number | null;
    memoryUsedBytes: number | null;
    memoryTotalBytes: number | null;
    /** GPU memory is system RAM (Apple Silicon) rather than dedicated VRAM. */
    unified: boolean;
  } | null;
}

export interface SystemStatus {
  version: string;
  uptime: number;
  accel: string;
  platform: string;
  backends: BackendStatus[];
  resources?: ResourceSnapshot;
  /** Effective idle timeout for server backends; 0 = never stopped for idleness. */
  idleTimeoutMs: number;
  jobs: { running: number; queued: number; capacity: number };
  catalogue: { loaded: boolean; source: string; modelCount: number; url: string; error?: string };
  paths: { dataDir: string; modelsDir: string; outputDir: string };
}

export interface CatalogueModel {
  id: string;
  kind: ModelKind;
  name: string;
  description?: string;
  reference?: string;
  tags: string[];
  params?: string;
  family?: string;
  task?: string;
  components: {
    slot: string;
    role?: string;
    label: string;
    description?: string;
    required: boolean;
    quantizable: boolean;
    files?: { path: string; filename: string; size: number; quant?: string; url: string }[];
    /** `allFiles` components install every listed file rather than one pick. */
    source?: { repo?: string; allFiles?: boolean };
    error?: string;
  }[];
}

export interface MediaItem {
  name: string;
  kind: 'image' | 'video' | 'audio' | 'other';
  size: number;
  modified: string;
  url: string;
}
