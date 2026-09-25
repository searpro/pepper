import * as React from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ImagePlus,
  Maximize2,
  Trash2,
  Wand2,
  Layers,
  RotateCcw,
  Film,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, useEventStream, useResource, type Job, type MediaItem } from '@/lib/api';
import {
  copyText,
  formatSettings,
  outputToInput,
  setVideoHandoff,
  settingsOf,
  upscale,
  type ImageSettings,
  type OutputInfo,
  type UpscalerInfo,
} from '@/lib/images';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  ErrorNote,
  Progress,
  Select,
  Spinner,
} from '@/components/ui';
import { formatBytes, formatDuration, timeAgo } from '@/lib/utils';

export interface ImageActions {
  /** Load the image's prompt and settings into the generator. */
  onReuse?: (settings: ImageSettings) => void;
  /** Use the image as the img2img start image. */
  onUseAsInit?: (name: string) => void;
  /** Add the image to the edit references. */
  onUseAsReference?: (name: string) => void;
  onDelete?: (name: string) => Promise<void> | void;
}

/**
 * The popup behind every generated image: a large view, how it was made, and
 * what can be done with it next — reuse its settings, copy them, upscale it,
 * or feed it back in as an init or reference image.
 *
 * `items` is the list the image was opened from, so the arrows (and ← →) step
 * through it without closing the popup.
 */
export function ImageDetailsDialog({
  item,
  items,
  onItemChange,
  onOpenChange,
  ...actions
}: {
  item: MediaItem | null;
  items?: MediaItem[];
  onItemChange: (item: MediaItem) => void;
  onOpenChange: (open: boolean) => void;
} & ImageActions) {
  const index = item && items ? items.findIndex((other) => other.name === item.name) : -1;
  const prev = index > 0 ? items![index - 1] : undefined;
  const next = index >= 0 && index < (items?.length ?? 0) - 1 ? items![index + 1] : undefined;

  React.useEffect(() => {
    if (!item) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea')) return;
      if (event.key === 'ArrowLeft' && prev) onItemChange(prev);
      if (event.key === 'ArrowRight' && next) onItemChange(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, prev, next, onItemChange]);

  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      {item ? (
        <DialogContent
          title={item.name}
          description={`${formatBytes(item.size)} · ${timeAgo(item.modified)}`}
          className="[--dialog-w:84rem] h-[88vh]"
        >
          <ImageDetailsBody
            key={item.name}
            item={item}
            prev={prev}
            next={next}
            onItemChange={onItemChange}
            onClose={() => onOpenChange(false)}
            {...actions}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function ImageDetailsBody({
  item,
  prev,
  next,
  onItemChange,
  onClose,
  onReuse,
  onUseAsInit,
  onUseAsReference,
  onDelete,
}: {
  item: MediaItem;
  prev?: MediaItem;
  next?: MediaItem;
  onItemChange: (item: MediaItem) => void;
  onClose: () => void;
} & ImageActions) {
  const info = useResource<OutputInfo>(`/v1/outputs/${encodeURIComponent(item.name)}/info`);
  const upscalers = useResource<UpscalerInfo>('/v1/upscalers');
  const settings = settingsOf(info.data);
  const [natural, setNatural] = React.useState<[number, number]>();
  const [copied, setCopied] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  const [upscaleJob, setUpscaleJob] = React.useState<Job>();
  const [busy, setBusy] = React.useState<string>();
  const [upscaler, setUpscaler] = React.useState<string>('');
  const navigate = useNavigate();

  const flash = (what: string) => {
    setCopied(what);
    setTimeout(() => setCopied((current) => (current === what ? undefined : current)), 1600);
  };

  // Follow the upscale this popup started, so its progress and result show
  // here rather than only on the job list.
  useEventStream(
    upscaleJob && (upscaleJob.status === 'queued' || upscaleJob.status === 'running')
      ? '/v1/jobs/stream'
      : null,
    (_event, data) => {
      const job = data as Job;
      if (job?.id === upscaleJob?.id) setUpscaleJob(job);
    },
    ['updated', 'progress', 'completed', 'failed'],
  );

  const startUpscale = async (scale: 2 | 4) => {
    setError(undefined);
    try {
      setUpscaleJob(await upscale(item.name, scale, 'output', upscaler || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const run = async (label: string, action: () => Promise<void> | void) => {
    setError(undefined);
    setBusy(label);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  };

  const upscaledName = upscaleJob?.result?.image_url
    ? decodeURIComponent(String(upscaleJob.result.image_url).split('/').pop()!)
    : undefined;
  const scales = upscalers.data?.scales ?? [];
  const isUpscale = settings?.task === 'upscale';

  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-1">
      {/* Image */}
      <div className="checkerboard relative min-h-[40vh] overflow-hidden">
        {/* Absolutely positioned so object-contain has a definite box to fit
            into; a percentage max-height inside the grid row has none. */}
        <a href={item.url} target="_blank" rel="noreferrer" title="Open full size">
          <img
            src={item.url}
            alt={settings?.prompt ?? item.name}
            onLoad={(event) =>
              setNatural([event.currentTarget.naturalWidth, event.currentTarget.naturalHeight])
            }
            className="absolute inset-3 size-[calc(100%-1.5rem)] object-contain"
          />
        </a>
        {prev ? (
          <NavButton side="left" label="Previous image" onClick={() => onItemChange(prev)} />
        ) : null}
        {next ? (
          <NavButton side="right" label="Next image" onClick={() => onItemChange(next)} />
        ) : null}
      </div>

      {/* Details + actions */}
      <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-t border-border p-4 lg:border-l lg:border-t-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {natural ? (
            <Badge variant="outline">
              {natural[0]}×{natural[1]}
            </Badge>
          ) : null}
          {isUpscale ? (
            <Badge variant="primary">
              <Maximize2 className="size-2.5" /> Upscaled {settings?.scale}×
            </Badge>
          ) : null}
          {settings?.model ? <Badge variant="outline">{settings.model}</Badge> : null}
          {settings?.duration_ms ? (
            <Badge variant="outline">{formatDuration(settings.duration_ms)}</Badge>
          ) : null}
        </div>

        {info.loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3" /> Loading details…
          </div>
        ) : settings ? (
          <>
            {settings.prompt ? (
              <section className="flex flex-col gap-1.5">
                <SectionTitle>Prompt</SectionTitle>
                <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2.5 text-[13px] leading-relaxed">
                  {settings.prompt}
                </p>
                {settings.negative_prompt ? (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium">Negative:</span> {settings.negative_prompt}
                  </p>
                ) : null}
              </section>
            ) : null}

            <section className="flex flex-col gap-1.5">
              <SectionTitle>Settings</SectionTitle>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <Row
                  label="Size"
                  value={
                    settings.width && settings.height
                      ? `${settings.width}×${settings.height}`
                      : undefined
                  }
                />
                <Row label="Steps" value={settings.steps} />
                <Row label="CFG scale" value={settings.cfg_scale} />
                <Row label="Sampler" value={settings.sampler} />
                <Row label="Seed" value={settings.seed} />
                <Row label="Strength" value={settings.init_image ? settings.strength : undefined} />
                <Row
                  label="References"
                  value={
                    settings.ref_images?.length
                      ? `${settings.ref_images.length} image(s)`
                      : undefined
                  }
                />
                <Row
                  label="Image CFG"
                  value={settings.ref_images?.length ? settings.img_cfg_scale : undefined}
                />
                {isUpscale ? (
                  <>
                    <Row label="Upscaler" value={settings.upscaler} />
                    <Row
                      label="From"
                      value={
                        settings.source_width
                          ? `${settings.source_width}×${settings.source_height}`
                          : undefined
                      }
                    />
                  </>
                ) : null}
              </dl>
            </section>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            No generation record for this image — its job was pruned, or the file was added by hand.
            It can still be upscaled or reused as an input.
          </p>
        )}

        {/* Reuse */}
        <section className="flex flex-col gap-2">
          <SectionTitle>Reuse</SectionTitle>
          {settings && onReuse ? (
            <Button
              size="sm"
              onClick={() => {
                onReuse(settings);
                onClose();
              }}
            >
              <RotateCcw /> Reuse prompt &amp; settings
            </Button>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!settings?.prompt}
              onClick={() => void copyText(settings?.prompt ?? '').then(() => flash('prompt'))}
            >
              {copied === 'prompt' ? <Check /> : <Copy />} Copy prompt
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!settings}
              onClick={() =>
                void copyText(settings ? formatSettings(settings) : '').then(() =>
                  flash('settings'),
                )
              }
            >
              {copied === 'settings' ? <Check /> : <Copy />} Copy settings
            </Button>
            {onUseAsInit ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== undefined}
                onClick={() =>
                  void run('init', async () => {
                    await onUseAsInit(item.name);
                    onClose();
                  })
                }
              >
                {busy === 'init' ? <Spinner className="size-3.5" /> : <ImagePlus />} Use as init
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== undefined}
              onClick={() =>
                void run('animate', async () => {
                  setVideoHandoff({ init: await outputToInput(item.name) });
                  onClose();
                  navigate('/video');
                })
              }
            >
              {busy === 'animate' ? <Spinner className="size-3.5" /> : <Film />} Animate
            </Button>
            {onUseAsReference ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== undefined}
                onClick={() =>
                  void run('ref', async () => {
                    await onUseAsReference(item.name);
                    onClose();
                  })
                }
              >
                {busy === 'ref' ? <Spinner className="size-3.5" /> : <Layers />} Edit this
              </Button>
            ) : null}
          </div>
        </section>

        {/* Upscale */}
        <section className="flex flex-col gap-2">
          <SectionTitle>Upscale</SectionTitle>
          {(upscalers.data?.models.length ?? 0) > 0 ? (
            <Select
              value={upscaler || '__default'}
              onValueChange={(value) => setUpscaler(value === '__default' ? '' : value)}
              options={[
                {
                  value: '__default',
                  label: 'Default for the scale',
                  description: `2× ${upscalers.data!.defaults[2] ?? '—'} · 4× ${upscalers.data!.defaults[4] ?? '—'}`,
                },
                ...upscalers.data!.models.map((model) => ({
                  value: model.name,
                  label: `${model.label} · ${model.scale}×`,
                  description: model.description ?? model.architecture,
                })),
              ]}
            />
          ) : null}
          {upscaleJob && upscaleJob.status !== 'completed' ? (
            <UpscaleProgress job={upscaleJob} />
          ) : null}
          {upscaledName ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                onItemChange({
                  name: upscaledName,
                  kind: 'image',
                  size: 0,
                  modified: new Date().toISOString(),
                  url: String(upscaleJob!.result!.image_url),
                })
              }
            >
              <Maximize2 /> View upscaled image
            </Button>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            {([2, 4] as const).map((scale) => (
              <Button
                key={scale}
                size="sm"
                variant="outline"
                disabled={
                  !scales.includes(scale) ||
                  upscaleJob?.status === 'queued' ||
                  upscaleJob?.status === 'running'
                }
                onClick={() => void startUpscale(scale)}
              >
                <Wand2 /> {scale}×
                {natural ? (
                  <span className="text-[10px] text-muted-foreground">
                    {natural[0] * scale}×{natural[1] * scale}
                  </span>
                ) : null}
              </Button>
            ))}
          </div>
          {upscalers.data && scales.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No upscaler models found in <code>{upscalers.data.dir}</code>.
            </p>
          ) : null}
        </section>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="mt-auto flex gap-2 border-t border-border pt-3">
          <Button asChild size="sm" variant="ghost" className="flex-1">
            <a href={item.url} download>
              <Download /> Download
            </a>
          </Button>
          {onDelete ? (
            <Button
              size="sm"
              variant="ghost"
              className="flex-1 text-destructive hover:bg-destructive/10"
              onClick={() =>
                void run('delete', async () => {
                  await onDelete(item.name);
                  if (next) onItemChange(next);
                  else if (prev) onItemChange(prev);
                  else onClose();
                })
              }
            >
              <Trash2 /> Delete
            </Button>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function UpscaleProgress({ job }: { job: Job }) {
  if (job.status === 'failed' || job.status === 'cancelled') {
    return <ErrorNote>{job.error?.message ?? `Upscale ${job.status}`}</ErrorNote>;
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5">
          <Spinner className="size-3" />
          {job.status === 'queued' ? 'Queued…' : 'Upscaling…'}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {job.totalSteps ? `tile ${job.step ?? 0}/${job.totalSteps}` : ''}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Progress value={job.progress} indeterminate={job.status === 'queued'} className="flex-1" />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Cancel upscale"
          onClick={() => void api.post(`/v1/jobs/${job.id}/cancel`)}
        >
          ×
        </Button>
      </div>
    </div>
  );
}

function NavButton({
  side,
  label,
  onClick,
}: {
  side: 'left' | 'right';
  label: string;
  onClick: () => void;
}) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`absolute top-1/2 -translate-y-1/2 ${side === 'left' ? 'left-3' : 'right-3'} rounded-full bg-black/55 p-2 text-white shadow-lg backdrop-blur transition hover:bg-black/75`}
    >
      <Icon className="size-5" />
    </button>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h4>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium tabular-nums">{value}</dd>
    </>
  );
}
