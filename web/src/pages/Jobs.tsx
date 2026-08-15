import * as React from 'react';
import { Ban, ChevronDown, ListChecks, RefreshCw, Trash2 } from 'lucide-react';
import { api, useEventStream, useResource, type Job } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Progress,
  Tooltip,
} from '@/components/ui';
import { Page } from '@/components/layout';
import { cn, formatDuration, timeAgo } from '@/lib/utils';

const STATUS_VARIANT = {
  queued: 'outline',
  running: 'primary',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'warning',
} as const;

const FILTERS = ['all', 'queued', 'running', 'completed', 'failed', 'cancelled'] as const;

/**
 * The Job viewer (requirement 10: "Display the type (image/text/audio/video),
 * payload, timestamp, progress, actions (abort/retry/delete)").
 *
 * The list is fetched once and then kept current from the job event stream, so
 * a progress bar moves at the rate the backend reports steps rather than at
 * whatever interval a poll would have picked.
 */
export function JobsPage() {
  const initial = useResource<{ jobs: Job[] }>('/v1/jobs?limit=200');
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]>('all');
  const [expanded, setExpanded] = React.useState<string>();

  React.useEffect(() => {
    if (initial.data) setJobs(initial.data.jobs);
  }, [initial.data]);

  useEventStream(
    '/v1/jobs/stream',
    (event, data) => {
      if (event === 'removed') {
        const { id } = data as { id: string };
        setJobs((current) => current.filter((job) => job.id !== id));
        return;
      }
      const job = data as Job;
      if (!job?.id) return;
      setJobs((current) =>
        current.some((existing) => existing.id === job.id)
          ? current.map((existing) => (existing.id === job.id ? job : existing))
          : [job, ...current],
      );
    },
    ['created', 'updated', 'progress', 'completed', 'failed', 'removed'],
  );

  const visible = jobs.filter((job) => filter === 'all' || job.status === filter);

  const counts = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const job of jobs) map.set(job.status, (map.get(job.status) ?? 0) + 1);
    return map;
  }, [jobs]);

  return (
    <Page
      title="Jobs"
      description="Every generation queued on this server, with its payload and progress."
      actions={
        <Button variant="ghost" size="sm" onClick={initial.reload}>
          <RefreshCw /> Refresh
        </Button>
      }
    >
      <div className="flex flex-wrap gap-1">
        {FILTERS.map((option) => (
          <Button
            key={option}
            variant={filter === option ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setFilter(option)}
            className="capitalize"
          >
            {option}
            {option !== 'all' && counts.get(option) ? (
              <Badge variant="outline">{counts.get(option)}</Badge>
            ) : null}
          </Button>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title={filter === 'all' ? 'No jobs yet' : `No ${filter} jobs`}
          description="Generations queued from any screen appear here."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              expanded={expanded === job.id}
              onToggle={() => setExpanded((current) => (current === job.id ? undefined : job.id))}
            />
          ))}
        </div>
      )}
    </Page>
  );
}

function JobRow({
  job,
  expanded,
  onToggle,
}: {
  job: Job;
  expanded: boolean;
  onToggle: () => void;
}) {
  const active = job.status === 'queued' || job.status === 'running';
  const prompt = String(job.params.prompt ?? job.params.input ?? '');
  const duration = (job.result?.metadata as { duration_ms?: number } | undefined)?.duration_ms;
  const resultUrl = (job.result?.image_url ?? job.result?.video_url) as string | undefined;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-3">
        <button
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={expanded}
        >
          <ChevronDown
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')}
          />
          <Badge variant={STATUS_VARIANT[job.status]}>{job.status}</Badge>
          <Badge variant="outline" className="capitalize">
            {job.kind}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-sm">
            {prompt || <span className="text-muted-foreground">{job.id}</span>}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-2">
          {duration ? (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {formatDuration(duration)}
            </span>
          ) : null}
          {job.attempts > 0 ? <Badge variant="outline">retry {job.attempts}</Badge> : null}
          <Tooltip label={new Date(job.createdAt).toLocaleString()}>
            <span className="text-[11px] text-muted-foreground">{timeAgo(job.createdAt)}</span>
          </Tooltip>

          {active ? (
            <Tooltip label="Abort">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void api.post(`/v1/jobs/${job.id}/cancel`)}
                aria-label="Abort"
              >
                <Ban />
              </Button>
            </Tooltip>
          ) : (
            <Tooltip label="Retry with the same parameters">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void api.post(`/v1/jobs/${job.id}/retry`)}
                aria-label="Retry"
              >
                <RefreshCw />
              </Button>
            </Tooltip>
          )}
          <Tooltip label="Delete">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void api.delete(`/v1/jobs/${job.id}`)}
              aria-label="Delete"
            >
              <Trash2 />
            </Button>
          </Tooltip>
        </div>
      </div>

      {active ? (
        <div className="flex items-center gap-3 px-3 pb-3">
          <Progress value={job.progress} indeterminate={job.status === 'queued'} className="flex-1" />
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {job.totalSteps ? `${job.step ?? 0}/${job.totalSteps}` : `${Math.round(job.progress * 100)}%`}
          </span>
        </div>
      ) : null}

      {job.error ? (
        <p className="border-t border-border bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <strong>{job.error.code}</strong> — {job.error.message}
        </p>
      ) : null}

      {expanded ? (
        <div className="grid gap-3 border-t border-border bg-muted/40 p-3 lg:grid-cols-[1fr_auto]">
          <div className="min-w-0">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Payload
            </p>
            <pre className="overflow-x-auto rounded-md bg-background p-2 text-[11px] leading-relaxed scrollbar-thin">
              {JSON.stringify(job.params, null, 2)}
            </pre>
          </div>
          {resultUrl ? (
            <div className="flex w-full justify-center lg:w-56">
              {job.kind === 'video' ? (
                <video src={resultUrl} controls className="max-h-48 rounded-md" preload="metadata" />
              ) : (
                <img src={resultUrl} alt="" className="max-h-48 rounded-md object-contain" />
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
