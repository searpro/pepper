import { EventEmitter } from 'node:events';
import type { DestinationStream } from 'pino';
import type { LogLevelName } from './parse.js';

/**
 * In-memory ring buffer backing the UI's Log Viewer (requirement 10: search,
 * filter by type and state, realtime).
 *
 * It doubles as a pino `DestinationStream`, so `pino.multistream()` can tee
 * every application log line here as well as to stdout — the app's own logs
 * and the backends' output end up in one searchable stream rather than two
 * places the user has to correlate by timestamp.
 *
 * Retention is bounded and in-memory on purpose: this is a live tail, not an
 * audit log. Persisting it would put a write on the hot path of every
 * child-process line — thousands per generation — for data nobody reads after
 * the run finishes.
 */

/** What produced a record. Drives the UI's type filter. */
export type LogSource =
  | 'app'
  | 'http'
  | 'healthcheck'
  | 'job'
  | 'download'
  | 'sdcpp'
  | 'llamacpp'
  | 'audiocpp'
  | 'python';

export interface LogRecord {
  /** Monotonically increasing, so a client can resume a stream from where it left off. */
  seq: number;
  time: number;
  level: LogLevelName;
  source: LogSource;
  msg: string;
  /** Job/download id, HTTP status, backend origin — whatever the writer attached. */
  fields?: Record<string, unknown>;
}

export interface LogQuery {
  /** Case-insensitive substring match against the message and the fields. */
  search?: string;
  /** Restrict to these sources (the UI's "type" filter). */
  sources?: LogSource[];
  /** Minimum severity to include. */
  minLevel?: LogLevelName;
  /** Only records newer than this sequence number. */
  sinceSeq?: number;
  limit?: number;
}

export const LEVEL_ORDER: Record<LogLevelName, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const PINO_LEVELS: Record<number, LogLevelName> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

const DEFAULT_CAPACITY = 5000;

export class LogBuffer extends EventEmitter implements DestinationStream {
  private readonly records: LogRecord[] = [];
  private seq = 0;
  /**
   * Fastify logs each request twice — "incoming request" (has the url, no
   * status) and "request completed" (has the status, no url) — correlated by
   * `reqId`. Only the second is kept, tagged with the url held here in the
   * meantime, which halves buffered HTTP volume for free.
   */
  private readonly pendingRequests = new Map<string, string>();

  constructor(private readonly capacity = DEFAULT_CAPACITY) {
    super();
    // One subscriber per open SSE connection, plus the UI's log tail; the
    // default limit of 10 is low enough that a few browser tabs would print
    // spurious leak warnings.
    this.setMaxListeners(0);
  }

  /** pino `DestinationStream`: one serialized JSON record per call. */
  write(msg: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(msg);
    } catch {
      // A non-JSON write can only come from a misconfigured stream; keep the
      // line rather than dropping it, since losing logs is the worse failure.
      this.push({ level: 'info', source: 'app', msg: msg.trim() });
      return;
    }

    const { level, time, msg: message, reqId, req, res, responseTime, err, ...rest } = parsed as {
      level?: number;
      time?: number;
      msg?: string;
      reqId?: string;
      req?: { method?: string; url?: string };
      res?: { statusCode?: number };
      responseTime?: number;
      err?: unknown;
      [key: string]: unknown;
    };

    // "incoming request": remember the url and emit nothing yet.
    if (req?.url && res === undefined && reqId) {
      this.pendingRequests.set(reqId, `${req.method ?? 'GET'} ${req.url}`);
      // Bound the map: a client that disconnects before the response lands
      // would otherwise leave its entry behind forever.
      if (this.pendingRequests.size > 1000) {
        const oldest = this.pendingRequests.keys().next().value;
        if (oldest !== undefined) this.pendingRequests.delete(oldest);
      }
      return;
    }

    const levelName = PINO_LEVELS[level ?? 30] ?? 'info';
    const fields: Record<string, unknown> = { ...rest };
    delete fields.pid;
    delete fields.hostname;

    let source: LogSource = (rest.source as LogSource) ?? 'app';
    let text = message ?? '';

    if (res?.statusCode !== undefined && reqId) {
      const route = this.pendingRequests.get(reqId) ?? '';
      this.pendingRequests.delete(reqId);
      source = route.includes('/health') ? 'healthcheck' : 'http';
      text = `${route} → ${res.statusCode}${responseTime ? ` (${Math.round(responseTime)}ms)` : ''}`;
      fields.statusCode = res.statusCode;
    }

    if (err) fields.err = err;

    this.push({
      level: levelName,
      source,
      msg: text,
      time,
      fields: Object.keys(fields).length > 0 ? fields : undefined,
    });
  }

  /** Append a record directly (used for backend output, which never goes through pino). */
  push(input: {
    level: LogLevelName;
    source: LogSource;
    msg: string;
    time?: number;
    fields?: Record<string, unknown>;
  }): LogRecord {
    const record: LogRecord = {
      seq: ++this.seq,
      time: input.time ?? Date.now(),
      level: input.level,
      source: input.source,
      msg: input.msg,
      fields: input.fields,
    };
    this.records.push(record);
    if (this.records.length > this.capacity) {
      this.records.splice(0, this.records.length - this.capacity);
    }
    this.emit('record', record);
    return record;
  }

  /** Snapshot matching a filter, oldest first. */
  query(filter: LogQuery = {}): LogRecord[] {
    const min = filter.minLevel ? LEVEL_ORDER[filter.minLevel] : 0;
    const search = filter.search?.toLowerCase();
    const sources = filter.sources?.length ? new Set(filter.sources) : null;

    const matched = this.records.filter((record) => {
      if (LEVEL_ORDER[record.level] < min) return false;
      if (sources && !sources.has(record.source)) return false;
      if (filter.sinceSeq !== undefined && record.seq <= filter.sinceSeq) return false;
      if (search && !this.matchesSearch(record, search)) return false;
      return true;
    });

    const limit = filter.limit ?? 500;
    return matched.slice(-limit);
  }

  /** Subscribe to live records matching a filter. Returns an unsubscribe function. */
  subscribe(filter: LogQuery, listener: (record: LogRecord) => void): () => void {
    const min = filter.minLevel ? LEVEL_ORDER[filter.minLevel] : 0;
    const search = filter.search?.toLowerCase();
    const sources = filter.sources?.length ? new Set(filter.sources) : null;

    const onRecord = (record: LogRecord) => {
      if (LEVEL_ORDER[record.level] < min) return;
      if (sources && !sources.has(record.source)) return;
      if (search && !this.matchesSearch(record, search)) return;
      listener(record);
    };
    this.on('record', onRecord);
    return () => this.off('record', onRecord);
  }

  private matchesSearch(record: LogRecord, needle: string): boolean {
    if (record.msg.toLowerCase().includes(needle)) return true;
    if (record.source.includes(needle)) return true;
    if (!record.fields) return false;
    try {
      return JSON.stringify(record.fields).toLowerCase().includes(needle);
    } catch {
      return false;
    }
  }
}
