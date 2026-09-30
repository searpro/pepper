import { randomUUID } from 'node:crypto';

/**
 * A client for the handful of ComfyUI endpoints Pepper Pro uses: `/prompt`,
 * `/history`, `/interrupt`, `/queue`, `/free`, `/object_info`,
 * `/system_stats` and the `/ws` event stream. Nothing else — the smaller the
 * surface, the fewer places an upstream change can break (docs/PEPPER-PRO.md
 * §11).
 */

/** One node of an API-format prompt. */
export interface PromptNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

/** An API-format prompt: node id → node. Links are `[nodeId, outputIndex]`. */
export type Prompt = Record<string, PromptNode>;

/** A file a node wrote, as `/history` reports it. */
export interface OutputFile {
  filename: string;
  subfolder: string;
  type: 'output' | 'temp' | 'input' | string;
}

export interface HistoryEntry {
  outputs: Record<string, Record<string, unknown>>;
  status?: {
    status_str?: 'success' | 'error' | string;
    completed?: boolean;
    messages?: [string, Record<string, unknown>][];
  };
}

/** `/object_info` for one node type, the part validation reads. */
export interface NodeInfo {
  input: {
    required?: Record<string, unknown[]>;
    optional?: Record<string, unknown[]>;
    hidden?: Record<string, unknown>;
  };
  output?: string[];
  output_node?: boolean;
  python_module?: string;
}

export type ObjectInfo = Record<string, NodeInfo>;

/** Events a prompt emits while it runs, as the engine consumes them. */
export type ExecutionEvent =
  | { type: 'executing'; node: string | null }
  | { type: 'progress'; node: string; value: number; max: number }
  | { type: 'cached'; nodes: string[] }
  | { type: 'success' }
  | { type: 'error'; nodeId?: string; nodeType?: string; exceptionType?: string; message: string; traceback?: string[] }
  | { type: 'interrupted' };

/** The error ComfyUI returns when it rejects a prompt before running it. */
export class PromptRejected extends Error {
  constructor(
    message: string,
    readonly nodeErrors: Record<string, { errors?: { message: string; details?: string }[]; class_type?: string }>,
  ) {
    super(message);
  }
}

export class ComfyClient {
  readonly clientId = randomUUID();

  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    const body = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) {
      const error = body as { error?: { message?: string; details?: string }; node_errors?: PromptRejected['nodeErrors'] };
      if (path === '/prompt' && error?.error) {
        throw new PromptRejected(
          [error.error.message, error.error.details].filter(Boolean).join(': '),
          error.node_errors ?? {},
        );
      }
      throw new Error(`ComfyUI ${path} answered ${response.status}: ${text.slice(0, 300)}`);
    }
    return body as T;
  }

  objectInfo(): Promise<ObjectInfo> {
    return this.request('/object_info', undefined, 120_000);
  }

  systemStats(): Promise<Record<string, unknown>> {
    return this.request('/system_stats');
  }

  /** Queue a prompt; resolves to its id. */
  async queue(prompt: Prompt): Promise<string> {
    const result = await this.request<{ prompt_id: string; node_errors?: PromptRejected['nodeErrors'] }>('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: this.clientId }),
    });
    const nodeErrors = result.node_errors ?? {};
    if (Object.keys(nodeErrors).length > 0) throw new PromptRejected('Prompt has node errors', nodeErrors);
    return result.prompt_id;
  }

  async history(promptId: string): Promise<HistoryEntry | null> {
    const all = await this.request<Record<string, HistoryEntry>>(`/history/${encodeURIComponent(promptId)}`);
    return all[promptId] ?? null;
  }

  /**
   * Stop the running prompt. ComfyUI's interrupt is global — it stops
   * whatever is executing — which is why the engine runs one prompt at a
   * time: an interrupt can then only hit the job it was meant for.
   */
  async interrupt(): Promise<void> {
    await this.request('/interrupt', { method: 'POST' });
  }

  /** Drop a prompt that is still waiting in ComfyUI's own queue. */
  async dequeue(promptId: string): Promise<void> {
    await this.request('/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    });
  }

  /** Unload models and release cached memory. */
  async free(options: { unloadModels: boolean; freeMemory: boolean }): Promise<void> {
    await this.request('/free', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: options.unloadModels, free_memory: options.freeMemory }),
    });
  }

  /**
   * Follow one prompt's execution over the WebSocket. The socket is opened
   * before the prompt is queued (`open()` resolves once it is connected), so
   * no early event is missed; events for other prompts are ignored.
   */
  async open(): Promise<PromptWatcher> {
    const url = `${this.baseUrl.replace(/^http/, 'ws')}/ws?clientId=${this.clientId}`;
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`Cannot connect to ComfyUI at ${url}`)), { once: true });
    });
    return new PromptWatcher(socket);
  }
}

/** One prompt's events, from the shared client WebSocket. */
export class PromptWatcher {
  private promptId: string | null = null;
  private readonly buffered: { type: string; data: Record<string, unknown> }[] = [];
  private listener: ((event: ExecutionEvent) => void) | null = null;
  private closed = false;

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (message) => {
      // Binary frames are previews; nothing here uses them.
      if (typeof message.data !== 'string') return;
      let parsed: { type?: string; data?: Record<string, unknown> };
      try {
        parsed = JSON.parse(message.data) as typeof parsed;
      } catch {
        return;
      }
      if (!parsed.type || !parsed.data) return;
      if (this.promptId === null) {
        this.buffered.push({ type: parsed.type, data: parsed.data });
        return;
      }
      this.dispatch(parsed.type, parsed.data);
    });
    socket.addEventListener('close', () => {
      if (!this.closed) this.listener?.({ type: 'error', message: 'Lost the connection to ComfyUI' });
    });
  }

  /** Start delivering events for `promptId`, including any that arrived before it was known. */
  follow(promptId: string, listener: (event: ExecutionEvent) => void): void {
    this.promptId = promptId;
    this.listener = listener;
    for (const { type, data } of this.buffered.splice(0)) this.dispatch(type, data);
  }

  close(): void {
    this.closed = true;
    this.socket.close();
  }

  private dispatch(type: string, data: Record<string, unknown>): void {
    if (data.prompt_id !== undefined && data.prompt_id !== this.promptId) return;
    const emit = (event: ExecutionEvent) => this.listener?.(event);
    switch (type) {
      case 'executing':
        emit({ type: 'executing', node: (data.node as string | null) ?? null });
        break;
      case 'progress':
        emit({ type: 'progress', node: String(data.node), value: Number(data.value), max: Number(data.max) });
        break;
      case 'execution_cached':
        emit({ type: 'cached', nodes: ((data.nodes as string[]) ?? []).map(String) });
        break;
      case 'execution_success':
        emit({ type: 'success' });
        break;
      case 'execution_interrupted':
        emit({ type: 'interrupted' });
        break;
      case 'execution_error':
        emit({
          type: 'error',
          nodeId: data.node_id === undefined ? undefined : String(data.node_id),
          nodeType: data.node_type as string | undefined,
          exceptionType: data.exception_type as string | undefined,
          message: String(data.exception_message ?? 'ComfyUI reported an error'),
          traceback: data.traceback as string[] | undefined,
        });
        break;
    }
  }
}
