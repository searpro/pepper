import * as React from 'react';
import { Check, Eye, Plus, Sparkles, Star, Trash2, Wand2, X } from 'lucide-react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
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
  Textarea,
} from '@pepper/ui/components/ui';
import { api, ApiRequestError } from '@pepper/ui/lib/api';
import { cn } from '@pepper/ui/lib/utils';
import { MediaField } from '@/components/inputs';
import { LicenceNotice } from '@/components/licence';
import { SHOT_KINDS, isActive, type Asset, type DialogueLine, type Recipe, type Shot, type Take } from '@/lib/pro';

const AUTO = '__auto__';

function message(err: unknown): string {
  return err instanceof ApiRequestError ? err.error.message : String(err);
}

/**
 * One shot: what it is (direction, dialogue, cast, keyframes, recipe) and its
 * takes. Drafts are cheap and plural; the chosen draft is finished with its
 * own seed in the recipe's final mode.
 */
export function ShotDialog({
  shot,
  assets,
  recipes,
  onOpenChange,
  onChanged,
}: {
  shot: Shot | undefined;
  assets: Asset[];
  recipes: Recipe[];
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  return (
    <Dialog open={Boolean(shot)} onOpenChange={onOpenChange}>
      {shot ? (
        <DialogContent
          title={`Shot ${shot.position + 1} · ${shot.kind}`}
          description={shot.prompt.slice(0, 120) || 'No prompt yet'}
          className="[--dialog-w:64rem]"
        >
          <Tabs defaultValue={shot.takes.length ? 'takes' : 'shot'} className="flex flex-col gap-3 p-5">
            <TabsList>
              <TabsTrigger value="shot">Shot</TabsTrigger>
              <TabsTrigger value="takes">Takes ({shot.takes.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="shot">
              <ShotForm key={shot.id} shot={shot} assets={assets} recipes={recipes} onSaved={onChanged} />
            </TabsContent>
            <TabsContent value="takes">
              <Takes shot={shot} recipes={recipes} onChanged={onChanged} />
            </TabsContent>
          </Tabs>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function ShotForm({ shot, assets, recipes, onSaved }: { shot: Shot; assets: Asset[]; recipes: Recipe[]; onSaved: () => void }) {
  const [draft, setDraft] = React.useState(() => ({
    kind: shot.kind,
    durationS: shot.durationS,
    framing: shot.framing,
    camera: shot.camera,
    prompt: shot.prompt,
    dialogue: shot.dialogue,
    sound: shot.sound,
    assetIds: shot.assetIds,
    keyframes: shot.keyframes,
    audioAssetId: shot.audioAssetId,
    recipeId: shot.recipeId,
  }));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [preview, setPreview] = React.useState<unknown>();
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const cast = assets.filter((a) => ['character', 'location', 'prop', 'product', 'style'].includes(a.kind));
  const audio = assets.filter((a) => a.audio);
  const speakers = assets.filter((a) => a.kind === 'character' || a.voice);

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.patch(`/v1/shots/${shot.id}`, { ...draft, dialogue: draft.dialogue.filter((d) => d.line.trim()) });
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const showRequest = async () => {
    setError(undefined);
    try {
      setPreview(await api.get(`/v1/shots/${shot.id}/request`));
    } catch (err) {
      setError(message(err));
    }
  };

  const updateLine = (index: number, patch: Partial<DialogueLine>) =>
    set(
      'dialogue',
      draft.dialogue.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Kind" hint="Picks a recipe when none is set.">
          <Select value={draft.kind} onValueChange={(v) => set('kind', v)} options={SHOT_KINDS.map((k) => ({ value: k, label: k }))} />
        </Field>
        <Field label="Seconds">
          <Input type="number" min={0.5} max={600} step={0.5} value={draft.durationS} onChange={(e) => set('durationS', Number(e.target.value))} />
        </Field>
        <Field label="Framing">
          <Input value={draft.framing} placeholder="Medium close-up" onChange={(e) => set('framing', e.target.value)} />
        </Field>
        <Field label="Camera">
          <Input value={draft.camera} placeholder="Slow push-in" onChange={(e) => set('camera', e.target.value)} />
        </Field>
      </div>
      <Field label="Action" hint="What happens and how it looks; the project's look and the cast are added for you.">
        <Textarea rows={4} value={draft.prompt} onChange={(e) => set('prompt', e.target.value)} />
      </Field>

      <Field label="In this shot">
        <div className="flex flex-wrap gap-1.5">
          {cast.length === 0 ? <span className="text-xs text-muted-foreground">Add characters, places and products under Cast.</span> : null}
          {cast.map((asset) => {
            const on = draft.assetIds.includes(asset.id);
            return (
              <button
                key={asset.id}
                onClick={() => set('assetIds', on ? draft.assetIds.filter((id) => id !== asset.id) : [...draft.assetIds, asset.id])}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs',
                  on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground',
                )}
              >
                {asset.name}
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="Dialogue" hint="Spoken exactly as written, in the speaker's voice clip when the recipe takes one.">
        <div className="flex flex-col gap-2">
          {draft.dialogue.map((line, index) => (
            <div key={index} className="flex items-start gap-2">
              <Select
                className="w-40"
                value={line.asset_id}
                placeholder="Speaker"
                onValueChange={(v) => updateLine(index, { asset_id: v })}
                options={speakers.map((a) => ({ value: a.id, label: a.name }))}
              />
              <Input value={line.line} onChange={(e) => updateLine(index, { line: e.target.value })} />
              <Button variant="ghost" size="icon" aria-label="Remove line" onClick={() => set('dialogue', draft.dialogue.filter((_, i) => i !== index))}>
                <X />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" className="self-start" onClick={() => set('dialogue', [...draft.dialogue, { line: '' }])}>
            <Plus /> Line
          </Button>
        </div>
      </Field>

      <Field label="Sound" hint="Ambience and effects the recipe generates with the picture.">
        <Input value={draft.sound} onChange={(e) => set('sound', e.target.value)} />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First frame">
          <MediaField
            kind="image"
            value={draft.keyframes.first ? [draft.keyframes.first] : []}
            onChange={(names) => set('keyframes', { ...draft.keyframes, first: names[0] })}
          />
        </Field>
        <Field label="Last frame">
          <MediaField
            kind="image"
            value={draft.keyframes.last ? [draft.keyframes.last] : []}
            onChange={(names) => set('keyframes', { ...draft.keyframes, last: names[0] })}
          />
        </Field>
        <Field label="Driving audio" hint="A line or track the picture follows (lip-sync, performance).">
          <Select
            value={draft.audioAssetId ?? AUTO}
            onValueChange={(v) => set('audioAssetId', v === AUTO ? null : v)}
            options={[{ value: AUTO, label: 'None' }, ...audio.map((a) => ({ value: a.id, label: a.name }))]}
          />
        </Field>
        <Field label="Recipe">
          <Select
            value={draft.recipeId ?? AUTO}
            onValueChange={(v) => set('recipeId', v === AUTO ? null : v)}
            options={[
              { value: AUTO, label: 'Automatic (by shot kind)' },
              ...recipes.map((r) => ({ value: r.id, label: r.name, description: r.state === 'installed' ? undefined : 'not installed' })),
            ]}
          />
        </Field>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="flex gap-2">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? <Spinner /> : <Check />} Save
        </Button>
        <Button variant="outline" onClick={() => void showRequest()}>
          <Eye /> What will render
        </Button>
      </div>
      {preview ? (
        <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-[11px] leading-relaxed scrollbar-thin">{JSON.stringify(preview, null, 2)}</pre>
      ) : null}
    </div>
  );
}

function Takes({ shot, recipes, onChanged }: { shot: Shot; recipes: Recipe[]; onChanged: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const chosen = shot.takes.find((t) => t.id === shot.chosenTakeId);
  const recipe = recipes.find((r) => r.id === shot.recipeId);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  const render = (body: Record<string, unknown>) => act(() => api.post('/v1/shots/render', { shot_ids: [shot.id], ...body }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {[1, 2, 4].map((count) => (
          <Button key={count} variant={count === 2 ? 'default' : 'outline'} size="sm" disabled={busy} onClick={() => void render({ mode: 'draft', count })}>
            <Sparkles /> Draft ×{count}
          </Button>
        ))}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !chosen || chosen.status !== 'completed'}
          title={chosen ? 'Re-render the chosen take in final quality, same seed' : 'Choose a take first'}
          onClick={() => void render({ mode: 'final', from_take: chosen!.id })}
        >
          <Wand2 /> Finish chosen
        </Button>
        {busy ? <Spinner /> : null}
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {shot.takes.length === 0 ? <p className="text-xs text-muted-foreground">No takes yet. Draft a few and choose the best.</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shot.takes.map((take) => (
          <TakeCard key={take.id} take={take} chosen={take.id === shot.chosenTakeId} onChanged={onChanged} onError={setError} />
        ))}
      </div>
      <LicenceNotice licence={recipe?.licence} />
    </div>
  );
}

export function TakeMedia({ take, className }: { take: Take; className?: string }) {
  if (!take.url) return null;
  if (take.kind === 'image') return <img src={take.url} alt="" className={cn('w-full rounded-md', className)} />;
  if (take.kind === 'audio') return <audio src={take.url} controls className={cn('w-full', className)} />;
  return <video src={take.url} controls preload="metadata" className={cn('w-full rounded-md bg-black', className)} />;
}

function TakeCard({ take, chosen, onChanged, onError }: { take: Take; chosen: boolean; onChanged: () => void; onError: (e: string) => void }) {
  const run = (action: () => Promise<unknown>) => void action().then(onChanged, (err) => onError(message(err)));
  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border p-2', chosen ? 'border-primary ring-1 ring-primary' : 'border-border')}>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-1.5">
          <Badge variant={take.mode === 'final' ? 'primary' : 'default'}>{take.mode}</Badge>
          <Badge variant={take.status === 'failed' ? 'destructive' : take.status === 'completed' ? 'success' : 'outline'}>{take.status}</Badge>
        </div>
        <span className="font-mono text-muted-foreground" title="Seed">
          {take.seed ?? ''}
        </span>
      </div>
      {isActive(take.status) ? <Progress value={take.progress} indeterminate={take.status === 'queued'} /> : null}
      <TakeMedia take={take} />
      {take.error ? <ErrorNote>{take.error.message}</ErrorNote> : null}
      <div className="flex items-center justify-between gap-1">
        <div className="flex">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} aria-label={`Score ${n}`} onClick={() => run(() => api.patch(`/v1/takes/${take.id}`, { score: take.score === n ? null : n }))}>
              <Star className={cn('size-3.5', take.score && n <= take.score ? 'fill-[var(--warning)] text-[var(--warning)]' : 'text-muted-foreground/50')} />
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={chosen ? 'default' : 'outline'}
            disabled={take.status !== 'completed'}
            onClick={() => run(() => api.post(`/v1/takes/${take.id}/choose`, {}))}
          >
            <Check /> {chosen ? 'Chosen' : 'Choose'}
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Delete take" onClick={() => run(() => api.delete(`/v1/takes/${take.id}`))}>
            <Trash2 />
          </Button>
        </div>
      </div>
    </div>
  );
}
