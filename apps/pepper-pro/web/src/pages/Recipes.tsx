import * as React from 'react';
import { ChevronDown, Download, FlaskConical, HardDrive, Medal, RefreshCw, Trash2 } from 'lucide-react';
import { Page } from '@pepper/ui/components/layout';
import { Badge, Button, Card, Dialog, DialogContent, EmptyState, ErrorNote, Progress, Select, Spinner } from '@pepper/ui/components/ui';
import { api, useResource, type DownloadTask } from '@pepper/ui/lib/api';
import { cn, formatBytes } from '@pepper/ui/lib/utils';
import { GoldenDialog } from '@/components/Golden';
import { LicenceBadge, LicenceNotice } from '@/components/licence';
import type { DeletePlan, Recipe, RecipeList } from '@/lib/pro';

/** Sizes on this screen count as the volume does: 100 GB is 100e9 bytes. */
const size = (bytes: number | null | undefined) => formatBytes(bytes, { decimal: true });

/** What the server keeps free for the database and logs (core's StorageMonitor reserve). */
const RESERVE_BYTES = 2 * 1024 ** 3;

type Storage = NonNullable<RecipeList['storage']>;

const STATE: Record<Recipe['state'], { label: string; variant: 'success' | 'warning' | 'outline' }> = {
  installed: { label: 'Installed', variant: 'success' },
  partial: { label: 'Partly installed', variant: 'warning' },
  missing: { label: 'Not installed', variant: 'outline' },
};

/**
 * The recipes this image ships, what they are for, what their licences
 * allow, and installing them (downloading their files for this tier).
 */
export function RecipesPage() {
  const list = useResource<RecipeList>('/v1/recipes', 10_000);
  const downloads = useResource<{ downloads: DownloadTask[] }>('/v1/downloads', 3000);
  const [kind, setKind] = React.useState('all');
  const [status, setStatus] = React.useState<'all' | Recipe['state']>('all');
  const [golden, setGolden] = React.useState<Recipe>();
  const [deleting, setDeleting] = React.useState<Recipe>();

  const all = list.data?.recipes ?? [];
  const ofKind = all.filter((r) => kind === 'all' || r.kind === kind);
  const recipes = ofKind.filter((r) => status === 'all' || r.state === status);
  const count = (state: Recipe['state']) => ofKind.filter((r) => r.state === state).length;
  const active = (downloads.data?.downloads ?? []).filter((d) => d.status === 'queued' || d.status === 'downloading');
  const storage = list.data?.storage ?? null;
  // Room for another install: free space less what queued downloads will take and the reserve.
  const room =
    storage?.freeBytes == null ? null : Math.max(0, storage.freeBytes - (list.data?.downloading_bytes ?? 0) - RESERVE_BYTES);
  const changed = () => (list.reload(), downloads.reload());

  return (
    <Page
      title="Recipes"
      description={
        list.data
          ? `Pinned ComfyUI pipelines. This server runs the ${list.data.tier} tier in ${list.data.licence_mode} mode.`
          : 'Pinned ComfyUI pipelines.'
      }
      actions={
        <>
          <Select
            value={status}
            onValueChange={(value) => setStatus(value as typeof status)}
            className="w-44"
            options={[
              { value: 'all', label: `Any status (${ofKind.length})` },
              { value: 'installed', label: `Installed (${count('installed')})` },
              { value: 'partial', label: `Partly installed (${count('partial')})` },
              { value: 'missing', label: `Not installed (${count('missing')})` },
            ]}
          />
          <Select
            value={kind}
            onValueChange={setKind}
            className="w-32"
            options={[
              { value: 'all', label: 'All kinds' },
              { value: 'video', label: 'Video' },
              { value: 'image', label: 'Image' },
              { value: 'audio', label: 'Audio' },
            ]}
          />
          <Button variant="outline" size="sm" onClick={() => void api.post('/v1/recipes/reload').then(list.reload)}>
            <RefreshCw /> Reload
          </Button>
        </>
      }
    >
      {list.error ? <ErrorNote>{list.error.message}</ErrorNote> : null}
      {storage ? <StorageBar storage={storage} downloading={list.data?.downloading_bytes ?? 0} /> : null}
      {list.data?.broken.length ? (
        <ErrorNote>
          {list.data.broken.map((b) => (
            <div key={b.id}>
              {b.id}: {b.error}
            </div>
          ))}
        </ErrorNote>
      ) : null}
      {active.length ? (
        <Card className="flex flex-col gap-2 p-3">
          <p className="text-xs font-medium">Downloading</p>
          {active.map((d) => (
            <div key={d.id} className="flex items-center gap-3 text-xs">
              <span className="w-72 truncate font-mono">{d.name}</span>
              <Progress value={d.total ? d.received / d.total : 0} indeterminate={!d.total} className="flex-1" />
              <span className="w-32 text-right text-muted-foreground">
                {size(d.received)} / {size(d.total)}
              </span>
            </div>
          ))}
        </Card>
      ) : null}
      {list.loading && !list.data ? <Spinner /> : null}
      {list.data && recipes.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title="No recipes"
          description={status === 'all' ? 'This build ships none of this kind.' : 'None match these filters.'}
        />
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {recipes.map((recipe) => (
          <RecipeCard
            key={recipe.id}
            recipe={recipe}
            room={room}
            onChanged={changed}
            onGolden={() => setGolden(recipe)}
            onDelete={() => setDeleting(recipe)}
          />
        ))}
      </div>
      <GoldenDialog recipe={golden} onOpenChange={(open) => !open && setGolden(undefined)} />
      <DeleteDialog
        recipe={deleting}
        names={Object.fromEntries(all.map((r) => [r.id, r.name]))}
        onOpenChange={(open) => !open && setDeleting(undefined)}
        onDeleted={changed}
      />
    </Page>
  );
}

/** How full the data volume is: used, free, and what downloads in progress will still take. */
function StorageBar({ storage, downloading }: { storage: Storage; downloading: number }) {
  const used = storage.usedBytes;
  const fraction = used === null ? 0 : used / storage.totalBytes;
  const pending = Math.min(downloading / storage.totalBytes, Math.max(0, 1 - fraction));
  const tone = fraction > 0.95 ? 'bg-destructive' : fraction > 0.85 ? 'bg-[var(--warning)]' : 'bg-primary';
  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 font-medium">
          <HardDrive className="size-3.5" /> Storage
        </span>
        <span className="text-muted-foreground">
          {used === null ? 'Measuring…' : `${size(used)} of ${size(storage.totalBytes)} used · ${size(storage.freeBytes)} free`}
          {downloading > 0 ? ` · ${size(downloading)} still downloading` : ''}
          {storage.source === 'filesystem' ? ' (this disk)' : ''}
        </span>
      </div>
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-secondary" role="meter" aria-valuenow={Math.round(fraction * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Storage used">
        <div className={cn('h-full transition-[width] duration-300', tone)} style={{ width: `${Math.min(100, fraction * 100)}%` }} />
        <div className="h-full bg-primary/35" style={{ width: `${pending * 100}%` }} title="Still downloading" />
      </div>
    </Card>
  );
}

function RecipeCard({
  recipe,
  room,
  onChanged,
  onGolden,
  onDelete,
}: {
  recipe: Recipe;
  room: number | null;
  onChanged: () => void;
  onGolden: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const state = STATE[recipe.state];
  const total = recipe.files.reduce((sum, f) => sum + (f.bytes ?? 0), 0);
  const onDisk = recipe.files.filter((f) => f.installed).reduce((sum, f) => sum + (f.bytes ?? 0), 0);
  // The server refuses an install that does not fit; say so before the click.
  const tooBig = room !== null && recipe.install_bytes > room;

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{recipe.name}</h3>
            <Badge variant="outline" className="capitalize">
              {recipe.kind}
            </Badge>
            <Badge variant={state.variant}>{state.label}</Badge>
          </div>
          <p className="font-mono text-[11px] text-muted-foreground">{recipe.id}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="ghost" aria-label="Golden shots" title="Golden shots" onClick={onGolden}>
            <Medal />
          </Button>
          {recipe.state !== 'missing' ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label="Delete files"
              title={`Delete ${recipe.name}'s files (${size(onDisk)} on disk)`}
              onClick={onDelete}
            >
              <Trash2 />
            </Button>
          ) : null}
          {recipe.state !== 'installed' ? (
            <Button
              size="sm"
              disabled={busy || tooBig}
              title={tooBig ? `Needs ${size(recipe.install_bytes)}; ${size(room)} is free. Delete a model first.` : undefined}
              onClick={() => void act(() => api.post(`/v1/recipes/${recipe.id}/install`, {}))}
            >
              {busy ? <Spinner /> : <Download />}
              {size(recipe.install_bytes)}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{recipe.description}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <LicenceBadge licence={recipe.licence} />
        {recipe.modes.map((mode) => (
          <Badge key={mode.id} variant={mode.id === recipe.default_mode ? 'primary' : 'default'} title={mode.description}>
            {mode.label}
          </Badge>
        ))}
        {!recipe.verified ? (
          <Badge variant="outline" title="No golden-shot run has been recorded for this recipe yet">
            Not yet verified on a GPU
          </Badge>
        ) : null}
      </div>
      {recipe.licence_block ? <ErrorNote>{recipe.licence_block}</ErrorNote> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <LicenceNotice licence={recipe.licence} />
      <button className="flex items-start gap-1 self-start text-left text-xs text-muted-foreground" onClick={() => setOpen(!open)}>
        <ChevronDown className={cn('mt-0.5 size-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
        {[
          `${recipe.files.length} files, ${size(total)}`,
          recipe.state === 'partial' ? `${size(onDisk)} on disk` : '',
          recipe.capabilities.join(', '),
        ]
          .filter(Boolean)
          .join(' · ')}
      </button>
      {open ? (
        <div className="flex flex-col gap-2 text-xs">
          <table className="w-full">
            <tbody>
              {recipe.files.map((file) => (
                <tr key={file.id} className="border-t border-border">
                  <td className="py-1 pr-2">{file.label}</td>
                  <td className="py-1 pr-2 font-mono text-[11px] text-muted-foreground">
                    {file.folder}/{file.name}
                  </td>
                  <td className="py-1 pr-2 text-right">{size(file.bytes)}</td>
                  <td className="py-1 text-right">{file.installed ? '✓' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {recipe.licence.obligations.length ? (
            <ul className="list-disc pl-4 text-muted-foreground">
              {recipe.licence.obligations.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          ) : null}
          {recipe.licence.url ? (
            <a href={recipe.licence.url} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">
              {recipe.licence.name}
            </a>
          ) : null}
          {recipe.notes ? <p className="text-muted-foreground">{recipe.notes}</p> : null}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Deleting a recipe's files. Files other installed recipes use are kept by
 * default; the user can delete them too, which leaves those recipes partly
 * installed until they are installed again.
 */
function DeleteDialog({
  recipe,
  names,
  onOpenChange,
  onDeleted,
}: {
  recipe: Recipe | undefined;
  names: Record<string, string>;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const plan = useResource<DeletePlan>(recipe ? `/v1/recipes/${recipe.id}/delete-plan` : null);
  const [shared, setShared] = React.useState<'keep' | 'delete'>('keep');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();

  React.useEffect(() => {
    setShared('keep');
    setError(undefined);
  }, [recipe?.id]);

  const files = plan.data?.files ?? [];
  const sharedFiles = files.filter((f) => f.shared_with.length);
  const users = [...new Set(sharedFiles.flatMap((f) => f.shared_with))].map((id) => names[id] ?? id);
  const one = users.length === 1;
  const removed = files.filter((f) => !f.shared_with.length || shared === 'delete');
  const freed = removed.reduce((sum, f) => sum + f.bytes, 0);

  const confirm = async () => {
    if (!recipe) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.delete(`/v1/recipes/${recipe.id}?shared=${shared}`);
      onDeleted();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(recipe)} onOpenChange={onOpenChange}>
      {recipe ? (
        <DialogContent title={`Delete ${recipe.name}`} description="Removes its model files from the data volume. Install it again to get them back.">
          <div className="flex flex-col gap-4 p-5 text-xs">
            {plan.loading && !plan.data ? <Spinner /> : null}
            {plan.error ? <ErrorNote>{plan.error.message}</ErrorNote> : null}
            {plan.data && files.length === 0 ? <p className="text-muted-foreground">None of its files are on disk.</p> : null}
            {files.length ? (
              <table className="w-full">
                <tbody>
                  {files.map((file) => {
                    const goes = !file.shared_with.length || shared === 'delete';
                    return (
                      <tr key={file.path} className={cn('border-t border-border', !goes && 'text-muted-foreground')}>
                        <td className="py-1.5 pr-2">
                          <div>{file.label}</div>
                          <div className="font-mono text-[11px] text-muted-foreground">{file.path}</div>
                        </td>
                        <td className="py-1.5 pr-2">
                          {file.shared_with.length ? (
                            <Badge variant="warning" title="Other installed recipes use this file">
                              Shared with {file.shared_with.map((id) => names[id] ?? id).join(', ')}
                            </Badge>
                          ) : null}
                        </td>
                        <td className="py-1.5 pr-2 text-right">{size(file.bytes)}</td>
                        <td className="py-1.5 text-right">{goes ? 'Delete' : 'Keep'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : null}
            {sharedFiles.length ? (
              <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
                <legend className="px-1 font-medium">
                  {sharedFiles.length === 1 ? 'One file is' : `${sharedFiles.length} files are`} shared with {users.join(', ')}
                </legend>
                <label className="flex cursor-pointer items-start gap-2">
                  <input type="radio" name="shared" className="mt-0.5" checked={shared === 'keep'} onChange={() => setShared('keep')} />
                  <span>
                    <span className="font-medium">Keep shared files</span>
                    <span className="block text-muted-foreground">
                      {users.join(', ')} {one ? 'keeps' : 'keep'} working. Frees {size(plan.data?.own_bytes)}.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2">
                  <input type="radio" name="shared" className="mt-0.5" checked={shared === 'delete'} onChange={() => setShared('delete')} />
                  <span>
                    <span className="font-medium">Delete shared files too</span>
                    <span className="block text-muted-foreground">
                      Frees {size((plan.data?.own_bytes ?? 0) + (plan.data?.shared_bytes ?? 0))}. {users.join(', ')}{' '}
                      {one ? 'becomes' : 'become'} partly installed, and {one ? 'downloads' : 'download'}{' '}
                      {sharedFiles.length === 1 ? 'it' : 'them'} again when installed.
                    </span>
                  </span>
                </label>
              </fieldset>
            ) : null}
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="destructive" disabled={busy || !removed.length} onClick={() => void confirm()}>
                {busy ? <Spinner /> : <Trash2 />}
                Delete {removed.length} {removed.length === 1 ? 'file' : 'files'} · frees {size(freed)}
              </Button>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
