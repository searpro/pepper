import * as React from 'react';
import { Check, ChevronLeft, ChevronRight, Clock, Copy, Download, ExternalLink, Maximize2, Music, Play, Trash2 } from 'lucide-react';
import { useResource, type Generation, type Job, type MediaItem } from '../lib/api';
import { cn, formatBytes, formatDuration, timeAgo } from '../lib/utils';
import { Badge, Button, Card, Dialog, DialogContent } from './ui';

/**
 * How a generated file is shown anywhere in the app: a tile that opens a
 * viewer, both saying how long the file took to make and from what. Screens
 * differ in what they list (a library, a run's results, a shot's takes), not
 * in how one file behaves.
 */

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const record = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** A job's `Generation`, the same as the server's `describeGeneration` (core `jobs/generation.ts`). */
export function generationOf(job: Job): Generation {
  const metadata = record(job.result?.metadata);
  const values = job.params.recipe ? record(job.params.params) : job.params;
  const created = Date.parse(job.createdAt);
  const started = job.startedAt ? Date.parse(job.startedAt) : undefined;
  const finished = job.finishedAt ? Date.parse(job.finishedAt) : undefined;
  return {
    job_id: job.id,
    source: str(job.params.recipe) ?? str(metadata.recipe) ?? str(metadata.model) ?? str(job.params.model),
    mode: str(job.params.mode) ?? str(metadata.mode),
    task: str(metadata.task) ?? str(job.params.task),
    prompt: str(metadata.prompt) ?? str(values.prompt) ?? str(values.input),
    negative_prompt: str(metadata.negative_prompt) ?? str(values.negative_prompt),
    seed: num(metadata.seed) ?? num(values.seed),
    width: num(metadata.width) ?? num(values.width),
    height: num(metadata.height) ?? num(values.height),
    loras: lorasOf(metadata, job.params),
    duration_ms: started !== undefined && finished !== undefined ? finished - started : num(metadata.duration_ms),
    wait_ms: started !== undefined ? Math.max(0, started - created) : undefined,
    created_at: job.createdAt,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
  };
}

/** LoRAs as a job's metadata records them, else as it asked for them (ids only, before it ran). */
function lorasOf(metadata: Record<string, unknown>, params: Record<string, unknown>): Generation['loras'] {
  const list = Array.isArray(metadata.loras) ? metadata.loras : Array.isArray(params.loras) ? params.loras : [];
  const loras = list.flatMap((item) => {
    const entry = record(item);
    const name = str(entry.name) ?? str(entry.id);
    return name ? [{ id: str(entry.id), name, strength: num(entry.strength) ?? 1 }] : [];
  });
  return loras.length ? loras : undefined;
}

/** The files a finished job wrote, as media items carrying how they were made. */
export function jobMedia(job: Job): MediaItem[] {
  const result = record(job.result);
  const generation = generationOf(job);
  const files: { url: string; kind: MediaItem['kind'] }[] = Array.isArray(result.outputs)
    ? result.outputs.map(record).flatMap((o) => (typeof o.url === 'string' ? [{ url: o.url, kind: (o.kind as MediaItem['kind']) ?? 'other' }] : []))
    : [];
  if (!files.length) {
    for (const kind of ['video', 'image', 'audio'] as const) {
      const url = result[`${kind}_url`];
      if (typeof url === 'string') files.push({ url, kind });
    }
  }
  return files.map(({ url, kind }) => ({
    name: decodeURIComponent(url.split('/').pop() ?? url),
    kind,
    // Not known from the job; the viewer reads it from the file's info.
    size: 0,
    modified: job.finishedAt ?? job.createdAt,
    url,
    generation,
  }));
}

/** The current time, updated every second while `active`: a clock that counts up. */
export function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * How long a file took to make; while its job is still going, how long so
 * far (counting up), and while it waits, how long it has been queued.
 */
export function GenerationTime({
  generation,
  status,
  className,
}: {
  generation?: Generation;
  status?: Job['status'] | 'missing';
  className?: string;
}) {
  const running = status === 'running' && generation?.started_at;
  const queued = status === 'queued' && generation;
  const now = useNow(Boolean(running || queued));
  const ms = running
    ? now - Date.parse(generation.started_at!)
    : queued
      ? now - Date.parse(generation.created_at)
      : generation?.duration_ms;
  if (ms === undefined) return null;
  const title = running ? 'Generating for' : queued ? 'Queued for' : `Took ${formatDuration(ms)} to generate${generation?.wait_ms ? ` after ${formatDuration(generation.wait_ms)} in the queue` : ''}`;
  return (
    <span className={cn('inline-flex items-center gap-1 tabular-nums', className)} title={title}>
      <Clock className="size-3" />
      {queued ? 'queued ' : ''}
      {formatDuration(ms)}
    </span>
  );
}

/** "0:05", "1:02:10": a clip's length. */
function clipLength(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * A file's preview at any shape: the whole frame, letterboxed in a square,
 * so a 9:16 take shows in full beside a 16:9 one instead of a crop of its
 * middle. An image sits over a blurred copy of itself, which fills the bars
 * without fetching anything more; a video's bars are black.
 */
export function MediaPreview({
  url,
  kind,
  className,
  onLength,
}: {
  url: string;
  kind: MediaItem['kind'];
  className?: string;
  /** A video's length in seconds, once its metadata has loaded. */
  onLength?: (seconds: number) => void;
}) {
  return (
    <div
      className={cn(
        'relative flex aspect-square w-full items-center justify-center overflow-hidden',
        kind === 'video' ? 'bg-black' : 'bg-muted',
        className,
      )}
    >
      {kind === 'image' ? (
        <>
          <img src={url} alt="" aria-hidden loading="lazy" className="absolute inset-0 size-full scale-110 object-cover opacity-50 blur-xl" />
          <img src={url} alt="" loading="lazy" className="relative size-full object-contain" />
        </>
      ) : null}
      {kind === 'video' ? (
        <>
          {/* The first frame as a poster; it plays, with sound, in the viewer. */}
          <video
            src={`${url}#t=0.1`}
            muted
            preload="metadata"
            onLoadedMetadata={(event) => {
              const { duration } = event.currentTarget;
              if (Number.isFinite(duration)) onLength?.(duration);
            }}
            className="size-full object-contain"
          />
          <Play className="absolute left-1/2 top-1/2 size-9 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/55 p-2 text-white" />
        </>
      ) : null}
      {kind === 'audio' || kind === 'other' ? <Music className="size-8 text-muted-foreground" /> : null}
    </div>
  );
}

/**
 * One generated file: a preview that opens the viewer, with how long it took
 * on the preview and what made it underneath. `onToggle` adds a checkbox for
 * bulk selection; `onView` a full-size button, for a tile whose click picks
 * it rather than opening it; `children` adds a screen's own controls below.
 */
export function MediaTile({
  item,
  generation = item.generation,
  selected,
  onToggle,
  onOpen,
  onView,
  className,
  children,
}: {
  item: MediaItem;
  generation?: Generation;
  selected?: boolean;
  onToggle?: () => void;
  onOpen: () => void;
  onView?: () => void;
  className?: string;
  children?: React.ReactNode;
}) {
  const [length, setLength] = React.useState<number>();
  const onMetadata = (event: React.SyntheticEvent<HTMLMediaElement>) => {
    const { duration } = event.currentTarget;
    if (Number.isFinite(duration)) setLength(duration);
  };
  const made = [generation?.source, generation?.mode, generation?.task].filter(Boolean).join(' · ');
  return (
    <Card className={cn('group relative flex flex-col gap-2 overflow-hidden p-2', selected && 'ring-2 ring-primary', className)}>
      {onToggle ? (
        <input
          type="checkbox"
          aria-label={`Select ${item.name}`}
          className="absolute left-3 top-3 z-10 size-4 accent-[var(--primary)] opacity-70 transition-opacity group-hover:opacity-100 checked:opacity-100"
          checked={Boolean(selected)}
          onChange={onToggle}
        />
      ) : null}
      <button type="button" onClick={onOpen} className="relative block overflow-hidden rounded-md text-left" aria-label={`Open ${item.name}`}>
        <MediaPreview url={item.url} kind={item.kind} onLength={setLength} />
        {length !== undefined ? (
          <span className="absolute bottom-1.5 left-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white">{clipLength(length)}</span>
        ) : null}
        {generation?.duration_ms !== undefined ? (
          <GenerationTime generation={generation} className="absolute bottom-1.5 right-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white" />
        ) : null}
      </button>
      {onView ? (
        <Button
          type="button"
          size="icon-sm"
          variant="secondary"
          aria-label={`View ${item.name} full size`}
          title="View full size, with its details"
          className="absolute right-3 top-3 z-10 opacity-80 hover:opacity-100"
          onClick={onView}
        >
          <Maximize2 />
        </Button>
      ) : null}
      {item.kind === 'audio' ? <audio src={item.url} controls preload="metadata" onLoadedMetadata={onMetadata} className="h-8 w-full" /> : null}
      {generation?.prompt ? (
        <p className="line-clamp-2 text-xs leading-snug" title={generation.prompt}>
          {generation.prompt}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className={cn('truncate', !made && 'font-mono')} title={item.name}>
          {made || item.name}
        </span>
        <span className="shrink-0">
          {[item.size ? formatBytes(item.size) : undefined, item.modified ? timeAgo(item.modified) : undefined].filter(Boolean).join(' · ')}
        </span>
      </div>
      {children}
    </Card>
  );
}

/** GET /v1/outputs/:name/info. */
interface OutputInfo {
  name: string;
  size: number;
  job: { id: string; params: Record<string, unknown>; metadata: Record<string, unknown> | null } | null;
  generation: Generation | null;
}

/**
 * A file at full size, how it was made and how long that took, with the
 * files around it a key press away. An output's job is looked up on the
 * server; a file kept elsewhere (a project's take) passes its `generation`,
 * and an upload linked from an output names that output in `infoFor`.
 * `actions` adds a screen's own buttons beside download and delete, and
 * `children` a panel under them.
 */
export function MediaViewer({
  item,
  generation: given,
  infoFor,
  position,
  onPrev,
  onNext,
  onClose,
  onDelete,
  actions,
  children,
}: {
  item: MediaItem | undefined;
  generation?: Generation;
  infoFor?: string;
  position?: string;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
  onDelete?: (item: MediaItem) => void;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const lookup = item ? (infoFor ?? (item.url.startsWith('/v1/outputs/') ? item.name : undefined)) : undefined;
  const isOutput = lookup !== undefined;
  const info = useResource<OutputInfo>(lookup ? `/v1/outputs/${encodeURIComponent(lookup)}/info` : null);
  // The resource keeps the previous file's answer while the next one loads.
  const current = lookup && info.data?.name === lookup ? info.data : undefined;
  const generation = given ?? item?.generation ?? current?.generation ?? undefined;
  const [natural, setNatural] = React.useState<{ width?: number; height?: number; length?: number }>({});
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    setNatural({});
    setCopied(false);
  }, [item?.url]);

  React.useEffect(() => {
    if (!item) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === 'ArrowLeft' && onPrev) onPrev();
      if (event.key === 'ArrowRight' && onNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, onPrev, onNext]);

  const onMetadata = (event: React.SyntheticEvent<HTMLVideoElement | HTMLAudioElement>) => {
    const el = event.currentTarget;
    setNatural({
      width: el instanceof HTMLVideoElement ? el.videoWidth : undefined,
      height: el instanceof HTMLVideoElement ? el.videoHeight : undefined,
      length: Number.isFinite(el.duration) ? el.duration : undefined,
    });
  };

  const width = natural.width || generation?.width;
  const height = natural.height || generation?.height;
  // An output's info is the output's size; an upload linked from one is the same bytes.
  const size = item?.size || current?.size;
  const rows: [string, React.ReactNode][] = [];
  if (generation?.duration_ms !== undefined) {
    rows.push(['Generation time', <span className="font-semibold text-foreground">{formatDuration(generation.duration_ms)}</span>]);
  }
  // Under a second is just the queue picking it up, not waiting.
  if (generation?.wait_ms && generation.wait_ms >= 1000) rows.push(['Queued first', formatDuration(generation.wait_ms)]);
  if (generation?.source) rows.push(['Made with', generation.source]);
  if (generation?.mode) rows.push(['Mode', generation.mode]);
  if (generation?.loras?.length) {
    rows.push(['LoRAs', generation.loras.map((lora) => (lora.strength === 1 ? lora.name : `${lora.name} × ${lora.strength}`)).join(', ')]);
  }
  if (generation?.task) rows.push(['Task', generation.task]);
  if (generation?.seed !== undefined) rows.push(['Seed', <span className="font-mono">{generation.seed}</span>]);
  if (width && height) rows.push(['Resolution', `${width}×${height}`]);
  if (natural.length !== undefined) rows.push(['Length', `${natural.length.toFixed(1)} s`]);
  if (size) rows.push(['File size', formatBytes(size)]);
  const finished = generation?.finished_at ?? item?.modified;
  if (finished) rows.push(['Finished', new Date(finished).toLocaleString()]);

  const copyPrompt = () => {
    if (!generation?.prompt) return;
    void navigator.clipboard?.writeText(generation.prompt).then(() => setCopied(true));
  };

  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => !open && onClose()}>
      {item ? (
        <DialogContent
          title={item.name}
          description={[position, generation?.duration_ms !== undefined ? `made in ${formatDuration(generation.duration_ms)}` : undefined, item.modified ? timeAgo(item.modified) : undefined]
            .filter(Boolean)
            .join(' · ')}
          className="[--dialog-w:96rem]"
        >
          {/* The file beside its details on a wide screen, so a tall video and how it was made fit on one screen. */}
          <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="relative flex min-h-48 items-center justify-center rounded-lg bg-black/90">
              {item.kind === 'image' ? (
                <img
                  src={item.url}
                  alt={item.name}
                  onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
                  className="max-h-[50vh] lg:max-h-[74vh] w-auto max-w-full object-contain"
                />
              ) : null}
              {item.kind === 'video' ? (
                <video key={item.url} src={item.url} controls autoPlay onLoadedMetadata={onMetadata} className="max-h-[50vh] lg:max-h-[74vh] w-auto max-w-full" />
              ) : null}
              {item.kind === 'audio' ? (
                <audio key={item.url} src={item.url} controls autoPlay onLoadedMetadata={onMetadata} className="m-10 w-full max-w-xl" />
              ) : null}
              {onPrev ? (
                <Button size="icon" variant="secondary" aria-label="Previous" className="absolute left-3 top-1/2 -translate-y-1/2 opacity-80" onClick={onPrev}>
                  <ChevronLeft />
                </Button>
              ) : null}
              {onNext ? (
                <Button size="icon" variant="secondary" aria-label="Next" className="absolute right-3 top-1/2 -translate-y-1/2 opacity-80" onClick={onNext}>
                  <ChevronRight />
                </Button>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-col gap-4 text-xs">
              {rows.length ? (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                  {rows.map(([label, value]) => (
                    <React.Fragment key={label}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="truncate text-right">{value}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              ) : null}
              {generation?.prompt ? (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Prompt</span>
                    <Button size="sm" variant="ghost" onClick={copyPrompt}>
                      {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                  <p className="whitespace-pre-wrap leading-relaxed">{generation.prompt}</p>
                </div>
              ) : null}
              {generation?.negative_prompt ? (
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Negative prompt</span>
                  <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">{generation.negative_prompt}</p>
                </div>
              ) : null}
              {!generation && isOutput && !info.loading ? (
                <p className="text-muted-foreground">No record of how this was made: its job has been removed, or it was not generated here.</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {actions}
                <Button size="sm" variant="outline" asChild>
                  <a href={item.url} target="_blank" rel="noreferrer">
                    <ExternalLink /> Open original
                  </a>
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <a href={item.url} download={item.name}>
                    <Download /> Download
                  </a>
                </Button>
                {onDelete ? (
                  <Button size="sm" variant="destructive" onClick={() => onDelete(item)}>
                    <Trash2 /> Delete
                  </Button>
                ) : null}
              </div>
              {current?.job ? (
                <details>
                  <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">All parameters</summary>
                  <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted p-2 text-[11px] leading-relaxed scrollbar-thin">
                    {JSON.stringify({ params: current.job.params, metadata: current.job.metadata }, null, 2)}
                  </pre>
                </details>
              ) : null}
            </div>
            {children ? <div className="lg:col-span-2">{children}</div> : null}
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** A badge for a job's state, the same everywhere a running file is shown. */
export function StatusBadge({ status }: { status: Job['status'] | 'missing' }) {
  const variant = status === 'failed' ? 'destructive' : status === 'completed' ? 'success' : status === 'running' ? 'primary' : status === 'cancelled' ? 'warning' : 'outline';
  return <Badge variant={variant}>{status}</Badge>;
}
