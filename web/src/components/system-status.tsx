import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Activity, CircuitBoard, Cpu, MemoryStick, Play, RefreshCw, Square } from 'lucide-react';
import { Badge, Button, Spinner, Tooltip } from '@/components/ui';
import { api, type BackendStatus, type ResourceSnapshot, type SystemStatus } from '@/lib/api';
import { backendState, cn, formatBytes } from '@/lib/utils';

/**
 * The header's live system readout: host utilisation meters, and one pill per
 * backend whose hover card carries its lifecycle controls — so "why is this
 * slow" and "stop the thing holding 8 GB" are both answerable without opening
 * Preferences.
 */

// --- Resource meters ----------------------------------------------------------

export function ResourceMeters({
  resources,
  collapsed,
}: {
  resources: ResourceSnapshot | undefined;
  /** The narrow nav rail: stack the meters and drop their icons. */
  collapsed?: boolean;
}) {
  if (!resources) return null;
  const { cpu, memory, gpu } = resources;

  const memoryFraction = memory.totalBytes ? memory.usedBytes / memory.totalBytes : 0;
  const gpuMemFraction =
    gpu?.memoryUsedBytes != null && gpu.memoryTotalBytes ? gpu.memoryUsedBytes / gpu.memoryTotalBytes : null;

  return (
    <div className={cn('grid gap-x-3 gap-y-2', collapsed ? 'grid-cols-1' : 'grid-cols-2')}>
      <Meter
        icon={collapsed ? null : <Cpu className="size-3" />}
        label="CPU"
        fraction={cpu.percent / 100}
        value={`${Math.round(cpu.percent)}%`}
        detail={`${cpu.percent.toFixed(1)}% across ${cpu.cores} cores`}
      />
      <Meter
        icon={collapsed ? null : <MemoryStick className="size-3" />}
        label="RAM"
        fraction={memoryFraction}
        value={`${gb(memory.usedBytes)}/${formatGb(memory.totalBytes)}`}
        detail={`${formatBytes(memory.usedBytes)} of ${formatBytes(memory.totalBytes)} in use`}
      />
      {gpu ? (
        <>
          <Meter
            icon={collapsed ? null : <CircuitBoard className="size-3" />}
            label="GPU"
            fraction={gpu.percent != null ? gpu.percent / 100 : null}
            value={gpu.percent != null ? `${Math.round(gpu.percent)}%` : '—'}
            detail={`${gpu.name}${gpu.count > 1 ? ` ×${gpu.count}` : ''} · ${
              gpu.percent != null ? `${gpu.percent}% busy` : 'utilisation not reported'
            }`}
          />
          <Meter
            icon={collapsed ? null : <MemoryStick className="size-3" />}
            label="VRAM"
            fraction={gpuMemFraction}
            value={
              gpu.memoryUsedBytes == null
                ? '—'
                : gpu.unified
                  ? formatGb(gpu.memoryUsedBytes)
                  : `${gb(gpu.memoryUsedBytes)}/${formatGb(gpu.memoryTotalBytes ?? 0)}`
            }
            detail={
              gpu.unified
                ? `${formatBytes(gpu.memoryUsedBytes)} of unified memory in use by the GPU (shared with RAM)`
                : `${formatBytes(gpu.memoryUsedBytes)} of ${formatBytes(gpu.memoryTotalBytes)} GPU memory in use`
            }
          />
        </>
      ) : null}
    </div>
  );
}

function Meter({
  icon,
  label,
  fraction,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  fraction: number | null;
  value: string;
  detail: string;
}) {
  const tone =
    fraction == null
      ? 'bg-muted-foreground/40'
      : fraction >= 0.9
        ? 'bg-destructive'
        : fraction >= 0.75
          ? 'bg-[var(--warning)]'
          : 'bg-primary';
  return (
    <Tooltip label={detail}>
      <div className="flex min-w-0 cursor-default flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-x-1 gap-y-0.5 whitespace-nowrap text-[10px] leading-none">
          <span className="flex items-center gap-1 font-medium text-muted-foreground">
            {icon}
            {label}
          </span>
          <span className="tabular-nums text-foreground">{value}</span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={cn('h-full rounded-full transition-[width] duration-500', tone)}
            style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction ?? 0)) * 100)}%` }}
          />
        </div>
      </div>
    </Tooltip>
  );
}

/** "9.3", "15" — the unit is carried by the total that follows it. */
function gb(bytes: number): string {
  const value = bytes / 1024 ** 3;
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

function formatGb(bytes: number): string {
  return `${gb(bytes)}G`;
}

// --- Backend pills ------------------------------------------------------------

export function BackendPills({
  status,
  onChanged,
}: {
  status: SystemStatus | undefined;
  onChanged: () => void;
}) {
  if (!status) return null;
  return (
    <div className="hidden items-center gap-1.5 md:flex">
      {status.backends
        .filter((backend) => backend.kind === 'server' || backend.installed)
        .map((backend) => (
          <BackendPill key={backend.backend} backend={backend} onChanged={onChanged} />
        ))}
    </div>
  );
}

type Action = 'start' | 'stop' | 'restart';

/**
 * A pill that opens its card on hover (and on click, for touch). Radix has no
 * hover card installed here, so the popover is opened and closed by pointer
 * events with a short grace period, long enough to move from the pill onto
 * the card's buttons without it closing underneath the pointer.
 */
function BackendPill({ backend, onChanged }: { backend: BackendStatus; onChanged: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState<Action | null>(null);
  const [error, setError] = React.useState<string>();
  const closeTimer = React.useRef<number | undefined>(undefined);
  const state = backendState(backend);

  const show = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 200);
  };
  React.useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const act = async (action: Action) => {
    setPending(action);
    setError(undefined);
    try {
      await api.post(`/v1/backends/${backend.backend}/${action}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
      onChanged();
    }
  };

  const running = backend.status === 'ready' || backend.status === 'starting' || backend.status === 'unhealthy';

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          onPointerEnter={(e) => e.pointerType === 'mouse' && show()}
          onPointerLeave={(e) => e.pointerType === 'mouse' && hide()}
          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${backend.label}: ${state.label}`}
        >
          <Badge variant={state.variant} className="cursor-pointer">
            {pending || backend.status === 'starting' ? (
              <Spinner className="size-2.5" />
            ) : (
              <Activity className="size-2.5" />
            )}
            {backend.backend}
          </Badge>
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          sideOffset={6}
          align="start"
          onPointerEnter={show}
          onPointerLeave={hide}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-50 w-72 rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{backend.label}</span>
            <Badge variant={state.variant}>{state.state}</Badge>
          </div>

          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
            {backend.kind === 'cli' ? (
              <Row label="Runs">per generation — nothing to start or stop</Row>
            ) : null}
            {backend.pid ? <Row label="PID">{backend.pid}</Row> : null}
            {backend.stats && backend.status === 'ready' ? (
              <Row label="Memory">
                {formatBytes(backend.stats.rssKb * 1024)} resident
                {backend.stats.swapKb ? ` · ${formatBytes(backend.stats.swapKb * 1024)} swapped` : ''}
              </Row>
            ) : null}
            {backend.kind === 'server' ? <Row label="Idle stop"><IdleLine backend={backend} /></Row> : null}
            {backend.releaseTag ? <Row label="Release">{backend.releaseTag}</Row> : null}
            {backend.restarts > 0 ? <Row label="Restarts">{backend.restarts}</Row> : null}
            {backend.lastRestartReason ? <Row label="Last restart">{backend.lastRestartReason}</Row> : null}
            {backend.lastStopReason && backend.status === 'stopped' ? (
              <Row label="Stopped">{backend.lastStopReason}</Row>
            ) : null}
          </dl>

          {backend.note && backend.status !== 'ready' ? (
            <p className="mt-2 rounded-md bg-muted px-2 py-1.5 text-muted-foreground">{backend.note}</p>
          ) : null}
          {error ?? backend.lastError ? (
            <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-destructive">
              {error ?? backend.lastError}
            </p>
          ) : null}

          {backend.kind === 'server' ? (
            <div className="mt-3 flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                disabled={pending !== null || running || !backend.installed}
                onClick={() => void act('start')}
              >
                {pending === 'start' ? <Spinner /> : <Play />}
                Start
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                disabled={pending !== null || !running}
                onClick={() => void act('stop')}
              >
                {pending === 'stop' ? <Spinner /> : <Square />}
                Stop
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                disabled={pending !== null || !backend.installed}
                onClick={() => void act('restart')}
              >
                {pending === 'restart' ? <Spinner /> : <RefreshCw />}
                Restart
              </Button>
            </div>
          ) : null}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground/70">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </>
  );
}

/** A live countdown, ticking between the five-second status polls. */
function IdleLine({ backend }: { backend: BackendStatus }) {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    if (!backend.idleStopAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [backend.idleStopAt]);

  if (backend.idleTimeoutMs === 0) return <>off — stays running until stopped</>;
  if (backend.status !== 'ready') return <>after {formatMinutes(backend.idleTimeoutMs)} unused</>;
  if (backend.inFlight > 0) {
    return <>busy — {backend.inFlight} request{backend.inFlight === 1 ? '' : 's'} in flight</>;
  }
  if (!backend.idleStopAt) return <>—</>;
  const remaining = Math.max(0, Date.parse(backend.idleStopAt) - now);
  const m = Math.floor(remaining / 60_000);
  const s = Math.floor((remaining % 60_000) / 1000);
  return (
    <span className="tabular-nums">
      in {m}:{String(s).padStart(2, '0')} if unused
    </span>
  );
}

export function formatMinutes(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes >= 1) return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
  return `${Math.round(ms / 1000)}s`;
}
