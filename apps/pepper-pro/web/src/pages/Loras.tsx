import * as React from 'react';
import { ExternalLink, Layers, Pencil, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import { Page } from '@pepper/ui/components/layout';
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
  Textarea,
} from '@pepper/ui/components/ui';
import { api, ApiRequestError, useResource } from '@pepper/ui/lib/api';
import { cn, formatBytes } from '@pepper/ui/lib/utils';
import type { Lora, LoraBase, LoraCandidate, LoraList, RecipeList } from '@/lib/pro';

/**
 * The LoRA library: LoRAs from Civitai, HuggingFace or any link, each kept
 * once and usable with every recipe built on its base model. Adding one looks
 * the link up first, so its trigger words and base come from the source and
 * the person adding it only confirms them.
 */
export function LorasPage() {
  const list = useResource<LoraList>('/v1/loras', 3000);
  const recipes = useResource<RecipeList>('/v1/recipes', 30_000);
  const [base, setBase] = React.useState('all');
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<Lora>();
  const [deleting, setDeleting] = React.useState<Lora>();

  const all = list.data?.loras ?? [];
  const bases = list.data?.bases ?? [];
  const shown = all.filter((lora) => base === 'all' || lora.base === base);
  const recipeName = (id: string) => recipes.data?.recipes.find((r) => r.id === id)?.name ?? id;

  return (
    <Page
      title="LoRAs"
      description="Styles, characters and detail for recipes. A LoRA works with every recipe built on its base model."
      actions={
        <>
          <Select
            value={base}
            onValueChange={setBase}
            className="w-48"
            options={[
              { value: 'all', label: `Every base (${all.length})` },
              ...bases.map((b) => ({ value: b.id, label: `${b.label} (${all.filter((l) => l.base === b.id).length})` })),
            ]}
          />
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add LoRA
          </Button>
        </>
      }
    >
      {list.error ? <ErrorNote>{list.error.message}</ErrorNote> : null}
      {list.loading && !list.data ? <Spinner /> : null}
      {list.data && shown.length === 0 ? (
        <EmptyState
          icon={Layers}
          title={all.length ? 'None for this base' : 'No LoRAs yet'}
          description="Add one from a Civitai page, a Hugging Face repository or a link to a .safetensors file."
          action={
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus /> Add LoRA
            </Button>
          }
        />
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {shown.map((lora) => (
          <LoraCard
            key={lora.id}
            lora={lora}
            recipeName={recipeName}
            onEdit={() => setEditing(lora)}
            onDelete={() => setDeleting(lora)}
            onChanged={list.reload}
          />
        ))}
      </div>
      <AddDialog open={adding} bases={bases} onOpenChange={setAdding} onAdded={list.reload} />
      <EditDialog lora={editing} bases={bases} onOpenChange={(open) => !open && setEditing(undefined)} onSaved={list.reload} />
      <DeleteDialog lora={deleting} onOpenChange={(open) => !open && setDeleting(undefined)} onDeleted={list.reload} />
    </Page>
  );
}

function messageOf(err: unknown): string {
  return err instanceof ApiRequestError ? err.error.message : err instanceof Error ? err.message : String(err);
}

const SOURCE_LABEL: Record<Lora['source'], string> = { civitai: 'Civitai', huggingface: 'Hugging Face', url: 'Link' };

function StateBadge({ lora }: { lora: Lora }) {
  switch (lora.state) {
    case 'installed':
      return <Badge variant="success">Ready</Badge>;
    case 'queued':
      return <Badge variant="outline">Queued</Badge>;
    case 'downloading':
      return <Badge variant="primary">Downloading</Badge>;
    case 'failed':
      return <Badge variant="destructive">Download failed</Badge>;
    case 'missing':
      return <Badge variant="warning">File missing</Badge>;
  }
}

function Preview({ url, className }: { url?: string | null; className?: string }) {
  const [broken, setBroken] = React.useState(false);
  return (
    <div className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted', className)}>
      {url && !broken ? (
        <img src={url} alt="" loading="lazy" className="size-full object-cover" onError={() => setBroken(true)} />
      ) : (
        <Layers className="size-6 text-muted-foreground/60" />
      )}
    </div>
  );
}

function LoraCard({
  lora,
  recipeName,
  onEdit,
  onDelete,
  onChanged,
}: {
  lora: Lora;
  recipeName: (id: string) => string;
  onEdit: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const [error, setError] = React.useState<string>();
  const [copied, setCopied] = React.useState<string>();
  const retry = async () => {
    setError(undefined);
    try {
      await api.post(`/v1/loras/${lora.id}/retry`);
      onChanged();
    } catch (err) {
      setError(messageOf(err));
    }
  };
  const copy = (word: string) => {
    void navigator.clipboard?.writeText(word).then(() => {
      setCopied(word);
      setTimeout(() => setCopied(undefined), 1200);
    });
  };
  const downloading = lora.state === 'queued' || lora.state === 'downloading';

  return (
    // min-w-0: a long trigger phrase must not widen the grid cell past the screen.
    <Card className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex gap-3">
        <Preview url={lora.preview_url} className="size-16" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-semibold" title={lora.name}>
              {lora.name}
            </p>
            <StateBadge lora={lora} />
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <Badge variant="primary">{lora.base_label}</Badge>
            <span>×{lora.strength}</span>
            {lora.bytes ? <span>{formatBytes(lora.bytes)}</span> : null}
            {lora.page_url ? (
              <a href={lora.page_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-foreground">
                {SOURCE_LABEL[lora.source]} <ExternalLink className="size-3" />
              </a>
            ) : (
              <span>{SOURCE_LABEL[lora.source]}</span>
            )}
          </div>
        </div>
      </div>

      {downloading && lora.download ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Progress
            value={lora.download.total ? lora.download.received / lora.download.total : 0}
            indeterminate={!lora.download.total}
            className="flex-1"
          />
          <span>
            {formatBytes(lora.download.received)}
            {lora.download.total ? ` / ${formatBytes(lora.download.total)}` : ''}
          </span>
        </div>
      ) : null}
      {lora.state === 'failed' && lora.download?.error ? <ErrorNote>{lora.download.error}</ErrorNote> : null}

      {lora.trigger_words.length ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="text-[11px] text-muted-foreground">Trigger words</span>
          {lora.trigger_words.map((word) => (
            <button
              key={word}
              type="button"
              onClick={() => copy(word)}
              title={`Copy: ${word}`}
              className="max-w-full truncate rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent"
            >
              {copied === word ? 'Copied' : word}
            </button>
          ))}
        </div>
      ) : null}
      {lora.description ? <p className="line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">{lora.description}</p> : null}
      <p className="text-[11px] text-muted-foreground">
        {lora.recipes.length ? (
          <>Works with {lora.recipes.map(recipeName).join(', ')}</>
        ) : (
          <>No installed recipe runs {lora.base_label} yet</>
        )}
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="mt-auto flex flex-wrap justify-end gap-2">
        {lora.state === 'failed' || lora.state === 'missing' ? (
          <Button variant="outline" size="sm" onClick={() => void retry()}>
            <RotateCcw /> Download again
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil /> Edit
        </Button>
        <Button variant="outline" size="sm" onClick={onDelete} aria-label={`Delete ${lora.name}`}>
          <Trash2 />
        </Button>
      </div>
    </Card>
  );
}

/** Name, base, trigger words and strength: the fields both adding and editing set. */
interface Details {
  name: string;
  base: string;
  trigger_words: string;
  strength: string;
  description: string;
}

function DetailFields({
  details,
  bases,
  sourceBase,
  onChange,
}: {
  details: Details;
  bases: LoraBase[];
  sourceBase?: string;
  onChange: (details: Details) => void;
}) {
  const set = (key: keyof Details) => (value: string) => onChange({ ...details, [key]: value });
  return (
    <>
      <Field label="Name">
        <Input value={details.name} onChange={(e) => set('name')(e.target.value)} />
      </Field>
      <Field
        label="Base model"
        hint={
          sourceBase
            ? `The source says "${sourceBase}". A LoRA only works with the model it was trained on.`
            : 'A LoRA only works with the model it was trained on.'
        }
      >
        <Select
          value={details.base || undefined}
          onValueChange={set('base')}
          placeholder="Choose the model it is for"
          options={bases.map((b) => ({
            value: b.id,
            label: b.label,
            description: b.recipes.length ? b.recipes.join(', ') : 'No recipe here runs it',
          }))}
        />
      </Field>
      <Field label="Trigger words" hint="One per line (a phrase may have commas). Put them in the prompt for the LoRA to take effect.">
        <Textarea rows={2} value={details.trigger_words} onChange={(e) => set('trigger_words')(e.target.value)} placeholder="none" />
      </Field>
      <Field label="Default strength" hint="1 is as trained; lower it if the LoRA overpowers the image. Each generation can change it.">
        <Input type="number" step={0.05} min={-4} max={4} value={details.strength} onChange={(e) => set('strength')(e.target.value)} />
      </Field>
      <Field label="Notes">
        <Textarea rows={3} value={details.description} onChange={(e) => set('description')(e.target.value)} />
      </Field>
    </>
  );
}

function detailsBody(details: Details) {
  const strength = Number(details.strength);
  return {
    name: details.name.trim() || undefined,
    base: details.base || undefined,
    trigger_words: details.trigger_words
      .split('\n')
      .map((w) => w.trim())
      .filter(Boolean),
    strength: Number.isFinite(strength) ? strength : undefined,
    description: details.description,
  };
}

function AddDialog({
  open,
  bases,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  bases: LoraBase[];
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [url, setUrl] = React.useState('');
  const [candidate, setCandidate] = React.useState<LoraCandidate>();
  const [picked, setPicked] = React.useState<string>();
  const [details, setDetails] = React.useState<Details>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();

  React.useEffect(() => {
    if (open) return;
    setUrl('');
    setCandidate(undefined);
    setPicked(undefined);
    setDetails(undefined);
    setError(undefined);
  }, [open]);

  const lookup = async (file?: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const found = await api.post<LoraCandidate>('/v1/loras/lookup', { url: url.trim(), file });
      setCandidate(found);
      setPicked(file);
      // A different file of the same repository keeps what was typed.
      setDetails((current) =>
        file && current
          ? current
          : {
              name: found.name,
              base: found.base ?? '',
              trigger_words: found.trigger_words.join('\n'),
              strength: '1',
              description: found.description ?? '',
            },
      );
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!candidate || !details) return;
    setBusy(true);
    setError(undefined);
    try {
      // The file as the source names it (a repository path), which `candidate.file` is not once renamed for disk.
      await api.post('/v1/loras', { url: url.trim(), file: picked, ...detailsBody(details) });
      onAdded();
      onOpenChange(false);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add a LoRA" description="From a Civitai page or download link, a Hugging Face repository or file, or any link to a .safetensors file.">
        <div className="flex flex-col gap-4 p-5">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void lookup();
            }}
          >
            <Input
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setCandidate(undefined);
              }}
              placeholder="https://civitai.com/models/…"
              autoFocus
            />
            <Button type="submit" variant="outline" disabled={busy || !url.trim()}>
              {busy && !candidate ? <Spinner /> : <Search />} Look up
            </Button>
          </form>

          {candidate && details ? (
            <>
              <div className="flex gap-3 rounded-md border border-border p-3">
                <Preview url={candidate.preview_url} className="size-20" />
                <div className="flex min-w-0 flex-col gap-1 text-xs">
                  <p className="truncate font-mono">{candidate.file}</p>
                  <p className="text-muted-foreground">
                    {SOURCE_LABEL[candidate.source]}
                    {candidate.bytes ? ` · ${formatBytes(candidate.bytes)}` : ''}
                  </p>
                  {candidate.page_url ? (
                    <a href={candidate.page_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                      Source page <ExternalLink className="size-3" />
                    </a>
                  ) : null}
                </div>
              </div>
              {candidate.existing ? <ErrorNote>This file is already in the library as “{candidate.existing}”.</ErrorNote> : null}
              {candidate.choices ? (
                <Field label="File" hint="This source has several; pick the LoRA to add.">
                  <Select
                    value={picked ?? candidate.source_file}
                    onValueChange={(file) => void lookup(file)}
                    options={candidate.choices.map((c) => ({ value: c.file, label: c.file, description: c.bytes ? formatBytes(c.bytes) : undefined }))}
                  />
                </Field>
              ) : null}
              <DetailFields details={details} bases={bases} sourceBase={candidate.source_base} onChange={setDetails} />
            </>
          ) : null}

          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {candidate && details ? (
            <Button onClick={() => void add()} disabled={busy || !details.base || Boolean(candidate.existing)}>
              {busy ? <Spinner /> : <Plus />} Add and download
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({
  lora,
  bases,
  onOpenChange,
  onSaved,
}: {
  lora: Lora | undefined;
  bases: LoraBase[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [details, setDetails] = React.useState<Details>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();

  React.useEffect(() => {
    setError(undefined);
    setDetails(
      lora && {
        name: lora.name,
        base: lora.base,
        trigger_words: lora.trigger_words.join('\n'),
        strength: String(lora.strength),
        description: lora.description,
      },
    );
  }, [lora]);

  const save = async () => {
    if (!lora || !details) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.patch(`/v1/loras/${lora.id}`, detailsBody(details));
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(lora)} onOpenChange={onOpenChange}>
      {lora && details ? (
        <DialogContent title={`Edit ${lora.name}`} description={lora.file}>
          <div className="flex flex-col gap-4 p-5">
            <DetailFields details={details} bases={bases} sourceBase={lora.source_base ?? undefined} onChange={setDetails} />
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Button onClick={() => void save()} disabled={busy || !details.base}>
              {busy ? <Spinner /> : null} Save
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function DeleteDialog({
  lora,
  onOpenChange,
  onDeleted,
}: {
  lora: Lora | undefined;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  React.useEffect(() => setError(undefined), [lora]);

  const confirm = async () => {
    if (!lora) return;
    setBusy(true);
    try {
      await api.delete(`/v1/loras/${lora.id}`);
      onDeleted();
      onOpenChange(false);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(lora)} onOpenChange={onOpenChange}>
      {lora ? (
        <DialogContent title={`Delete ${lora.name}`} description="Removes it from the library and its file from the data volume.">
          <div className="flex flex-col gap-4 p-5 text-xs">
            <p className="text-muted-foreground">
              Files already generated with it are kept. Adding it again downloads it again{lora.bytes ? ` (${formatBytes(lora.bytes)})` : ''}.
            </p>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
                {busy ? <Spinner /> : <Trash2 />} Delete
              </Button>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
