import * as React from 'react';
import {
  Ban,
  CheckCircle2,
  CloudDownload,
  HardDrive,
  Package,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import {
  api,
  useEventStream,
  useResource,
  type BundleInfo,
  type CatalogueModel,
  type DownloadTask,
  type ModelKind,
} from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Progress,
  Select,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
} from '@/components/ui';
import { formatBytes } from '@/lib/utils';

const KINDS: { value: ModelKind | ''; label: string }[] = [
  { value: '', label: 'All kinds' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
  { value: 'audio', label: 'Audio' },
  { value: 'llm', label: 'Text' },
];

/**
 * Model and catalogue management (requirement 10: "large popup type window
 * includes download manager, download progress, highlights downloaded models,
 * shows progress for downloading models etc. Actions to delete, add component
 * into bundle").
 *
 * Three tabs rather than three screens, because these are one task: you browse
 * the catalogue, watch what you picked download, and manage what has landed.
 * Download progress is shared live across all three from a single SSE
 * subscription held here, so the Installed tab shows a bundle filling up while
 * the Catalogue tab is open on something else.
 */
export function CatalogueDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [downloads, setDownloads] = React.useState<DownloadTask[]>([]);
  const installed = useResource<{ models: BundleInfo[] }>(open ? '/v1/models' : null);
  const initialDownloads = useResource<{ downloads: DownloadTask[] }>(open ? '/v1/downloads' : null);

  React.useEffect(() => {
    if (initialDownloads.data) setDownloads(initialDownloads.data.downloads);
  }, [initialDownloads.data]);

  useEventStream(
    open ? '/v1/downloads/stream' : null,
    (event, data) => {
      const task = data as DownloadTask;
      if (!task?.id) return;
      setDownloads((current) =>
        current.some((existing) => existing.id === task.id)
          ? current.map((existing) => (existing.id === task.id ? task : existing))
          : [task, ...current],
      );
      // A completed download changes what is on disk, so the installed list
      // has to be re-read rather than patched.
      if (event === 'done' && task.status === 'completed') installed.reload();
    },
    ['task', 'progress', 'done'],
  );

  const active = downloads.filter(
    (task) => task.status === 'queued' || task.status === 'downloading',
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Models"
        description="Browse the catalogue, install weights, and manage what is on disk."
        className="[--dialog-w:72rem]"
      >
        <Tabs defaultValue="catalogue" className="flex flex-col">
          <div className="border-b border-border px-5 py-3">
            <TabsList>
              <TabsTrigger value="catalogue">
                <Package className="size-3.5" /> Catalogue
              </TabsTrigger>
              <TabsTrigger value="installed">
                <HardDrive className="size-3.5" /> Installed
                <Badge variant="outline">{installed.data?.models.length ?? 0}</Badge>
              </TabsTrigger>
              <TabsTrigger value="downloads">
                <CloudDownload className="size-3.5" /> Downloads
                {active.length > 0 ? <Badge variant="primary">{active.length}</Badge> : null}
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="catalogue" className="p-5">
            <CatalogueTab installedIds={new Set((installed.data?.models ?? []).map((m) => m.id))} />
          </TabsContent>

          <TabsContent value="installed" className="p-5">
            <InstalledTab
              models={installed.data?.models ?? []}
              downloads={downloads}
              loading={installed.loading}
              onChanged={installed.reload}
            />
          </TabsContent>

          <TabsContent value="downloads" className="p-5">
            <DownloadsTab downloads={downloads} onChanged={() => initialDownloads.reload()} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function CatalogueTab({ installedIds }: { installedIds: Set<string> }) {
  const [kind, setKind] = React.useState<ModelKind | ''>('');
  const [search, setSearch] = React.useState('');
  const [selected, setSelected] = React.useState<string>();

  const query = new URLSearchParams();
  if (kind) query.set('kind', kind);
  if (search) query.set('search', search);

  const catalogue = useResource<{
    models: CatalogueModel[];
    state: { loaded: boolean; source: string; url: string; error?: string };
  }>(`/v1/catalogue?${query.toString()}`);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search the catalogue…"
            className="pl-8"
          />
        </div>
        <Select
          value={kind}
          onValueChange={(value) => setKind(value as ModelKind | '')}
          options={KINDS}
          className="w-40"
        />
        <Tooltip label="Refetch the remote catalogue">
          <Button
            variant="outline"
            size="icon"
            onClick={async () => {
              await api.post('/v1/catalogue/refresh');
              catalogue.reload();
            }}
          >
            <RefreshCw />
          </Button>
        </Tooltip>
      </div>

      {catalogue.error ? (
        <ErrorNote>
          {catalogue.error.message}
          <span className="mt-1 block opacity-80">
            The catalogue is a remote JSON manifest. Point <code>CATALOGUE_URL</code> at a reachable
            copy, or install models by URL from the Installed tab.
          </span>
        </ErrorNote>
      ) : null}

      {catalogue.data?.state && catalogue.data.state.source === 'cache' ? (
        <p className="text-[11px] text-[var(--warning)]">
          Showing a cached copy — the remote catalogue could not be reached.
        </p>
      ) : null}

      {catalogue.loading ? (
        <Spinner className="size-4" />
      ) : (catalogue.data?.models.length ?? 0) === 0 && !catalogue.error ? (
        <EmptyState
          icon={Package}
          title="No catalogue models"
          description="Nothing in the remote manifest matches this filter."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {catalogue.data?.models.map((model) => (
            <Card key={model.id} className="flex flex-col gap-2 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{model.name}</span>
                    <Badge variant="outline" className="capitalize">
                      {model.kind}
                    </Badge>
                    {installedIds.has(model.id) ? (
                      <Badge variant="success">
                        <CheckCircle2 className="size-2.5" /> installed
                      </Badge>
                    ) : null}
                  </div>
                  {model.description ? (
                    <p className="line-clamp-2 text-[11px] text-muted-foreground">{model.description}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-1">
                    {model.params ? <Badge variant="outline">{model.params}</Badge> : null}
                    {model.tags.slice(0, 4).map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setSelected(model.id)}>
                  <CloudDownload /> Install
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {selected ? <InstallDialog modelId={selected} onClose={() => setSelected(undefined)} /> : null}
    </div>
  );
}

/**
 * The component/quantization picker. One selection per component, defaulting
 * to the smallest file — which for a quantized model is the one most likely to
 * fit, and the safest thing to pre-select on hardware we know nothing about.
 */
function InstallDialog({ modelId, onClose }: { modelId: string; onClose: () => void }) {
  const files = useResource<{ components: CatalogueModel['components'] }>(
    `/v1/catalogue/${encodeURIComponent(modelId)}/files`,
  );
  const [selections, setSelections] = React.useState<Record<string, string>>({});
  const [bundle, setBundle] = React.useState(modelId);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();

  React.useEffect(() => {
    if (!files.data) return;
    const defaults: Record<string, string> = {};
    for (const component of files.data.components) {
      const first = component.files?.[0];
      if (first && component.required) defaults[component.slot + component.label] = first.url;
    }
    setSelections(defaults);
  }, [files.data]);

  const install = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const chosen = (files.data?.components ?? [])
        .map((component) => {
          const url = selections[component.slot + component.label];
          return url ? { slot: component.slot, url } : null;
        })
        .filter((value): value is { slot: string; url: string } => value !== null);

      if (chosen.length === 0) throw new Error('Select at least one component to install');
      await api.post(`/v1/catalogue/${encodeURIComponent(modelId)}/install`, {
        bundle,
        selections: chosen,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={`Install ${modelId}`}
        description="Choose a file for each component. Required components are pre-selected."
        className="[--dialog-w:44rem]"
      >
        <div className="flex flex-col gap-4 p-5">
          <Field label="Bundle name" hint="The directory this model installs into.">
            <Input value={bundle} onChange={(event) => setBundle(event.target.value)} />
          </Field>

          {files.loading ? (
            <Spinner className="size-4" />
          ) : (
            files.data?.components.map((component) => (
              <Field
                key={component.slot + component.label}
                label={
                  <span className="flex items-center gap-1.5">
                    {component.label}
                    <Badge variant="outline">{component.slot}</Badge>
                    {component.required ? <Badge variant="primary">required</Badge> : null}
                  </span>
                }
                hint={component.error ?? component.description}
              >
                <Select
                  value={selections[component.slot + component.label] ?? ''}
                  onValueChange={(value) =>
                    setSelections((current) => ({ ...current, [component.slot + component.label]: value }))
                  }
                  options={[
                    { value: '', label: component.required ? 'Choose a file' : 'Skip' },
                    ...(component.files ?? []).map((file) => ({
                      value: file.url,
                      label: `${file.quant ? `${file.quant} · ` : ''}${file.filename}`,
                      description: formatBytes(file.size),
                    })),
                  ]}
                />
              </Field>
            ))
          )}

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void install()} disabled={busy}>
              {busy ? <Spinner className="size-4" /> : <CloudDownload />}
              Install
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InstalledTab({
  models,
  downloads,
  loading,
  onChanged,
}: {
  models: BundleInfo[];
  downloads: DownloadTask[];
  loading: boolean;
  onChanged: () => void;
}) {
  const [adding, setAdding] = React.useState<BundleInfo>();

  if (loading) return <Spinner className="size-4" />;
  if (models.length === 0) {
    return (
      <EmptyState
        icon={HardDrive}
        title="No models installed"
        description="Install one from the Catalogue tab, or add a file by URL to a bundle."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {models.map((model) => {
        const active = downloads.filter(
          (task) =>
            task.bundle === model.id &&
            (task.status === 'downloading' || task.status === 'queued'),
        );

        return (
          <Card key={`${model.kind}/${model.id}`} className="flex flex-col gap-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium">{model.name}</span>
                  <Badge variant="outline" className="capitalize">
                    {model.kind}
                  </Badge>
                  {model.ready ? (
                    <Badge variant="success">ready</Badge>
                  ) : (
                    <Tooltip label={model.readyReason ?? 'Incomplete'}>
                      <Badge variant="warning">incomplete</Badge>
                    </Tooltip>
                  )}
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {formatBytes(model.size)} · {model.components.length} file
                  {model.components.length === 1 ? '' : 's'}
                </span>
              </div>

              <div className="flex items-center gap-1">
                <Tooltip label="Add a file to this bundle">
                  <Button variant="ghost" size="icon-sm" onClick={() => setAdding(model)}>
                    <Plus />
                  </Button>
                </Tooltip>
                <Tooltip label="Delete this bundle and all of its files">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={async () => {
                      await api.delete(`/v1/models/${model.kind}/${encodeURIComponent(model.id)}`);
                      onChanged();
                    }}
                  >
                    <Trash2 />
                  </Button>
                </Tooltip>
              </div>
            </div>

            {model.components.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {model.components.map((file) => (
                  <span
                    key={file.slot + file.name}
                    className="group flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground"
                  >
                    <span className="font-medium text-foreground/80">{file.slot}</span>
                    {file.name}
                    <span className="opacity-60">{formatBytes(file.size)}</span>
                    <button
                      className="opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      aria-label={`Delete ${file.name}`}
                      onClick={async () => {
                        await api.delete(
                          `/v1/models/${model.kind}/${encodeURIComponent(model.id)}/${encodeURIComponent(
                            file.slot,
                          )}/${encodeURIComponent(file.name)}`,
                        );
                        onChanged();
                      }}
                    >
                      <Trash2 className="size-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}

            {active.map((task) => (
              <div key={task.id} className="flex items-center gap-2">
                <span className="w-40 truncate text-[11px] text-muted-foreground">{task.name}</span>
                <Progress
                  value={task.total ? task.received / task.total : 0}
                  indeterminate={!task.total}
                  className="flex-1"
                />
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {formatBytes(task.received)}
                  {task.total ? ` / ${formatBytes(task.total)}` : ''}
                </span>
              </div>
            ))}

            {model.partials.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>Interrupted:</span>
                {model.partials.map((partial) => (
                  <Button
                    key={partial.slot + partial.name}
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      await api.post(`/v1/models/${model.kind}/${encodeURIComponent(model.id)}/resume`, {
                        slot: partial.slot,
                        name: partial.name,
                      });
                      onChanged();
                    }}
                  >
                    Resume {partial.name} ({formatBytes(partial.received)})
                  </Button>
                ))}
              </div>
            ) : null}
          </Card>
        );
      })}

      {adding ? (
        <AddComponentDialog
          model={adding}
          onClose={() => setAdding(undefined)}
          onAdded={() => {
            setAdding(undefined);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

const SLOTS_BY_KIND: Record<ModelKind, string[]> = {
  image: ['checkpoint', 'vae', 'clip', 'lora'],
  video: ['checkpoint', 'vae', 'clip', 'lora'],
  audio: ['weights', 'aux'],
  llm: ['weights', 'aux'],
};

/** Requirement 8's "add to bundle", including the "other (specify)" case. */
function AddComponentDialog({
  model,
  onClose,
  onAdded,
}: {
  model: BundleInfo;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [slot, setSlot] = React.useState(SLOTS_BY_KIND[model.kind][0]);
  const [customDir, setCustomDir] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();

  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.post(`/v1/models/${model.kind}/${encodeURIComponent(model.id)}/components`, {
        slot: slot === 'other' ? `other:${customDir}` : slot,
        url,
        ...(name ? { name } : {}),
      });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={`Add to ${model.name}`}
        description="Download a file straight into this bundle."
        className="[--dialog-w:34rem]"
      >
        <div className="flex flex-col gap-4 p-5">
          <Field label="Component">
            <Select
              value={slot}
              onValueChange={setSlot}
              options={[
                ...SLOTS_BY_KIND[model.kind].map((option) => ({
                  value: option,
                  label: option === 'lora' ? 'LORA' : option,
                })),
                { value: 'other', label: 'Other (specify a directory)' },
              ]}
            />
          </Field>

          {slot === 'other' ? (
            <Field
              label="Directory name"
              hint="Created inside the bundle, and the file is kept there."
            >
              <Input
                value={customDir}
                onChange={(event) => setCustomDir(event.target.value)}
                placeholder="controlnet"
              />
            </Field>
          ) : null}

          <Field label="File URL">
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://huggingface.co/…/resolve/main/model.safetensors"
            />
          </Field>

          <Field label="Filename" hint="Optional — derived from the URL when left empty.">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => void add()}
              disabled={busy || !url || (slot === 'other' && !customDir)}
            >
              {busy ? <Spinner className="size-4" /> : <Plus />}
              Add
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DownloadsTab({
  downloads,
  onChanged,
}: {
  downloads: DownloadTask[];
  onChanged: () => void;
}) {
  if (downloads.length === 0) {
    return (
      <EmptyState
        icon={CloudDownload}
        title="No downloads"
        description="Weights queued from the catalogue appear here with live progress."
      />
    );
  }

  const variantFor = (status: DownloadTask['status']) =>
    status === 'completed'
      ? ('success' as const)
      : status === 'failed'
        ? ('destructive' as const)
        : status === 'cancelled'
          ? ('warning' as const)
          : ('primary' as const);

  return (
    <div className="flex flex-col gap-2">
      {downloads.map((task) => {
        const active = task.status === 'downloading' || task.status === 'queued';
        return (
          <Card key={task.id} className="flex flex-col gap-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant={variantFor(task.status)}>{task.status}</Badge>
                <span className="truncate text-sm">{task.name}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  → {task.bundle}/{task.slot}
                </span>
              </div>

              <div className="flex items-center gap-1">
                {active ? (
                  <Tooltip label="Abort — the partial file is kept so a retry resumes">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={async () => {
                        await api.post(`/v1/downloads/${task.id}/cancel`);
                        onChanged();
                      }}
                    >
                      <Ban />
                    </Button>
                  </Tooltip>
                ) : task.status !== 'completed' ? (
                  <Tooltip label="Retry, resuming from what is already on disk">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={async () => {
                        await api.post(`/v1/downloads/${task.id}/retry`);
                        onChanged();
                      }}
                    >
                      <RefreshCw />
                    </Button>
                  </Tooltip>
                ) : null}
                <Tooltip label="Delete this record and any partial file">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={async () => {
                      await api.delete(`/v1/downloads/${task.id}?discard=true`);
                      onChanged();
                    }}
                  >
                    <Trash2 />
                  </Button>
                </Tooltip>
              </div>
            </div>

            {active ? (
              <div className="flex items-center gap-2">
                <Progress
                  value={task.total ? task.received / task.total : 0}
                  indeterminate={!task.total}
                  className="flex-1"
                />
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {formatBytes(task.received)}
                  {task.total ? ` / ${formatBytes(task.total)}` : ''}
                </span>
              </div>
            ) : null}

            {task.error ? <p className="text-[11px] text-destructive">{task.error}</p> : null}
          </Card>
        );
      })}
    </div>
  );
}
