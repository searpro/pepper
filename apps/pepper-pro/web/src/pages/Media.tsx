import * as React from 'react';
import { ChevronLeft, ChevronRight, Download, ExternalLink, Library, Music, Play, Search, Trash2 } from 'lucide-react';
import { Page } from '@pepper/ui/components/layout';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorNote,
  Input,
  Select,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@pepper/ui/components/ui';
import { api, useResource, type MediaItem } from '@pepper/ui/lib/api';
import { cn, formatBytes, timeAgo } from '@pepper/ui/lib/utils';

type Tab = 'outputs' | 'uploads';
type Sort = 'newest' | 'oldest' | 'largest';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What made an output, read from its name: `<recipe>-<ISO time>-<hash>.<ext>`. */
function sourceOf(name: string): string {
  return name.replace(/-\d{4}-\d{2}-\d{2}T[\w-]+\.\w+$/, '');
}

/** GET /v1/outputs/:name/info: the job that wrote an output, when it is still on record. */
interface OutputInfo {
  job: { id: string; params: Record<string, unknown>; metadata: Record<string, unknown> | null } | null;
}

/**
 * Everything generated (outputs) and everything uploaded (inputs): filtered,
 * selected and deleted in bulk, and opened full size.
 */
export function MediaPage() {
  const [tab, setTab] = React.useState<Tab>('outputs');
  const [kind, setKind] = React.useState('all');
  const [source, setSource] = React.useState('all');
  const [search, setSearch] = React.useState('');
  const [sort, setSort] = React.useState<Sort>('newest');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [open, setOpen] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();

  const outputs = useResource<{ outputs: MediaItem[] }>('/v1/outputs?limit=1000', 20_000);
  const uploads = useResource<{ uploads: MediaItem[] }>('/v1/inputs', 20_000);
  const resource = tab === 'outputs' ? outputs : uploads;
  const all = (tab === 'outputs' ? outputs.data?.outputs : uploads.data?.uploads) ?? [];
  const sources = React.useMemo(() => [...new Set((outputs.data?.outputs ?? []).map((o) => sourceOf(o.name)))].sort(), [outputs.data]);

  const items = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    const shown = all.filter(
      (item) =>
        (kind === 'all' || item.kind === kind) &&
        (tab === 'uploads' || source === 'all' || sourceOf(item.name) === source) &&
        (!needle || item.name.toLowerCase().includes(needle)),
    );
    const order: Record<Sort, (a: MediaItem, b: MediaItem) => number> = {
      newest: (a, b) => b.modified.localeCompare(a.modified),
      oldest: (a, b) => a.modified.localeCompare(b.modified),
      largest: (a, b) => b.size - a.size,
    };
    return shown.sort(order[sort]);
  }, [all, kind, source, search, sort, tab]);

  // A selection only ever covers what is shown: changing a filter or tab drops the rest.
  React.useEffect(() => {
    const shown = new Set(items.map((i) => i.name));
    setSelected((current) => {
      const kept = [...current].filter((name) => shown.has(name));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [items]);

  const chosen = items.filter((i) => selected.has(i.name));
  const allSelected = items.length > 0 && chosen.length === items.length;
  const base = tab === 'outputs' ? '/v1/outputs' : '/v1/inputs';
  const toggle = (name: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const remove = async (names: string[]) => {
    setBusy(true);
    setError(undefined);
    const failed: string[] = [];
    // A few at a time: a selection can be hundreds of files.
    for (let i = 0; i < names.length; i += 8) {
      await Promise.all(
        names.slice(i, i + 8).map((name) => api.delete(`${base}/${encodeURIComponent(name)}`).catch(() => failed.push(name))),
      );
    }
    setSelected(new Set());
    setBusy(false);
    if (failed.length) setError(`Could not delete ${failed.length} of ${names.length}: ${failed.slice(0, 3).join(', ')}`);
    resource.reload();
  };

  const deleteChosen = () => {
    const bytes = chosen.reduce((sum, i) => sum + i.size, 0);
    if (confirm(`Delete ${plural(chosen.length, 'file')} (${formatBytes(bytes)})? This cannot be undone.`)) {
      void remove(chosen.map((i) => i.name));
    }
  };

  const index = open ? items.findIndex((i) => i.name === open) : -1;

  return (
    <Page
      title="Media"
      description={tab === 'outputs' ? 'Everything generated. Files here are removed after a day; a project keeps its own copy of each take.' : 'Files you uploaded as inputs.'}
    >
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <TabsList>
            <TabsTrigger value="outputs">Generated ({outputs.data?.outputs.length ?? 0})</TabsTrigger>
            <TabsTrigger value="uploads">Uploads ({uploads.data?.uploads.length ?? 0})</TabsTrigger>
          </TabsList>
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name" className="pl-8" aria-label="Search by name" />
          </div>
          <Select
            value={kind}
            onValueChange={setKind}
            className="w-32"
            options={[
              { value: 'all', label: 'All kinds' },
              { value: 'image', label: 'Images' },
              { value: 'video', label: 'Video' },
              { value: 'audio', label: 'Audio' },
            ]}
          />
          {tab === 'outputs' ? (
            <Select
              value={source}
              onValueChange={setSource}
              className="w-44"
              options={[{ value: 'all', label: 'All models' }, ...sources.map((s) => ({ value: s, label: s }))]}
            />
          ) : null}
          <Select
            value={sort}
            onValueChange={(value) => setSort(value as Sort)}
            className="w-32"
            options={[
              { value: 'newest', label: 'Newest' },
              { value: 'oldest', label: 'Oldest' },
              { value: 'largest', label: 'Largest' },
            ]}
          />
        </div>

        <div className="flex min-h-9 flex-wrap items-center gap-3 text-xs">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)]"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = chosen.length > 0 && !allSelected;
              }}
              disabled={!items.length}
              onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.name)))}
            />
            {allSelected ? 'Deselect all' : `Select all ${items.length}`}
          </label>
          {chosen.length ? (
            <>
              <span className="text-muted-foreground">
                {chosen.length} selected · {formatBytes(chosen.reduce((sum, i) => sum + i.size, 0))}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
              <Button size="sm" variant="destructive" disabled={busy} onClick={deleteChosen}>
                {busy ? <Spinner /> : <Trash2 />} Delete {chosen.length}
              </Button>
            </>
          ) : (
            <span className="text-muted-foreground">
              {items.length === all.length ? plural(all.length, 'file') : `${items.length} of ${plural(all.length, 'file')}`} ·{' '}
              {formatBytes(items.reduce((sum, i) => sum + i.size, 0))}
            </span>
          )}
        </div>

        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {resource.error ? <ErrorNote>{resource.error.message}</ErrorNote> : null}
        {resource.loading && !resource.data ? <Spinner /> : null}
        {resource.data && !items.length ? (
          <EmptyState
            icon={Library}
            title={all.length ? 'Nothing matches' : 'Nothing here yet'}
            description={all.length ? 'Change the search or the filters.' : undefined}
          />
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((item) => (
            <Tile key={item.name} item={item} selected={selected.has(item.name)} onToggle={() => toggle(item.name)} onOpen={() => setOpen(item.name)} />
          ))}
        </div>
      </Tabs>

      <Viewer
        item={index >= 0 ? items[index] : undefined}
        withInfo={tab === 'outputs'}
        position={index >= 0 ? `${index + 1} of ${items.length}` : ''}
        onPrev={index > 0 ? () => setOpen(items[index - 1].name) : undefined}
        onNext={index >= 0 && index < items.length - 1 ? () => setOpen(items[index + 1].name) : undefined}
        onClose={() => setOpen(undefined)}
        onDelete={(item) => {
          if (!confirm(`Delete ${item.name}? This cannot be undone.`)) return;
          // Move on to the next file, as a viewer that closes on delete makes clearing a set slow.
          const next = items[index + 1] ?? items[index - 1];
          setOpen(next?.name);
          void remove([item.name]);
        }}
      />
    </Page>
  );
}

/** One file: a preview to click open, a checkbox to select it, and what it is. */
function Tile({ item, selected, onToggle, onOpen }: { item: MediaItem; selected: boolean; onToggle: () => void; onOpen: () => void }) {
  return (
    <Card className={cn('group relative flex flex-col gap-2 overflow-hidden p-2', selected && 'ring-2 ring-primary')}>
      <input
        type="checkbox"
        aria-label={`Select ${item.name}`}
        className="absolute left-3 top-3 z-10 size-4 accent-[var(--primary)] opacity-70 transition-opacity group-hover:opacity-100 checked:opacity-100"
        checked={selected}
        onChange={onToggle}
      />
      <button type="button" onClick={onOpen} className="relative block overflow-hidden rounded-md bg-muted text-left" aria-label={`Open ${item.name}`}>
        {item.kind === 'image' ? <img src={item.url} alt="" loading="lazy" className="aspect-video w-full object-cover" /> : null}
        {item.kind === 'video' ? (
          <>
            {/* The first frame as a poster; it plays, with sound, in the viewer. */}
            <video src={`${item.url}#t=0.1`} muted preload="metadata" className="aspect-video w-full bg-black object-cover" />
            <Play className="absolute left-1/2 top-1/2 size-9 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/55 p-2 text-white" />
          </>
        ) : null}
        {item.kind === 'audio' || item.kind === 'other' ? (
          <div className="flex aspect-video w-full items-center justify-center text-muted-foreground">
            <Music className="size-8" />
          </div>
        ) : null}
      </button>
      {item.kind === 'audio' ? <audio src={item.url} controls preload="none" className="h-8 w-full" /> : null}
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate font-mono" title={item.name}>
          {item.name}
        </span>
        <span className="shrink-0">
          {formatBytes(item.size)} · {timeAgo(item.modified)}
        </span>
      </div>
    </Card>
  );
}

/** A file at full size, with the files around it a key press away. */
function Viewer({
  item,
  withInfo,
  position,
  onPrev,
  onNext,
  onClose,
  onDelete,
}: {
  item: MediaItem | undefined;
  withInfo: boolean;
  position: string;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
  onDelete: (item: MediaItem) => void;
}) {
  const info = useResource<OutputInfo>(item && withInfo ? `/v1/outputs/${encodeURIComponent(item.name)}/info` : null);

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

  const params = (info.data?.job?.params ?? {}) as Record<string, unknown>;
  const values = (params.params ?? params) as Record<string, unknown>;
  const recipe = typeof params.recipe === 'string' ? params.recipe : undefined;
  const details = [
    recipe,
    typeof params.mode === 'string' ? params.mode : undefined,
    values.seed !== undefined ? `seed ${String(values.seed)}` : undefined,
    typeof values.width === 'number' && typeof values.height === 'number' ? `${values.width}×${values.height}` : undefined,
  ].filter(Boolean);

  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => !open && onClose()}>
      {item ? (
        <DialogContent title={item.name} description={`${position} · ${formatBytes(item.size)} · ${timeAgo(item.modified)}`} className="[--dialog-w:96rem]">
          <div className="flex flex-col gap-3 p-4">
            <div className="relative flex items-center justify-center rounded-lg bg-black/90">
              {item.kind === 'image' ? <img src={item.url} alt={item.name} className="max-h-[72vh] w-auto max-w-full object-contain" /> : null}
              {item.kind === 'video' ? <video key={item.url} src={item.url} controls autoPlay className="max-h-[72vh] w-auto max-w-full" /> : null}
              {item.kind === 'audio' ? <audio key={item.url} src={item.url} controls autoPlay className="m-10 w-full max-w-xl" /> : null}
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
            <div className="flex flex-wrap items-start justify-between gap-3 text-xs">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                {details.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {details.map((d) => (
                      <Badge key={String(d)} variant="outline">
                        {String(d)}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {typeof values.prompt === 'string' ? <p className="leading-relaxed text-muted-foreground">{values.prompt}</p> : null}
              </div>
              <div className="flex shrink-0 gap-2">
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
                <Button size="sm" variant="destructive" onClick={() => onDelete(item)}>
                  <Trash2 /> Delete
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
