import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AudioLines,
  Ban,
  Check,
  Copy,
  Image as ImageIcon,
  ImagePlus,
  Mic,
  Play,
  Plus,
  Sparkles,
  Star,
  Trash2,
  UserRound,
  Users,
  Video,
  Wand2,
} from 'lucide-react';
import {
  api,
  useEventStream,
  useResource,
  type BundleInfo,
  type Job,
} from '@/lib/api';
import { copyText, inputUrl, setVideoHandoff } from '@/lib/images';
import {
  ROLE_LABELS,
  primaryImage,
  sheetImage,
  type Character,
  type CharacterDesign,
  type CharacterImageRole,
  type CharacterVoice,
} from '@/lib/characters';
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
  Switch,
  Textarea,
} from '@/components/ui';
import { Page } from '@/components/layout';
import { CharacterAvatar, useCharacters } from '@/components/CharacterPicker';
import { ImagePickerDialog } from '@/components/ImagePicker';
import { cn, timeAgo } from '@/lib/utils';

/**
 * The Character Studio: create a character from a one-line idea, generate its
 * reference sheet and portraits, give it a voice, and hand it to the Image,
 * Video and Audio screens.
 *
 * "Design" runs the server's designer system prompt on an installed LLM,
 * turning the idea into the precise visual description every later prompt
 * reuses; the sheet itself is a fixed layout template filled with that
 * description (`GET /v1/characters/prompts` shows both).
 */

const STORE_SELECTED = 'pepper-studio-character';
/** The keys the generation screens keep their chosen character under. */
export const CHARACTER_KEYS = {
  image: 'pepper-character-image',
  video: 'pepper-character-video',
  audio: 'pepper-character-audio',
} as const;

interface VoiceRef {
  name: string;
  url: string;
}

export function CharactersPage() {
  const cast = useCharacters();
  const characters = cast.data?.characters ?? [];
  const [selectedId, setSelectedId] = React.useState<string | undefined>(() => {
    try {
      return localStorage.getItem(STORE_SELECTED) ?? undefined;
    } catch {
      return undefined;
    }
  });
  const [creating, setCreating] = React.useState(false);

  React.useEffect(() => {
    try {
      if (selectedId) localStorage.setItem(STORE_SELECTED, selectedId);
    } catch {
      // Storage disabled.
    }
  }, [selectedId]);

  const selected = characters.find((character) => character.id === selectedId) ?? characters[0];

  // A studio job finishing is what attaches its image; refresh when one does.
  useEventStream(
    '/v1/jobs/stream',
    (event, data) => {
      const job = data as Job;
      if (job?.params?.character_id && (event === 'completed' || event === 'failed')) {
        // The server attaches the output in its own completion handler; give it
        // a beat before reading the character back.
        setTimeout(cast.reload, 400);
      }
    },
    ['completed', 'failed'],
  );

  return (
    <Page
      title="Character Studio"
      description="A reusable cast. Describe a character in a line, generate its reference sheet and portraits, give it a voice — then pick it on the Image, Video and Audio screens."
    >
      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* Cast */}
        <Card className="flex h-fit flex-col gap-3 p-3 lg:sticky lg:top-[4.5rem]">
          <Button onClick={() => setCreating(true)}>
            <Plus /> New character
          </Button>
          {cast.loading ? (
            <Spinner />
          ) : characters.length === 0 ? (
            <p className="px-1 py-4 text-center text-xs text-muted-foreground">
              No characters yet.
            </p>
          ) : (
            <div className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto scrollbar-thin">
              {characters.map((character) => (
                <button
                  key={character.id}
                  type="button"
                  onClick={() => setSelectedId(character.id)}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md p-1.5 text-left transition hover:bg-accent',
                    selected?.id === character.id && 'bg-primary/10 hover:bg-primary/10',
                  )}
                >
                  <CharacterAvatar character={character} className="size-10" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">{character.name}</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {character.pending.length > 0
                        ? 'Generating…'
                        : `${character.images.length} image${character.images.length === 1 ? '' : 's'}${character.voice?.model ? ' · voice' : ''}`}
                    </span>
                  </span>
                  {character.pending.length > 0 ? <Spinner className="ml-auto size-3" /> : null}
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* Editor */}
        {selected ? (
          <CharacterEditor
            key={selected.id}
            character={selected}
            onChanged={cast.reload}
            onDeleted={() => {
              setSelectedId(undefined);
              cast.reload();
            }}
          />
        ) : (
          <Card className="p-8">
            <EmptyState
              icon={Users}
              title="Start your cast"
              description="Type a one-line idea — “a grumpy dwarf blacksmith with a mechanical arm” — and Pepper designs the character, writes its description and voice, and draws its reference sheet."
            />
            <div className="mt-4 flex justify-center">
              <Button onClick={() => setCreating(true)}>
                <Sparkles /> Create a character
              </Button>
            </div>
          </Card>
        )}
      </div>

      <NewCharacterDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(character) => {
          setSelectedId(character.id);
          cast.reload();
        }}
      />
    </Page>
  );
}

// --- Creating ------------------------------------------------------------------

function useModels(kind: 'image' | 'llm' | 'audio') {
  const models = useResource<{ models: BundleInfo[] }>(`/v1/models?kind=${kind}`);
  return React.useMemo(
    () => (models.data?.models ?? []).filter((model) => model.ready),
    [models.data],
  );
}

function NewCharacterDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (character: Character) => void;
}) {
  const llms = useModels('llm');
  const imageModels = useModels('image');
  const audioModels = useModels('audio').filter((m) => (m.manifest?.task as string) !== 'asr');
  const [brief, setBrief] = React.useState('');
  const [name, setName] = React.useState('');
  const [style, setStyle] = React.useState('');
  const [llm, setLlm] = React.useState('auto');
  const [generateSheet, setGenerateSheet] = React.useState(true);
  const [imageModel, setImageModel] = React.useState('');
  const [busy, setBusy] = React.useState<string>();
  const [error, setError] = React.useState<string>();

  React.useEffect(() => {
    if (!imageModel && imageModels.length > 0) setImageModel(imageModels[0].id);
  }, [imageModels, imageModel]);

  const create = async () => {
    setError(undefined);
    try {
      setBusy(llm === 'none' ? 'Creating…' : 'Designing the character…');
      const design = await api.post<CharacterDesign>('/v1/characters/design', {
        brief,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(style.trim() ? { style: style.trim() } : {}),
        ...(llm !== 'auto' ? { model: llm } : {}),
      });
      // A voice-design model speaks from a direction, which the designer wrote;
      // any other model needs the user to pick a speaker or reference first.
      const voiceModel = audioModels.find((m) =>
        ['vdes', 'voice-design'].includes(m.manifest?.task as string),
      );
      const voice: CharacterVoice | null =
        design.voice && voiceModel ? { model: voiceModel.id, instructions: design.voice } : null;
      setBusy('Saving…');
      const character = await api.post<Character>('/v1/characters', {
        name: design.name || name.trim() || 'Untitled character',
        brief,
        style: design.style,
        appearance: design.appearance,
        personality: design.personality,
        voice,
      });
      if (generateSheet && imageModel) {
        setBusy('Queueing the sheet…');
        await api.post(`/v1/characters/${character.id}/generate`, {
          role: 'sheet',
          model: imageModel,
        });
      }
      onCreated(character);
      onOpenChange(false);
      setBrief('');
      setName('');
      setStyle('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          title="New character"
          description="A line is enough. The designer fills in the look, the style and the voice; you can edit all of it afterwards."
          className="[--dialog-w:36rem]"
        >
          <div className="flex flex-col gap-4 p-5">
            <Field label="Idea">
              <Textarea
                autoFocus
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && brief.trim()) {
                    event.preventDefault();
                    void create();
                  }
                }}
                rows={3}
                placeholder="A grumpy dwarf blacksmith with a mechanical arm"
                className="text-[15px]"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name" hint="Optional — invented if blank.">
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field label="Style" hint="Optional, e.g. anime, photoreal.">
                <Input value={style} onChange={(event) => setStyle(event.target.value)} />
              </Field>
            </div>
            <Field
              label="Designer"
              hint={
                llms.length === 0
                  ? 'No text model installed: the idea goes into the sheet template as written. Install one from Models for a full design.'
                  : 'The LLM that expands the idea into a detailed description and voice.'
              }
            >
              <Select
                value={llm}
                onValueChange={setLlm}
                options={[
                  { value: 'auto', label: llms[0] ? `Auto (${llms[0].name})` : 'Auto' },
                  ...llms.map((model) => ({ value: model.id, label: model.name })),
                  { value: 'none', label: 'No LLM — use my idea as written' },
                ]}
              />
            </Field>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
              <span className="flex flex-col">
                <span className="text-sm font-medium">Generate the character sheet now</span>
                <span className="text-[11px] text-muted-foreground">
                  Face close-ups and full-body views, front and side.
                </span>
              </span>
              <Switch checked={generateSheet} onCheckedChange={setGenerateSheet} />
            </label>
            {generateSheet ? (
              <Field label="Image model">
                {imageModels.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No image models installed.</p>
                ) : (
                  <Select
                    value={imageModel}
                    onValueChange={setImageModel}
                    options={imageModels.map((model) => ({ value: model.id, label: model.name }))}
                  />
                )}
              </Field>
            ) : null}
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Button onClick={() => void create()} disabled={!brief.trim() || busy !== undefined}>
              {busy ? <Spinner className="size-4" /> : <Sparkles />}
              {busy ?? 'Create character'}
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

// --- Editing -------------------------------------------------------------------

function CharacterEditor({
  character,
  onChanged,
  onDeleted,
}: {
  character: Character;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const navigate = useNavigate();
  const [error, setError] = React.useState<string>();

  const save = async (patch: Partial<Character>) => {
    setError(undefined);
    try {
      await api.patch(`/v1/characters/${character.id}`, patch);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const useIn = (screen: keyof typeof CHARACTER_KEYS) => {
    try {
      localStorage.setItem(CHARACTER_KEYS[screen], character.id);
    } catch {
      // Storage disabled: the screen opens without the character.
    }
    // Video starts from the character's portrait rather than whatever frame
    // the screen had last.
    const image = primaryImage(character);
    if (screen === 'video' && image) setVideoHandoff({ init: image });
    navigate(`/${screen}`);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <CharacterAvatar character={character} className="size-14" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <InlineName value={character.name} onSave={(name) => void save({ name })} />
          <span className="text-[11px] text-muted-foreground">
            Updated {timeAgo(character.updatedAt)} · {character.images.length} image
            {character.images.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={() => useIn('image')}>
            <ImageIcon /> Image
          </Button>
          <Button size="sm" variant="outline" onClick={() => useIn('video')}>
            <Video /> Video
          </Button>
          <Button size="sm" variant="outline" onClick={() => useIn('audio')}>
            <AudioLines /> Audio
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10"
            onClick={async () => {
              if (!window.confirm(`Delete ${character.name}? Its image files stay in Uploads.`)) return;
              await api.delete(`/v1/characters/${character.id}`);
              onDeleted();
            }}
          >
            <Trash2 />
          </Button>
        </div>
      </Card>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
        <ImagesCard character={character} onChanged={onChanged} />
        <div className="flex flex-col gap-4">
          <DesignCard character={character} onSave={save} />
          <VoiceCard character={character} onSave={save} onChanged={onChanged} />
        </div>
      </div>
    </div>
  );
}

function InlineName({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  return (
    <input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft.trim() && draft !== value && onSave(draft.trim())}
      onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
      aria-label="Character name"
      className="-ml-1 min-w-0 rounded bg-transparent px-1 text-lg font-semibold outline-none hover:bg-accent focus:bg-accent"
    />
  );
}

/** Text that saves when it loses focus, so editing never needs a Save button. */
function useDraft(value: string, onSave: (value: string) => void) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  return {
    value: draft,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(event.target.value),
    onBlur: () => {
      if (draft !== value) onSave(draft);
    },
  };
}

function DesignCard({
  character,
  onSave,
}: {
  character: Character;
  onSave: (patch: Partial<Character>) => Promise<void>;
}) {
  const llms = useModels('llm');
  const [llm, setLlm] = React.useState('auto');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [copied, setCopied] = React.useState(false);
  const prompts = useResource<{ sheet_prompt: string }>(`/v1/characters/${character.id}`);

  const brief = useDraft(character.brief, (value) => void onSave({ brief: value }));
  const style = useDraft(character.style, (value) => void onSave({ style: value }));
  const appearance = useDraft(character.appearance, (value) => void onSave({ appearance: value }));
  const personality = useDraft(character.personality, (value) => void onSave({ personality: value }));

  React.useEffect(() => prompts.reload(), [character.updatedAt, prompts.reload]);

  const redesign = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const design = await api.post<CharacterDesign>('/v1/characters/design', {
        brief: brief.value || character.name,
        name: character.name,
        ...(style.value.trim() ? { style: style.value.trim() } : {}),
        ...(llm !== 'auto' ? { model: llm } : {}),
      });
      if (design.source === 'template') {
        setError('No text model was available, so nothing was expanded. Install an LLM from Models.');
        return;
      }
      await onSave({
        brief: brief.value,
        style: design.style,
        appearance: design.appearance,
        personality: design.personality,
        ...(design.voice
          ? { voice: { ...(character.voice ?? {}), instructions: design.voice } }
          : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Wand2 className="size-4 text-primary" /> Design
      </h3>
      <Field label="Idea">
        <Textarea {...brief} rows={2} placeholder="A one-line idea for the character" />
      </Field>
      <div className="flex gap-2">
        <Select
          value={llm}
          onValueChange={setLlm}
          options={[
            { value: 'auto', label: llms[0] ? `Auto (${llms[0].name})` : 'Auto' },
            ...llms.map((model) => ({ value: model.id, label: model.name })),
          ]}
          className="flex-1"
        />
        <Button variant="outline" onClick={() => void redesign()} disabled={busy || llms.length === 0}>
          {busy ? <Spinner className="size-4" /> : <Sparkles />} Redesign
        </Button>
      </div>
      <Field label="Style">
        <Input {...style} placeholder="e.g. stylised 3D animated film" />
      </Field>
      <Field
        label="Appearance"
        hint="Added to every prompt this character appears in, on every screen. Keep it visual."
      >
        <Textarea {...appearance} rows={7} className="text-[13px]" />
      </Field>
      <Field label="Personality">
        <Textarea {...personality} rows={2} />
      </Field>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <details className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          Sheet prompt
        </summary>
        <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">
          {prompts.data?.sheet_prompt}
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="mt-1"
          onClick={() =>
            void copyText(prompts.data?.sheet_prompt ?? '').then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check /> : <Copy />} Copy
        </Button>
      </details>
    </Card>
  );
}

function ImagesCard({ character, onChanged }: { character: Character; onChanged: () => void }) {
  const imageModels = useModels('image');
  const [model, setModel] = React.useState(() => {
    try {
      return localStorage.getItem('pepper-studio-image-model') ?? '';
    } catch {
      return '';
    }
  });
  const [fromSheet, setFromSheet] = React.useState(true);
  const [size, setSize] = React.useState<SizeKey>('standard');
  const [picker, setPicker] = React.useState<CharacterImageRole | null>(null);
  const [error, setError] = React.useState<string>();
  const [jobs, setJobs] = React.useState<Record<string, Job>>({});

  React.useEffect(() => {
    if (imageModels.length > 0 && !imageModels.some((m) => m.id === model)) {
      setModel(imageModels[0].id);
    }
  }, [imageModels, model]);
  React.useEffect(() => {
    try {
      if (model) localStorage.setItem('pepper-studio-image-model', model);
    } catch {
      // Storage disabled.
    }
  }, [model]);

  // Progress for this character's pending generations.
  useEventStream(
    character.pending.length > 0 ? '/v1/jobs/stream' : null,
    (_event, data) => {
      const job = data as Job;
      if (job?.params?.character_id === character.id) {
        setJobs((current) => ({ ...current, [job.id]: job }));
      }
    },
    ['created', 'updated', 'progress', 'completed', 'failed'],
  );

  const hasSheet = Boolean(sheetImage(character));

  const generate = async (role: 'sheet' | 'portrait') => {
    setError(undefined);
    try {
      const [width, height] = SIZES[size][role];
      const job = await api.post<Job>(`/v1/characters/${character.id}/generate`, {
        role,
        model,
        width,
        height,
        ...(role === 'portrait' ? { from_sheet: fromSheet && hasSheet } : {}),
      });
      setJobs((current) => ({ ...current, [job.id]: job }));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const act = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pendingImages = character.pending.filter((entry) => entry.role !== 'voice_sample');
  const sorted = [...character.images].sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || b.addedAt.localeCompare(a.addedAt),
  );

  return (
    <Card className="flex h-fit flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ImageIcon className="size-4 text-primary" /> Sheet &amp; portraits
        </h3>
        <span className="text-[11px] text-muted-foreground">
          The starred image is the thumbnail the pickers show.
        </span>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
          <Field label="Image model">
            {imageModels.length === 0 ? (
              <p className="text-xs text-muted-foreground">No image models installed.</p>
            ) : (
              <Select
                value={model}
                onValueChange={setModel}
                options={imageModels.map((m) => ({ value: m.id, label: m.name }))}
              />
            )}
          </Field>
          <Field label="Size">
            <Select
              value={size}
              onValueChange={(value) => setSize(value as SizeKey)}
              options={(Object.keys(SIZES) as SizeKey[]).map((key) => ({
                value: key,
                label: SIZES[key].label,
                description: `sheet ${SIZES[key].sheet.join('×')} · portrait ${SIZES[key].portrait.join('×')}`,
              }))}
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void generate('sheet')} disabled={!model}>
            <Sparkles /> {hasSheet ? 'New sheet' : 'Generate sheet'}
          </Button>
          <Button variant="outline" onClick={() => void generate('portrait')} disabled={!model}>
            <UserRound /> Portrait
          </Button>
          <Button variant="outline" onClick={() => setPicker('reference')}>
            <ImagePlus /> Add image
          </Button>
        </div>
        {hasSheet ? (
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Switch checked={fromSheet} onCheckedChange={setFromSheet} />
            Draw portraits from the sheet (reference image) — for edit-capable models such as
            FLUX.2 or Qwen-Image-Edit; turn off for text-only models.
          </label>
        ) : null}
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {pendingImages.length > 0 ? (
        <div className="flex flex-col gap-2">
          {pendingImages.map((entry) => {
            const job = jobs[entry.jobId];
            return (
              <div key={entry.jobId} className="flex items-center gap-3 rounded-md border border-border p-2.5">
                <Spinner className="size-3.5" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-xs">
                    Generating {ROLE_LABELS[entry.role as CharacterImageRole].toLowerCase()}
                    {job?.status === 'queued' ? ' · queued' : ''}
                    {/* sd-cli's weight-loading bar arrives through the same step
                        counter as sampling, so only the percentage is shown. */}
                    {job?.status === 'running' ? ` · ${Math.round(job.progress * 100)}%` : ''}
                  </span>
                  <Progress
                    value={job?.progress ?? 0}
                    indeterminate={!job || job.status === 'queued' || !job.totalSteps}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Cancel"
                  onClick={() => void act(() => api.post(`/v1/jobs/${entry.jobId}/cancel`))}
                >
                  <Ban />
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}

      {sorted.length === 0 && pendingImages.length === 0 ? (
        <EmptyState
          icon={ImageIcon}
          title="No images yet"
          description="Generate the character sheet first; portraits and the pickers' thumbnail come from it."
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {sorted.map((image) => (
            <figure
              key={image.name}
              className={cn(
                'group relative overflow-hidden rounded-lg border border-border bg-muted',
                image.role === 'sheet' && 'col-span-2 md:col-span-3',
              )}
            >
              <a href={inputUrl(image.name)} target="_blank" rel="noreferrer">
                <img
                  src={inputUrl(image.name)}
                  alt={ROLE_LABELS[image.role]}
                  loading="lazy"
                  className={cn(
                    'w-full object-cover',
                    image.role === 'sheet' ? 'max-h-[520px] object-contain' : 'aspect-[4/5] object-top',
                  )}
                />
              </a>
              <figcaption className="absolute inset-x-0 top-0 flex items-center justify-between gap-1 bg-gradient-to-b from-black/60 to-transparent p-1.5">
                <Badge variant="default" className="bg-black/50 text-white">
                  {ROLE_LABELS[image.role]}
                </Badge>
                <span className="flex gap-1 opacity-90 transition group-hover:opacity-100">
                  <IconAction
                    label={character.thumbnail === image.name ? 'Thumbnail' : 'Use as thumbnail'}
                    active={character.thumbnail === image.name}
                    onClick={() =>
                      void act(() =>
                        api.patch(`/v1/characters/${character.id}`, { thumbnail: image.name }),
                      )
                    }
                  >
                    <Star className={cn('size-3.5', character.thumbnail === image.name && 'fill-current')} />
                  </IconAction>
                  <IconAction
                    label="Remove from character"
                    onClick={() =>
                      void act(() =>
                        api.delete(
                          `/v1/characters/${character.id}/images/${encodeURIComponent(image.name)}`,
                        ),
                      )
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </IconAction>
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      <ImagePickerDialog
        open={picker !== null}
        onOpenChange={(open) => !open && setPicker(null)}
        title="Add images to the character"
        max={8}
        onPick={(names) =>
          void act(async () => {
            for (const name of names) {
              await api.post(`/v1/characters/${character.id}/images`, {
                name,
                source: 'upload',
                role: character.images.some((image) => image.role === 'sheet') ? 'reference' : 'sheet',
              });
            }
          })
        }
      />
    </Card>
  );
}

/** Radix Select reserves the empty string for "no selection", so "none" needs a value of its own. */
const NONE = '__none';

const ROLE_ORDER: Record<CharacterImageRole, number> = { sheet: 0, portrait: 1, reference: 2 };

/** Sheet / portrait sizes per quality. Sheets are wide (four views in a row), portraits tall. */
const SIZES = {
  draft: { label: 'Draft', sheet: [1024, 576], portrait: [640, 800] },
  standard: { label: 'Standard', sheet: [1280, 720], portrait: [768, 960] },
  high: { label: 'High · slow', sheet: [1536, 864], portrait: [896, 1120] },
} as const;
type SizeKey = keyof typeof SIZES;

function IconAction({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'rounded-md bg-black/55 p-1 text-white transition hover:bg-black/75',
        active && 'text-yellow-300',
      )}
    >
      {children}
    </button>
  );
}

function VoiceCard({
  character,
  onSave,
  onChanged,
}: {
  character: Character;
  onSave: (patch: Partial<Character>) => Promise<void>;
  onChanged: () => void;
}) {
  const models = useModels('audio').filter((m) => (m.manifest?.task as string) !== 'asr');
  const voiceRefs = useResource<{ voiceRefs: VoiceRef[] }>('/v1/audio/voice-refs');
  const voice = character.voice ?? {};
  const model = models.find((m) => m.id === voice.model);
  const isDesign = ['vdes', 'voice-design'].includes(model?.manifest?.task as string);
  const speakers = useResource<{ voices: string[] }>(
    voice.model ? `/v1/audio/voices?model=${encodeURIComponent(voice.model)}` : null,
  );
  const [text, setText] = React.useState('');
  const [previewJob, setPreviewJob] = React.useState<Job>();
  const [error, setError] = React.useState<string>();

  const setVoice = (patch: Partial<CharacterVoice>) =>
    void onSave({ voice: { ...voice, ...patch, sample: patch.sample ?? voice.sample } });

  const instructions = useDraft(voice.instructions ?? '', (value) => setVoice({ instructions: value }));

  useEventStream(
    previewJob && (previewJob.status === 'queued' || previewJob.status === 'running')
      ? '/v1/jobs/stream'
      : null,
    (_event, data) => {
      const job = data as Job;
      if (job?.id !== previewJob?.id) return;
      setPreviewJob(job);
      if (job.status === 'completed' || job.status === 'failed') setTimeout(onChanged, 400);
      if (job.status === 'failed') setError(job.error?.message ?? 'Preview failed');
    },
    ['updated', 'completed', 'failed'],
  );

  const preview = async () => {
    setError(undefined);
    try {
      setPreviewJob(
        await api.post<Job>(`/v1/characters/${character.id}/voice/preview`, {
          ...(text.trim() ? { text: text.trim() } : {}),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const previewing = previewJob?.status === 'queued' || previewJob?.status === 'running';

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Mic className="size-4 text-primary" /> Voice
      </h3>
      {models.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No speech models installed. Install a TTS or voice-design model from Models.
        </p>
      ) : (
        <>
          <Field label="Speech model">
            <Select
              value={voice.model ?? NONE}
              onValueChange={(value) =>
                // A speaker picked for one model means nothing to the next.
                setVoice({ model: value === NONE ? undefined : value, voice: undefined })
              }
              options={[
                { value: NONE, label: 'No voice' },
                ...models.map((m) => ({
                  value: m.id,
                  label: m.name,
                  description: (m.manifest?.task as string) === 'vdes' ? 'voice design' : undefined,
                })),
              ]}
              placeholder="No voice"
            />
          </Field>
          {voice.model ? (
            <>
              {isDesign || voice.instructions ? (
                <Field
                  label="Voice direction"
                  hint={
                    isDesign
                      ? 'The voice-design model synthesises the speaker from this.'
                      : 'Style instructions, for models that take them.'
                  }
                >
                  <Textarea {...instructions} rows={3} />
                </Field>
              ) : null}
              {(speakers.data?.voices.length ?? 0) > 0 ? (
                <Field label="Speaker">
                  <Select
                    value={voice.voice ?? NONE}
                    onValueChange={(value) => setVoice({ voice: value === NONE ? undefined : value })}
                    options={[
                      { value: NONE, label: 'Model default' },
                      ...speakers.data!.voices.map((name) => ({ value: name, label: name })),
                    ]}
                  />
                </Field>
              ) : null}
              <Field label="Voice reference" hint="A clip to clone, for cloning models. Upload clips on the Audio screen.">
                <Select
                  value={voice.voice_ref ?? NONE}
                  onValueChange={(value) => setVoice({ voice_ref: value === NONE ? undefined : value })}
                  options={[
                    { value: NONE, label: 'None' },
                    ...(voiceRefs.data?.voiceRefs ?? []).map((ref) => ({
                      value: ref.name,
                      label: ref.name,
                    })),
                  ]}
                />
              </Field>
              <Field label="Preview line">
                <Input
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder={voice.sample_text ?? `Hello, I'm ${character.name}.`}
                />
              </Field>
              <Button variant="outline" onClick={() => void preview()} disabled={previewing}>
                {previewing ? <Spinner className="size-4" /> : <Play />}
                {previewing ? 'Speaking…' : 'Preview voice'}
              </Button>
              {voice.sample ? (
                <audio key={voice.sample} src={inputUrl(voice.sample)} controls className="w-full" />
              ) : null}
            </>
          ) : null}
        </>
      )}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </Card>
  );
}
