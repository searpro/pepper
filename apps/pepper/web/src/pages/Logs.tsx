import * as React from 'react';
import { ArrowDownToLine, Pause, Play, Search, Trash2 } from 'lucide-react';
import { useEventStream, type LogRecord } from '@/lib/api';
import { Badge, Button, Card, Input, Select, Tooltip } from '@/components/ui';
import { Page } from '@/components/layout';
import { cn, formatTime } from '@/lib/utils';

const SOURCES = [
  'app',
  'http',
  'healthcheck',
  'job',
  'download',
  'sdcpp',
  'llamacpp',
  'audiocpp',
  'python',
] as const;

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

const LEVEL_STYLE: Record<string, string> = {
  trace: 'text-muted-foreground/70',
  debug: 'text-muted-foreground',
  info: 'text-foreground',
  warn: 'text-[var(--warning)]',
  error: 'text-destructive',
  fatal: 'text-destructive font-semibold',
};

const MAX_RENDERED = 2000;

/**
 * The Log viewer (requirement 10: "Support search, filtering by type, state
 * etc - realtime").
 *
 * The filters are part of the stream URL, not a client-side `.filter()` on the
 * rendered list. On a running generation the backend emits thousands of lines
 * a minute; shipping all of them so the browser can hide most is what makes a
 * log viewer stutter, and the server already knows how to answer the question.
 * Changing a filter therefore reopens the stream — which also replays a
 * matching window, so the pane is never empty after a filter change.
 */
export function LogsPage() {
  const [records, setRecords] = React.useState<LogRecord[]>([]);
  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [source, setSource] = React.useState('');
  const [minLevel, setMinLevel] = React.useState('');
  const [paused, setPaused] = React.useState(false);
  const [follow, setFollow] = React.useState(true);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Reopening the stream on every keystroke would drop the replay buffer each
  // time; a short debounce makes typing a search feel continuous.
  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const streamUrl = React.useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (source) params.set('source', source);
    if (minLevel) params.set('minLevel', minLevel);
    params.set('limit', '400');
    return `/v1/logs/stream?${params.toString()}`;
  }, [debouncedSearch, source, minLevel]);

  // Clear on filter change: the replay burst that follows is the new filter's
  // history, and mixing it with the old filter's records would be misleading.
  React.useEffect(() => setRecords([]), [streamUrl]);

  const { connected } = useEventStream(
    paused ? null : streamUrl,
    (_event, data) => {
      const record = data as LogRecord;
      setRecords((current) => {
        const next = [...current, record];
        return next.length > MAX_RENDERED ? next.slice(-MAX_RENDERED) : next;
      });
    },
    ['record'],
  );

  React.useEffect(() => {
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [records, follow]);

  return (
    <Page
      title="Logs"
      description="Live output from the app and every backend, with the severity each line reported."
      actions={
        <div className="flex items-center gap-2">
          <Badge variant={connected ? 'success' : paused ? 'outline' : 'warning'}>
            {paused ? 'paused' : connected ? 'live' : 'connecting'}
          </Badge>
          <Tooltip label={paused ? 'Resume' : 'Pause'}>
            <Button variant="ghost" size="icon-sm" onClick={() => setPaused((value) => !value)}>
              {paused ? <Play /> : <Pause />}
            </Button>
          </Tooltip>
          <Tooltip label={follow ? 'Stop following' : 'Follow new lines'}>
            <Button
              variant={follow ? 'secondary' : 'ghost'}
              size="icon-sm"
              onClick={() => setFollow((value) => !value)}
            >
              <ArrowDownToLine />
            </Button>
          </Tooltip>
          <Tooltip label="Clear the view">
            <Button variant="ghost" size="icon-sm" onClick={() => setRecords([])}>
              <Trash2 />
            </Button>
          </Tooltip>
        </div>
      }
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search messages and fields…"
            className="pl-8"
          />
        </div>
        <Select
          value={source}
          onValueChange={setSource}
          options={[
            { value: '', label: 'All sources' },
            ...SOURCES.map((option) => ({ value: option, label: option })),
          ]}
          className="w-40"
        />
        <Select
          value={minLevel}
          onValueChange={setMinLevel}
          options={[
            { value: '', label: 'All levels' },
            ...LEVELS.map((level) => ({ value: level, label: `${level} and above` })),
          ]}
          className="w-44"
        />
      </div>

      <Card className="min-h-0 flex-1 overflow-hidden p-0">
        <div
          ref={scrollRef}
          onScroll={(event) => {
            // Scrolling up is how a user says "stop moving"; snapping back to
            // the bottom while they read is the single most irritating thing a
            // log viewer can do.
            const element = event.currentTarget;
            const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
            if (atBottom !== follow) setFollow(atBottom);
          }}
          className="h-[calc(100dvh-16rem)] overflow-y-auto scrollbar-thin"
        >
          {records.length === 0 ? (
            <p className="p-6 text-center text-xs text-muted-foreground">
              No log records match these filters yet.
            </p>
          ) : (
            <table className="w-full border-collapse text-[11.5px] leading-relaxed">
              <tbody>
                {records.map((record) => (
                  <tr key={record.seq} className="border-b border-border/40 last:border-0 hover:bg-accent/40">
                    <td className="w-20 whitespace-nowrap px-2 py-1 align-top font-mono text-muted-foreground">
                      {formatTime(record.time)}
                    </td>
                    <td className="w-14 px-1 py-1 align-top">
                      <span className={cn('font-mono uppercase', LEVEL_STYLE[record.level])}>
                        {record.level.slice(0, 4)}
                      </span>
                    </td>
                    <td className="w-24 px-1 py-1 align-top">
                      <Badge variant="outline">{record.source}</Badge>
                    </td>
                    <td className={cn('px-2 py-1 align-top font-mono', LEVEL_STYLE[record.level])}>
                      <span className="whitespace-pre-wrap break-words">{record.msg}</span>
                      {record.fields && Object.keys(record.fields).length > 0 ? (
                        <span className="ml-2 text-muted-foreground/70">
                          {JSON.stringify(record.fields)}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </Page>
  );
}
