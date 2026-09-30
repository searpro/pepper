import * as React from 'react';
import { ChevronDown, Download, FlaskConical, RefreshCw, Trash2 } from 'lucide-react';
import { Page } from '@pepper/ui/components/layout';
import { Badge, Button, Card, EmptyState, ErrorNote, Progress, Select, Spinner } from '@pepper/ui/components/ui';
import { api, useResource, type DownloadTask } from '@pepper/ui/lib/api';
import { cn, formatBytes } from '@pepper/ui/lib/utils';
import { LicenceBadge, LicenceNotice } from '@/components/licence';
import type { Recipe, RecipeList } from '@/lib/pro';

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

  const recipes = (list.data?.recipes ?? []).filter((r) => kind === 'all' || r.kind === kind);
  const active = (downloads.data?.downloads ?? []).filter((d) => d.status === 'queued' || d.status === 'downloading');

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
                {formatBytes(d.received)} / {formatBytes(d.total)}
              </span>
            </div>
          ))}
        </Card>
      ) : null}
      {list.loading && !list.data ? <Spinner /> : null}
      {list.data && recipes.length === 0 ? (
        <EmptyState icon={FlaskConical} title="No recipes" description="This build ships none of this kind." />
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {recipes.map((recipe) => (
          <RecipeCard key={recipe.id} recipe={recipe} onChanged={() => (list.reload(), downloads.reload())} />
        ))}
      </div>
    </Page>
  );
}

function RecipeCard({ recipe, onChanged }: { recipe: Recipe; onChanged: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const state = STATE[recipe.state];
  const total = recipe.files.reduce((sum, f) => sum + (f.bytes ?? 0), 0);

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
          {recipe.state !== 'installed' ? (
            <Button size="sm" disabled={busy} onClick={() => void act(() => api.post(`/v1/recipes/${recipe.id}/install`, {}))}>
              {busy ? <Spinner /> : <Download />}
              {formatBytes(recipe.missing_bytes)}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label="Delete files"
              onClick={() => {
                if (confirm(`Delete ${recipe.name}'s files? Files other installed recipes use are kept.`)) {
                  void act(() => api.delete(`/v1/recipes/${recipe.id}`));
                }
              }}
            >
              <Trash2 />
            </Button>
          )}
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
        {[`${recipe.files.length} files, ${formatBytes(total)}`, recipe.capabilities.join(', ')].filter(Boolean).join(' · ')}
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
                  <td className="py-1 pr-2 text-right">{formatBytes(file.bytes)}</td>
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
