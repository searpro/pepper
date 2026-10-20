import * as React from 'react';
import { AudioWaveform, Pencil, Plus, SplitSquareHorizontal, Trash2, Users } from 'lucide-react';
import { Badge, Button, Card, Dialog, DialogContent, EmptyState, ErrorNote, Field, Input, Select, Spinner, Textarea } from '@pepper/ui/components/ui';
import { MediaViewer } from '@pepper/ui/components/media';
import { api, ApiRequestError, waitForJob } from '@pepper/ui/lib/api';
import { MediaField, MediaThumb } from '@/components/inputs';
import { LoraRefs, type LoraRef } from '@/components/loras';
import { ASSET_KINDS, beatsOf, inputUrl, type Asset } from '@/lib/pro';

/** An asset's pictures, whole whatever their shape, each opening full size. */
function PictureStrip({ names }: { names: string[] }) {
  const [viewing, setViewing] = React.useState<number>();
  return (
    <div className="flex gap-1.5 overflow-x-auto scrollbar-thin">
      {names.map((name, index) => (
        <button key={name} type="button" className="shrink-0 rounded-md" onClick={() => setViewing(index)} aria-label="View full size" title="View full size">
          <MediaThumb name={name} kind="image" />
        </button>
      ))}
      <MediaViewer
        item={viewing !== undefined && names[viewing] ? { name: names[viewing], kind: 'image', size: 0, modified: '', url: inputUrl(names[viewing]) } : undefined}
        position={viewing !== undefined && names.length > 1 ? `${viewing + 1} of ${names.length}` : undefined}
        onPrev={viewing ? () => setViewing(viewing - 1) : undefined}
        onNext={viewing !== undefined && viewing < names.length - 1 ? () => setViewing(viewing + 1) : undefined}
        onClose={() => setViewing(undefined)}
      />
    </div>
  );
}

/**
 * A project's cast, places, products and sounds. Pictures are what reference
 * recipes see (and what keeps a character the same person across shots);
 * a voice clip is what a speaker sounds like.
 */
export function AssetsPanel({ projectId, assets, onChanged }: { projectId: string; assets: Asset[]; onChanged: () => void }) {
  const [editing, setEditing] = React.useState<Asset | 'new' | undefined>();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus /> Add
        </Button>
      </div>
      {assets.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No cast yet"
          description="Add the characters (with a few pictures and a voice clip each), places and products your shots use."
        />
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {assets.map((asset) => (
          <Card key={asset.id} className="flex flex-col gap-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className="truncate text-sm font-semibold">{asset.name}</h3>
                <Badge variant="outline">{asset.kind}</Badge>
                {asset.projectId === null ? <Badge>library</Badge> : null}
              </div>
              <div className="flex">
                <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(asset)}>
                  <Pencil />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Delete"
                  onClick={() => {
                    if (confirm(`Delete ${asset.name}?`)) void api.delete(`/v1/assets/${asset.id}`).then(onChanged);
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            {asset.images.length ? <PictureStrip names={asset.images} /> : null}
            {asset.description ? <p className="line-clamp-3 text-xs text-muted-foreground">{asset.description}</p> : null}
            {asset.loras?.length ? (
              <p className="text-[11px] text-muted-foreground">
                {asset.loras.length} LoRA{asset.loras.length === 1 ? '' : 's'}
              </p>
            ) : null}
            {asset.voice?.upload ? <MediaThumb name={asset.voice.upload} kind="audio" className="w-full" /> : null}
            {asset.audio ? <MediaThumb name={asset.audio} kind="audio" className="w-full" /> : null}
            {asset.audio ? <AudioTools asset={asset} onChanged={onChanged} /> : null}
          </Card>
        ))}
      </div>
      <AssetDialog
        projectId={projectId}
        asset={editing}
        onOpenChange={(open) => !open && setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
          onChanged();
        }}
      />
    </div>
  );
}

/**
 * Analysis for a track: its beats (so the cut can land on them) and its stems
 * (so a performance can lip-sync to the vocals alone). Both run as jobs; the
 * card updates when they finish.
 */
function AudioTools({ asset, onChanged }: { asset: Asset; onChanged: () => void }) {
  const [busy, setBusy] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  const beats = beatsOf(asset);

  const run = async (task: 'beats' | 'stems') => {
    setBusy(task);
    setError(undefined);
    try {
      const job = await api.post<{ id: string }>('/v1/analyze', { task, asset_id: asset.id });
      const done = await waitForJob(job.id, 1500);
      if (done.status === 'failed') setError(done.error?.message ?? 'Analysis failed');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : String(err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {beats ? <Badge variant="primary">{Math.round(beats.bpm)} bpm · {beats.beats.length} beats</Badge> : null}
        <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void run('beats')}>
          {busy === 'beats' ? <Spinner /> : <AudioWaveform />} {beats ? 'Re-find beats' : 'Find beats'}
        </Button>
        {asset.meta.stem ? null : (
          <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void run('stems')}>
            {busy === 'stems' ? <Spinner /> : <SplitSquareHorizontal />} Split vocals
          </Button>
        )}
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}

function AssetDialog({
  projectId,
  asset,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  asset: Asset | 'new' | undefined;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const existing = asset && asset !== 'new' ? asset : undefined;
  const [kind, setKind] = React.useState('character');
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [images, setImages] = React.useState<string[]>([]);
  const [voice, setVoice] = React.useState<string[]>([]);
  const [audio, setAudio] = React.useState<string[]>([]);
  const [loras, setLoras] = React.useState<LoraRef[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();

  React.useEffect(() => {
    setKind(existing?.kind ?? 'character');
    setName(existing?.name ?? '');
    setDescription(existing?.description ?? '');
    setImages(existing?.images ?? []);
    setVoice(existing?.voice?.upload ? [existing.voice.upload] : []);
    setAudio(existing?.audio ? [existing.audio] : []);
    setLoras(existing?.loras ?? []);
    setError(undefined);
  }, [asset]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true);
    setError(undefined);
    const body = {
      kind,
      name: name.trim(),
      description,
      images,
      voice: voice[0] ? { upload: voice[0] } : null,
      audio: audio[0] ?? null,
      loras,
    };
    try {
      if (existing) await api.patch(`/v1/assets/${existing.id}`, body);
      else await api.post(`/v1/projects/${projectId}/assets`, body);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(asset)} onOpenChange={onOpenChange}>
      <DialogContent title={existing ? `Edit ${existing.name}` : 'Add to the cast'}>
        <div className="flex flex-col gap-3 p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Kind">
              <Select value={kind} onValueChange={setKind} options={ASSET_KINDS.map((k) => ({ value: k, label: k }))} />
            </Field>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <Field label="Description" hint="Appearance, wardrobe, manner — written once, used in every shot they are in.">
            <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Pictures" hint="A clear face, a full body, a profile. Reference recipes use up to four per shot.">
            <MediaField kind="image" value={images} onChange={setImages} multiple max={16} />
          </Field>
          {kind === 'character' || kind === 'voice' ? (
            <Field label="Voice clip" hint="5-15 s of clean speech.">
              <MediaField kind="audio" value={voice} onChange={setVoice} />
            </Field>
          ) : null}
          {kind === 'audio' || kind === 'voice' ? (
            <Field label="Audio" hint="A recorded line or a track shots can be driven by, or the cut's music.">
              <MediaField kind="audio" value={audio} onChange={setAudio} />
            </Field>
          ) : null}
          <Field
            label="LoRAs"
            hint="Used in every shot this is in, by the recipes each LoRA was made for: a character can have one per model."
          >
            <LoraRefs value={loras} onChange={setLoras} />
          </Field>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <Button onClick={() => void save()} disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : null} Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
