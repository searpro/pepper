import * as React from 'react';
import {
  Ban,
  Dice5,
  Download,
  History,
  Image as ImageIcon,
  ImagePlus,
  Info,
  Layers,
  Maximize2,
  RotateCcw,
  Shuffle,
  Sparkles,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import {
  api,
  useEventStream,
  useResource,
  type BundleInfo,
  type Job,
  type MediaItem,
} from '@/lib/api';
import {
  inputUrl,
  outputToInput,
  settingsOf,
  takeHandoff,
  upscale,
  type ImageSettings,
  type OutputInfo,
  type UpscalerInfo,
} from '@/lib/images';
import {
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Progress,
  Select,
  Slider,
  Spinner,
  Switch,
  Textarea,
} from '@/components/ui';
import { Page } from '@/components/layout';
import { ImageDetailsDialog } from '@/components/ImageDetails';
import { ImagePickerDialog } from '@/components/ImagePicker';
import { AspectChip, FileButton, InputThumb, useElapsed } from '@/components/studio';
import { CharacterField, useChosenCharacter } from '@/components/CharacterPicker';
import { primaryImage, withCharacter } from '@/lib/characters';
import { cn, formatDuration, timeAgo } from '@/lib/utils';

/**
 * The image studio: text-to-image and edit, laid out after the Qwen Image
 * Studio UI — a Generate/Edit switch, aspect chips plus a resolution instead
 * of raw width/height, speed presets instead of a bare steps slider, the
 * rarely-touched knobs folded under Advanced, and a large viewer with the
 * run's progress on top of it.
 *
 * Every image on the screen opens the same details popup as the Media page,
 * which is where reuse, copy-settings and upscaling live.
 */

const SAMPLERS = [
  'euler',
  'euler_a',
  'heun',
  'dpm2',
  'dpm++2s_a',
  'dpm++2m',
  'dpm++2mv2',
  'ipndm',
  'ipndm_v',
  'lcm',
  'ddim_trailing',
  'tcd',
];

type Mode = 'generate' | 'edit';
type Speed = 'fast' | 'balanced' | 'quality';

const ASPECTS: Record<string, [number, number]> = {
  '1:1': [1, 1],
  '4:3': [4, 3],
  '3:4': [3, 4],
  '3:2': [3, 2],
  '2:3': [2, 3],
  '16:9': [16, 9],
  '9:16': [9, 16],
};

const RESOLUTIONS = [
  { value: 512, note: 'fastest' },
  { value: 768, note: 'draft' },
  { value: 1024, note: 'standard' },
  { value: 1280, note: 'more detail' },
  { value: 1536, note: 'slow' },
];

const SPEEDS: Record<Speed, { label: string; factor: number }> = {
  fast: { label: 'Fast', factor: 0.5 },
  balanced: { label: 'Balanced', factor: 1 },
  quality: { label: 'Quality', factor: 1.5 },
};

const MAX_REFS = 16;

interface FormState {
  mode: Mode;
  model: string;
  prompt: string;
  negative_prompt: string;
  /** An `ASPECTS` key, `match` (follow the first input image) or `custom`. */
  aspect: string;
  resolution: number;
  customWidth: number;
  customHeight: number;
  speed: Speed;
  /** Explicit overrides; `null` means "the preset / the model's default". */
  steps: number | null;
  cfg_scale: number | null;
  sampler: string | null;
  seed: number;
  batch: number;
  init_image?: string;
  strength: number;
  ref_images: string[];
  img_cfg_scale: number;
  increase_ref_index: boolean;
  /** Fold the chosen character's description into the prompt. */
  characterPrompt: boolean;
  /** Send one of the character's images as reference image 1. */
  characterRef: boolean;
  characterImage?: string;
}

const DEFAULTS: FormState = {
  mode: 'generate',
  model: '',
  prompt: '',
  negative_prompt: '',
  aspect: '1:1',
  resolution: 1024,
  customWidth: 1024,
  customHeight: 1024,
  speed: 'balanced',
  steps: null,
  cfg_scale: null,
  sampler: null,
  seed: -1,
  batch: 1,
  strength: 0.75,
  ref_images: [],
  img_cfg_scale: 1,
  increase_ref_index: false,
  characterPrompt: true,
  characterRef: false,
};

const STORE_KEY = 'pepper-image-form';

function loadForm(): FormState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<FormState>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

/** Width × height with roughly `res²` pixels at the given aspect, in multiples of 16. */
function fit(aw: number, ah: number, res: number): [number, number] {
  const ratio = aw / ah;
  const h = Math.sqrt((res * res) / ratio);
  const w = h * ratio;
  return [Math.max(256, Math.round(w / 16) * 16), Math.max(256, Math.round(h / 16) * 16)];
}

interface ModelDefaults {
  steps?: number;
  cfg_scale?: number;
  sampler?: string;
  width?: number;
  height?: number;
}

function modelDefaults(model: BundleInfo | undefined): ModelDefaults {
  return ((model?.manifest as { defaults?: ModelDefaults } | null)?.defaults ??
    {}) as ModelDefaults;
}

function presetSteps(defaults: ModelDefaults, speed: Speed): number {
  const base = defaults.steps ?? 20;
  return Math.max(1, Math.round(base * SPEEDS[speed].factor));
}

/** Output name from a completed job's result URL. */
function outputOf(job: Job): MediaItem | null {
  const url = job.result?.image_url;
  if (typeof url !== 'string') return null;
  return {
    name: decodeURIComponent(url.split('/').pop()!),
    kind: 'image',
    size: 0,
    modified: job.finishedAt ?? new Date().toISOString(),
    url,
  };
}

export function ImagePage() {
  const models = useResource<{ models: BundleInfo[] }>('/v1/models?kind=image');
  const recent = useResource<{ outputs: MediaItem[] }>('/v1/outputs?kind=image&limit=48');
  const upscalers = useResource<UpscalerInfo>('/v1/upscalers');

  const [form, setForm] = React.useState<FormState>(loadForm);
  const { character, setCharacter } = useChosenCharacter('pepper-character-image');
  const characterImage =
    character &&
    (character.images.some((image) => image.name === form.characterImage)
      ? form.characterImage
      : primaryImage(character));
  const characterRefs = character && form.characterRef && characterImage ? [characterImage] : [];
  const [error, setError] = React.useState<string>();
  const [submitting, setSubmitting] = React.useState(false);
  const [jobs, setJobs] = React.useState<Record<string, Job>>({});
  /** The jobs the viewer is following: the last submission, or an upscale. */
  const [batch, setBatch] = React.useState<string[]>([]);
  const [lastRequest, setLastRequest] = React.useState<Record<string, unknown>>();
  const [lastSeed, setLastSeed] = React.useState<number>();
  const [detail, setDetail] = React.useState<{ item: MediaItem; items: MediaItem[] } | null>(null);
  const [picker, setPicker] = React.useState<'init' | 'refs' | null>(null);
  const [refSize, setRefSize] = React.useState<[number, number]>();
  const [dragOver, setDragOver] = React.useState(false);
  const promptRef = React.useRef<HTMLTextAreaElement>(null);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((state) => ({ ...state, [key]: value }));

  // Persist the form, so a reload or a trip to another screen keeps the prompt.
  React.useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(form));
    } catch {
      // Storage disabled or full; the form still works for this visit.
    }
  }, [form]);

  const ready = React.useMemo(
    () => (models.data?.models ?? []).filter((model) => model.ready),
    [models.data],
  );
  const selectedModel = ready.find((model) => model.id === form.model);
  const defaults = modelDefaults(selectedModel);

  React.useEffect(() => {
    if (ready.length === 0) return;
    setForm((state) =>
      ready.some((model) => model.id === state.model) ? state : { ...state, model: ready[0].id },
    );
  }, [ready]);

  // --- Applying settings from elsewhere ------------------------------------

  const applySettings = React.useCallback(
    (settings: ImageSettings) => {
      setForm((state) => {
        const next: FormState = { ...state };
        if (settings.prompt !== undefined) next.prompt = settings.prompt;
        // A stored prompt already carries any character description.
        next.characterPrompt = false;
        next.negative_prompt = settings.negative_prompt ?? '';
        if (settings.model && (models.data?.models ?? []).some((m) => m.id === settings.model)) {
          next.model = settings.model;
        }
        if (settings.steps !== undefined) next.steps = settings.steps;
        if (settings.cfg_scale !== undefined) next.cfg_scale = settings.cfg_scale;
        if (settings.sampler) next.sampler = settings.sampler;
        if (settings.seed !== undefined) next.seed = settings.seed;
        // An upscaled image records its own (bigger) size; the size to reuse
        // is the one it was generated at.
        const width = settings.task === 'upscale' ? settings.source_width : settings.width;
        const height = settings.task === 'upscale' ? settings.source_height : settings.height;
        if (width && height) {
          next.aspect = 'custom';
          next.customWidth = width;
          next.customHeight = height;
        }
        if (settings.ref_images?.length) {
          next.mode = 'edit';
          next.ref_images = settings.ref_images.slice(0, MAX_REFS);
          if (settings.img_cfg_scale !== undefined) next.img_cfg_scale = settings.img_cfg_scale;
          next.increase_ref_index = Boolean(settings.increase_ref_index);
        } else {
          next.mode = 'generate';
          next.init_image = settings.init_image;
          if (settings.strength !== undefined) next.strength = settings.strength;
        }
        return next;
      });
      promptRef.current?.focus();
    },
    [models.data],
  );

  // A hand-off from the Media page (reuse settings / use as init / edit this).
  const handoffDone = React.useRef(false);
  React.useEffect(() => {
    if (handoffDone.current || !models.data) return;
    handoffDone.current = true;
    const handoff = takeHandoff();
    if (!handoff) return;
    if (handoff.settings) applySettings(handoff.settings);
    if (handoff.init)
      setForm((state) => ({ ...state, mode: 'generate', init_image: handoff.init }));
    if (handoff.refs?.length) {
      setForm((state) => ({
        ...state,
        mode: 'edit',
        aspect: 'match',
        ref_images: [...state.ref_images, ...handoff.refs!].slice(0, MAX_REFS),
      }));
    }
  }, [models.data, applySettings]);

  const useAsInit = async (name: string) => {
    const input = await outputToInput(name);
    setForm((state) => ({ ...state, mode: 'generate', init_image: input, aspect: 'match' }));
  };
  const useAsReference = async (name: string) => {
    const input = await outputToInput(name);
    setForm((state) => ({
      ...state,
      mode: 'edit',
      aspect: 'match',
      ref_images: [...state.ref_images.filter((ref) => ref !== input), input].slice(0, MAX_REFS),
    }));
    promptRef.current?.focus();
  };

  // --- Sizing ----------------------------------------------------------------

  const matchSource = form.mode === 'edit' ? form.ref_images[0] : form.init_image;
  React.useEffect(() => {
    setRefSize(undefined);
    if (!matchSource) return;
    const img = new window.Image();
    img.onload = () => setRefSize([img.naturalWidth, img.naturalHeight]);
    img.src = inputUrl(matchSource);
  }, [matchSource]);

  const aspect = form.aspect === 'match' && !matchSource ? '1:1' : form.aspect;
  const [width, height] =
    aspect === 'custom'
      ? [form.customWidth, form.customHeight]
      : aspect === 'match'
        ? refSize
          ? fit(refSize[0], refSize[1], form.resolution)
          : fit(1, 1, form.resolution)
        : fit(...ASPECTS[aspect], form.resolution);
  const steps = form.steps ?? presetSteps(defaults, form.speed);

  // --- Jobs --------------------------------------------------------------------

  useEventStream(
    '/v1/jobs/stream',
    (event, data) => {
      const job = data as Job;
      if (!job?.id || job.kind !== 'image') return;
      setJobs((current) => ({ ...current, [job.id]: job }));
      if (event === 'completed') {
        recent.reload();
        if (typeof job.result?.metadata === 'object') {
          const seed = (job.result.metadata as { seed?: number }).seed;
          if (seed !== undefined && job.params.task !== 'upscale') setLastSeed(seed);
        }
      }
    },
    ['created', 'updated', 'progress', 'completed', 'failed'],
  );

  const batchJobs = batch.map((id) => jobs[id]).filter(Boolean);
  const active = Object.values(jobs).filter(
    (job) => job.status === 'queued' || job.status === 'running',
  );
  const otherActive = active.filter((job) => !batch.includes(job.id));
  const batchActive = batchJobs.some((job) => job.status === 'queued' || job.status === 'running');

  const buildRequest = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      prompt:
        character && form.characterPrompt
          ? withCharacter(form.prompt, character)
          : form.prompt.trim(),
      model: form.model,
      steps,
      width,
      height,
      batch: form.batch,
    };
    if (form.cfg_scale !== null) body.cfg_scale = form.cfg_scale;
    if (form.sampler) body.sampler = form.sampler;
    if (form.negative_prompt.trim()) body.negative_prompt = form.negative_prompt.trim();
    if (form.seed >= 0) body.seed = form.seed;
    if (character) body.character_id = character.id;
    if (form.mode === 'edit') {
      // The character's image leads, so an instruction can call it "image 1".
      body.ref_images = [...characterRefs, ...form.ref_images.filter((ref) => !characterRefs.includes(ref))].slice(0, MAX_REFS);
      body.img_cfg_scale = form.img_cfg_scale;
      if (form.increase_ref_index) body.increase_ref_index = true;
    } else {
      if (characterRefs.length) body.ref_images = characterRefs;
      if (form.init_image) {
        body.init_image = form.init_image;
        body.strength = form.strength;
      }
    }
    return body;
  };

  const submit = async (override?: Record<string, unknown>) => {
    const body = override ?? buildRequest();
    if (!body.prompt) {
      setError('Write a prompt first.');
      promptRef.current?.focus();
      return;
    }
    if (form.mode === 'edit' && !override && form.ref_images.length === 0 && characterRefs.length === 0) {
      setError('Add at least one reference image to edit.');
      return;
    }
    setError(undefined);
    setSubmitting(true);
    try {
      const result = await api.post<Job | { jobs: Job[] }>('/v1/jobs', body);
      const created = 'jobs' in result ? result.jobs : [result];
      setJobs((current) => ({
        ...current,
        ...Object.fromEntries(created.map((job) => [job.id, job])),
      }));
      setBatch(created.map((job) => job.id));
      setLastRequest(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const cancelBatch = () => {
    for (const job of batchJobs) {
      if (job.status === 'queued' || job.status === 'running') {
        void api.post(`/v1/jobs/${job.id}/cancel`);
      }
    }
  };

  const startUpscale = async (name: string, scale: 2 | 4) => {
    setError(undefined);
    try {
      const job = await upscale(name, scale);
      setJobs((current) => ({ ...current, [job.id]: job }));
      setBatch([job.id]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // --- Reference image input ---------------------------------------------------

  const uploadRefs = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) return;
    try {
      const uploaded = await Promise.all(
        images.map((file) => api.upload<{ name: string }>('/v1/inputs', file)),
      );
      setForm((state) => ({
        ...state,
        mode: 'edit',
        ref_images: [...state.ref_images, ...uploaded.map((item) => item.name)].slice(0, MAX_REFS),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Pasting an image anywhere on the screen adds it as a reference.
  React.useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
        file.type.startsWith('image/'),
      );
      if (files.length === 0) return;
      event.preventDefault();
      void uploadRefs(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  // --- Viewer focus ------------------------------------------------------------

  const batchOutputs = batchJobs.map(outputOf).filter((item): item is MediaItem => item !== null);
  const latest = recent.data?.outputs[0];
  /** What the viewer shows when nothing is running: the batch, else the newest image. */
  const shown: MediaItem[] =
    batchOutputs.length > 0 ? batchOutputs : latest && batch.length === 0 ? [latest] : [];
  const focus = shown.length === 1 ? shown[0] : undefined;
  const focusInfo = useResource<OutputInfo>(
    focus ? `/v1/outputs/${encodeURIComponent(focus.name)}/info` : null,
  );
  const focusSettings = settingsOf(focusInfo.data);

  const openDetail = (item: MediaItem, items: MediaItem[]) => setDetail({ item, items });

  const scales = upscalers.data?.scales ?? [];
  const canSubmit =
    Boolean(form.prompt.trim()) &&
    Boolean(form.model) &&
    !submitting &&
    (form.mode === 'generate' || form.ref_images.length > 0 || characterRefs.length > 0);

  return (
    <Page
      title="Image generation"
      description="Text-to-image and instruction editing through stable-diffusion.cpp. Click any image for details, upscaling and reuse."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(330px,400px)_minmax(0,1fr)]">
        {/* ---------------- Controls ---------------- */}
        <Card className="flex h-fit flex-col gap-4 p-4 lg:sticky lg:top-[4.5rem] lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist">
            {(['generate', 'edit'] as const).map((mode) => (
              <button
                key={mode}
                role="tab"
                aria-selected={form.mode === mode}
                onClick={() =>
                  setForm((state) => ({
                    ...state,
                    mode,
                    // Edits follow their reference's shape unless told otherwise.
                    aspect: mode === 'edit' && state.aspect !== 'custom' ? 'match' : state.aspect,
                  }))
                }
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-md py-2 text-sm font-semibold text-muted-foreground transition',
                  form.mode === mode && 'bg-card text-foreground shadow-sm',
                )}
              >
                {mode === 'generate' ? (
                  <Sparkles className="size-3.5" />
                ) : (
                  <Wand2 className="size-3.5" />
                )}
                {mode === 'generate' ? 'Generate' : 'Edit'}
              </button>
            ))}
          </div>

          <Field label="Model">
            {models.loading ? (
              <div className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-3" /> Loading models…
              </div>
            ) : ready.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No image models installed yet. Open <strong>Models</strong> in the top bar to
                install one.
              </p>
            ) : (
              <Select
                value={form.model}
                onValueChange={(value) =>
                  // Steps/CFG/sampler overrides were tuned for the old model.
                  setForm((state) => ({
                    ...state,
                    model: value,
                    steps: null,
                    cfg_scale: null,
                    sampler: null,
                  }))
                }
                options={ready.map((model) => {
                  const d = modelDefaults(model);
                  return {
                    value: model.id,
                    label: model.name,
                    description: d.steps
                      ? `${d.steps} steps · CFG ${d.cfg_scale ?? '—'}`
                      : undefined,
                  };
                })}
                placeholder="Choose a model"
              />
            )}
          </Field>

          <CharacterField
            character={character}
            onChange={(next) => {
              setCharacter(next);
              setForm((state) => ({ ...state, characterImage: undefined, characterPrompt: true }));
            }}
            imageName={characterImage}
            onImageChange={(name) => update('characterImage', name)}
            hint={
              character && form.characterRef
                ? form.mode === 'edit'
                  ? 'The character image is reference image 1; refer to it as “image 1”.'
                  : 'Sent as a reference image — needs an edit-capable model (FLUX.2, Qwen-Image-Edit).'
                : undefined
            }
          >
            <div className="flex flex-col gap-2">
              <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                Describe the character in the prompt
                <Switch
                  checked={form.characterPrompt}
                  onCheckedChange={(value) => update('characterPrompt', value)}
                />
              </label>
              <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                Use the character image as a reference
                <Switch
                  checked={form.characterRef}
                  disabled={!characterImage}
                  onCheckedChange={(value) => update('characterRef', value)}
                />
              </label>
            </div>
          </CharacterField>

          <Field
            label={form.mode === 'edit' ? 'Edit instruction' : 'Prompt'}
            hint={<span className="opacity-80">⌘/Ctrl + Enter to generate</span>}
          >
            <Textarea
              ref={promptRef}
              value={form.prompt}
              onChange={(event) => update('prompt', event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSubmit) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={
                form.mode === 'edit'
                  ? 'Change the background to a sunset beach · Put the person from image 1 in the outfit from image 2'
                  : 'A lantern-lit alley after rain, cinematic lighting'
              }
              rows={5}
              className="text-[15px]"
            />
          </Field>

          {form.mode === 'edit' ? (
            <Field
              label={`Reference images · ${form.ref_images.length}/${MAX_REFS}`}
              hint="For edit models such as FLUX Kontext / FLUX.2 and Qwen-Image-Edit. Refer to them as image 1, image 2… in the instruction."
            >
              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(false);
                  void uploadRefs(Array.from(event.dataTransfer.files));
                }}
                className={cn(
                  'flex flex-col gap-2 rounded-lg border border-dashed border-input p-2.5 transition',
                  dragOver && 'border-primary bg-accent',
                )}
              >
                {form.ref_images.length > 0 ? (
                  <div className="grid grid-cols-4 gap-2">
                    {form.ref_images.map((name, index) => (
                      <InputThumb
                        key={name}
                        name={name}
                        label={String(index + 1)}
                        onRemove={() =>
                          update(
                            'ref_images',
                            form.ref_images.filter((item) => item !== name),
                          )
                        }
                      />
                    ))}
                  </div>
                ) : (
                  <p className="py-2 text-center text-xs text-muted-foreground">
                    Drop or paste images here, or pick them below.
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={form.ref_images.length >= MAX_REFS}
                    onClick={() => setPicker('refs')}
                  >
                    <ImagePlus /> From gallery
                  </Button>
                  <FileButton multiple onFiles={(files) => void uploadRefs(files)}>
                    <Upload /> From computer
                  </FileButton>
                </div>
              </div>
            </Field>
          ) : null}

          {/* Size */}
          <Field
            label={
              <span className="flex items-center justify-between">
                <span>Aspect ratio</span>
                <span className="tabular-nums text-foreground">
                  {width}×{height}
                </span>
              </span>
            }
          >
            <div className="flex flex-wrap gap-1.5">
              {(matchSource ? ['match'] : [])
                .concat(Object.keys(ASPECTS), ['custom'])
                .map((key) => (
                  <AspectChip
                    key={key}
                    value={key}
                    pressed={aspect === key}
                    shape={key === 'match' ? refSize : key === 'custom' ? undefined : ASPECTS[key]}
                    onClick={() => update('aspect', key)}
                  />
                ))}
            </div>
          </Field>

          {aspect === 'custom' ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Width">
                <Input
                  type="number"
                  step={16}
                  min={64}
                  value={form.customWidth}
                  onChange={(event) => update('customWidth', Number(event.target.value))}
                />
              </Field>
              <Field label="Height">
                <Input
                  type="number"
                  step={16}
                  min={64}
                  value={form.customHeight}
                  onChange={(event) => update('customHeight', Number(event.target.value))}
                />
              </Field>
            </div>
          ) : (
            <Field label="Resolution">
              <Select
                value={String(form.resolution)}
                onValueChange={(value) => update('resolution', Number(value))}
                options={RESOLUTIONS.map((res) => ({
                  value: String(res.value),
                  label: `${res.value}² · ${((res.value * res.value) / 1e6).toFixed(1)} MP · ${res.note}`,
                }))}
              />
            </Field>
          )}

          <Field label="Speed">
            <div className="grid grid-cols-3 gap-1.5">
              {(Object.keys(SPEEDS) as Speed[]).map((speed) => (
                <button
                  key={speed}
                  type="button"
                  aria-pressed={form.speed === speed && form.steps === null}
                  onClick={() => setForm((state) => ({ ...state, speed, steps: null }))}
                  className={cn(
                    'flex flex-col items-center rounded-lg border border-border bg-muted/50 px-2 py-2 text-center transition hover:bg-accent',
                    form.speed === speed &&
                      form.steps === null &&
                      'border-primary bg-primary/10 hover:bg-primary/10',
                  )}
                >
                  <span className="text-sm font-semibold">{SPEEDS[speed].label}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {presetSteps(defaults, speed)} steps
                  </span>
                </button>
              ))}
            </div>
          </Field>

          <Field label="Images">
            <div className="grid grid-cols-4 gap-1.5">
              {[1, 2, 3, 4].map((count) => (
                <button
                  key={count}
                  type="button"
                  aria-pressed={form.batch === count}
                  onClick={() => update('batch', count)}
                  className={cn(
                    'rounded-md border border-border bg-muted/50 py-1.5 text-sm font-medium transition hover:bg-accent',
                    form.batch === count && 'border-primary bg-primary/10 hover:bg-primary/10',
                  )}
                >
                  {count}
                </button>
              ))}
            </div>
          </Field>

          {form.mode === 'generate' ? (
            <Field
              label="Start image (image-to-image)"
              hint={form.init_image ? undefined : 'Optional. Pick a generated image or a file.'}
            >
              {form.init_image ? (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-3">
                    <InputThumb
                      name={form.init_image}
                      className="size-16 shrink-0"
                      onRemove={() => update('init_image', undefined)}
                    />
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Button variant="outline" size="sm" onClick={() => setPicker('init')}>
                        <ImagePlus /> Replace…
                      </Button>
                    </div>
                  </div>
                  <Field
                    label={`Denoising strength · ${form.strength.toFixed(2)}`}
                    hint="Lower keeps more of the start image."
                  >
                    <Slider
                      value={form.strength}
                      onValueChange={(value) => update('strength', value)}
                      min={0.05}
                      max={1}
                      step={0.05}
                    />
                  </Field>
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setPicker('init')}>
                  <ImagePlus /> Choose start image…
                </Button>
              )}
            </Field>
          ) : null}

          <details className="group rounded-lg border border-border bg-muted/30 px-3 [&[open]]:pb-3">
            <summary className="flex cursor-pointer list-none items-center justify-between py-2.5 text-sm font-semibold">
              Advanced
              <span className="text-xs font-normal text-muted-foreground group-open:hidden">
                seed, steps, CFG, sampler…
              </span>
            </summary>
            <div className="flex flex-col gap-3">
              <Field
                label="Seed"
                hint="-1 picks a random seed; the one used is recorded with the image."
              >
                <div className="flex gap-1.5">
                  <Input
                    type="number"
                    min={-1}
                    value={form.seed}
                    onChange={(event) => update('seed', Number(event.target.value))}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Random seed"
                    title="Random seed"
                    onClick={() => update('seed', -1)}
                  >
                    <Dice5 />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Reuse last seed"
                    title={lastSeed !== undefined ? `Reuse last seed (${lastSeed})` : 'No seed yet'}
                    disabled={lastSeed === undefined}
                    onClick={() => lastSeed !== undefined && update('seed', lastSeed)}
                  >
                    <History />
                  </Button>
                </div>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Steps">
                  <Input
                    type="number"
                    min={1}
                    max={200}
                    value={form.steps ?? ''}
                    placeholder={`${presetSteps(defaults, form.speed)} (preset)`}
                    onChange={(event) =>
                      update('steps', event.target.value ? Number(event.target.value) : null)
                    }
                  />
                </Field>
                <Field label="CFG scale">
                  <Input
                    type="number"
                    min={0}
                    max={30}
                    step={0.5}
                    value={form.cfg_scale ?? ''}
                    placeholder={
                      defaults.cfg_scale !== undefined
                        ? `${defaults.cfg_scale} (model)`
                        : 'model default'
                    }
                    onChange={(event) =>
                      update('cfg_scale', event.target.value ? Number(event.target.value) : null)
                    }
                  />
                </Field>
              </div>

              <Field label="Sampler">
                <Select
                  value={form.sampler ?? '__default'}
                  onValueChange={(value) => update('sampler', value === '__default' ? null : value)}
                  options={[
                    {
                      value: '__default',
                      label: `Model default${defaults.sampler ? ` (${defaults.sampler})` : ''}`,
                    },
                    ...SAMPLERS.map((sampler) => ({ value: sampler, label: sampler })),
                  ]}
                />
              </Field>

              <Field label="Negative prompt">
                <Textarea
                  value={form.negative_prompt}
                  onChange={(event) => update('negative_prompt', event.target.value)}
                  placeholder="blurry, low quality"
                  rows={2}
                />
              </Field>

              {form.mode === 'edit' ? (
                <>
                  <Field
                    label={`Image CFG scale · ${form.img_cfg_scale}`}
                    hint="How closely the result follows the reference images."
                  >
                    <Slider
                      value={form.img_cfg_scale}
                      onValueChange={(value) => update('img_cfg_scale', value)}
                      min={0}
                      max={10}
                      step={0.1}
                    />
                  </Field>
                  <label className="flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
                    <span>
                      Increase reference index
                      <span className="block text-[11px] font-normal">
                        Numbers references from 1 — what Qwen-Image-Edit expects.
                      </span>
                    </span>
                    <Switch
                      checked={form.increase_ref_index}
                      onCheckedChange={(value) => update('increase_ref_index', value)}
                    />
                  </label>
                </>
              ) : null}

              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setForm((state) => ({
                    ...DEFAULTS,
                    model: state.model,
                    prompt: state.prompt,
                    mode: state.mode,
                    ref_images: state.ref_images,
                  }))
                }
              >
                <RotateCcw /> Reset settings
              </Button>
            </div>
          </details>

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <div className="sticky bottom-0 -mx-4 -mb-4 flex gap-2 border-t border-border bg-card/95 p-4 backdrop-blur">
            <Button
              size="lg"
              className="flex-1"
              onClick={() => void submit()}
              disabled={!canSubmit}
            >
              {submitting ? (
                <Spinner className="size-4" />
              ) : form.mode === 'edit' ? (
                <Wand2 />
              ) : (
                <Sparkles />
              )}
              {form.mode === 'edit' ? 'Apply edit' : 'Generate'}
              {form.batch > 1 ? ` ×${form.batch}` : ''}
            </Button>
            {batchActive ? (
              <Button size="lg" variant="outline" onClick={cancelBatch}>
                Cancel
              </Button>
            ) : null}
          </div>
        </Card>

        {/* ---------------- Viewer + gallery ---------------- */}
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="overflow-hidden">
            <div className="checkerboard relative flex min-h-[420px] items-center justify-center">
              {batchJobs.length > 1 ? (
                <div className="grid w-full grid-cols-1 gap-2 p-2 sm:grid-cols-2">
                  {batchJobs.map((job) => {
                    const item = outputOf(job);
                    return item ? (
                      <button
                        key={job.id}
                        type="button"
                        onClick={() => openDetail(item, batchOutputs)}
                        className="overflow-hidden rounded-md shadow-sm transition hover:brightness-105"
                      >
                        <img src={item.url} alt="" className="w-full" />
                      </button>
                    ) : (
                      <PendingTile key={job.id} job={job} />
                    );
                  })}
                </div>
              ) : focus ? (
                <button
                  type="button"
                  onClick={() =>
                    openDetail(
                      focus,
                      batchOutputs.length > 0 ? batchOutputs : (recent.data?.outputs ?? []),
                    )
                  }
                  className="group relative m-2 cursor-zoom-in"
                  title="Open details"
                >
                  <img
                    src={focus.url}
                    alt={focusSettings?.prompt ?? focus.name}
                    className="max-h-[72vh] max-w-full rounded-md shadow-md"
                  />
                  <span className="absolute right-2 top-2 rounded-md bg-black/55 p-1.5 text-white opacity-0 transition group-hover:opacity-100">
                    <Maximize2 className="size-4" />
                  </span>
                </button>
              ) : batchJobs.length === 1 ? (
                <PendingTile job={batchJobs[0]} large />
              ) : (
                <EmptyState
                  icon={ImageIcon}
                  title="Ready when you are"
                  description="Describe an image, or switch to Edit and add reference images. Results appear here and in the gallery below."
                />
              )}

              {batchActive ? <ProgressOverlay jobs={batchJobs} /> : null}
            </div>

            {focus ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
                <span className="mr-auto min-w-0 truncate text-xs tabular-nums text-muted-foreground">
                  {focusSettings
                    ? [
                        focusSettings.width && `${focusSettings.width}×${focusSettings.height}`,
                        focusSettings.task === 'upscale'
                          ? `upscaled ${focusSettings.scale}×`
                          : focusSettings.seed !== undefined && `seed ${focusSettings.seed}`,
                        focusSettings.duration_ms && formatDuration(focusSettings.duration_ms),
                        focusSettings.model,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : timeAgo(focus.modified)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openDetail(focus, recent.data?.outputs ?? [focus])}
                >
                  <Info /> Details
                </Button>
                {focusSettings ? (
                  <Button size="sm" variant="ghost" onClick={() => applySettings(focusSettings)}>
                    <RotateCcw /> Reuse
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => void useAsReference(focus.name)}>
                  <Layers /> Edit this
                </Button>
                {([2, 4] as const).map((scale) => (
                  <Button
                    key={scale}
                    size="sm"
                    variant="ghost"
                    disabled={!scales.includes(scale)}
                    onClick={() => void startUpscale(focus.name, scale)}
                    title={`Upscale ${scale}× with ${upscalers.data?.defaults[scale] ?? 'the default upscaler'}`}
                  >
                    <Maximize2 /> {scale}×
                  </Button>
                ))}
                {lastRequest && focusSettings?.task !== 'upscale' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const { seed: _seed, ...rest } = lastRequest;
                      void submit(rest);
                    }}
                    title="Run the same request with a new seed"
                  >
                    <Shuffle /> Vary
                  </Button>
                ) : null}
                <Button asChild size="sm" variant="ghost">
                  <a href={focus.url} download aria-label="Download">
                    <Download />
                  </a>
                </Button>
              </div>
            ) : null}
          </Card>

          {otherActive.length > 0 ? (
            <Card className="flex flex-col gap-2.5 p-3">
              <h3 className="text-xs font-semibold text-muted-foreground">Also in the queue</h3>
              {otherActive.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </Card>
          ) : null}

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Recent</h3>
              <span className="text-[11px] text-muted-foreground">
                Click an image for details, upscaling and reuse
              </span>
            </div>
            {(recent.data?.outputs.length ?? 0) === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">Nothing yet.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8">
                {recent.data!.outputs.map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    onClick={() => openDetail(item, recent.data!.outputs)}
                    title={`${item.name} · ${timeAgo(item.modified)}`}
                    className="checkerboard group relative aspect-square overflow-hidden rounded-md border border-border outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                  >
                    <img
                      src={item.url}
                      alt=""
                      loading="lazy"
                      className="size-full object-cover transition duration-200 group-hover:scale-[1.04]"
                    />
                    {item.name.startsWith('upscaled-') ? (
                      <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[10px] font-semibold text-white">
                        {item.name.slice(9, 11)}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <ImageDetailsDialog
        item={detail?.item ?? null}
        items={detail?.items}
        onItemChange={(item) => setDetail((current) => ({ item, items: current?.items ?? [item] }))}
        onOpenChange={(open) => !open && setDetail(null)}
        onReuse={applySettings}
        onUseAsInit={useAsInit}
        onUseAsReference={useAsReference}
        onDelete={async (name) => {
          await api.delete(`/v1/outputs/${encodeURIComponent(name)}`);
          recent.reload();
          setDetail((current) =>
            current
              ? { ...current, items: current.items.filter((item) => item.name !== name) }
              : current,
          );
        }}
      />

      <ImagePickerDialog
        open={picker !== null}
        onOpenChange={(open) => !open && setPicker(null)}
        title={picker === 'init' ? 'Choose a start image' : 'Add reference images'}
        max={picker === 'init' ? 1 : MAX_REFS - form.ref_images.length}
        onPick={(names) => {
          if (picker === 'init') {
            setForm((state) => ({ ...state, init_image: names[0] }));
          } else {
            setForm((state) => ({
              ...state,
              ref_images: [
                ...state.ref_images,
                ...names.filter((n) => !state.ref_images.includes(n)),
              ].slice(0, MAX_REFS),
            }));
          }
        }}
      />
    </Page>
  );
}

// --- Pieces ------------------------------------------------------------------

function jobLabel(job: Job): string {
  if (job.params.task === 'upscale')
    return `Upscale ${job.params.scale}× · ${String(job.params.image)}`;
  return String(job.params.prompt ?? job.id);
}

/** Stage, step count, elapsed and a naive ETA for the batch the viewer follows. */
function ProgressOverlay({ jobs }: { jobs: Job[] }) {
  const running = jobs.find((job) => job.status === 'running');
  const queued = jobs.filter((job) => job.status === 'queued').length;
  const done = jobs.filter((job) => job.status === 'completed').length;
  const current = running ?? jobs.find((job) => job.status === 'queued');
  const elapsed = useElapsed(current?.startedAt ?? current?.createdAt);
  if (!current) return null;

  const upscaling = current.params.task === 'upscale';
  const step = current.step ?? 0;
  const eta =
    running &&
    step > 0 &&
    current.totalSteps &&
    (upscaling || current.totalSteps === current.params.steps)
      ? (elapsed / step) * (current.totalSteps - step)
      : undefined;
  // sd-cli's weight-loading bar comes through the same step parser as
  // sampling does; only a total that matches the requested steps is sampling.
  const sampling = current.totalSteps !== undefined && current.totalSteps === current.params.steps;
  const stage = !running
    ? 'Queued'
    : upscaling
      ? 'Upscaling'
      : sampling
        ? step >= current.totalSteps!
          ? 'Decoding'
          : 'Sampling'
        : 'Loading model';

  return (
    <div className="absolute inset-x-3 bottom-3 flex flex-col gap-2 rounded-lg border border-border bg-card/90 p-3 shadow-lg backdrop-blur">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          <Spinner className="size-3 shrink-0" />
          {stage}
          {jobs.length > 1 ? (
            <span className="text-muted-foreground">
              · image {Math.min(done + 1, jobs.length)} of {jobs.length}
              {queued > 1 ? ` (${queued} queued)` : ''}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {current.totalSteps ? `${step}/${current.totalSteps} · ` : ''}
          {eta !== undefined ? `~${formatDuration(eta)} left · ` : ''}
          {formatDuration(elapsed)}
        </span>
      </div>
      <Progress value={current.progress} indeterminate={!running || !current.totalSteps} />
    </div>
  );
}

function PendingTile({ job, large }: { job: Job; large?: boolean }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-md bg-card/60 p-6 text-center text-xs text-muted-foreground',
        large ? 'min-h-[380px] w-full' : 'aspect-square',
      )}
    >
      {job.status === 'failed' || job.status === 'cancelled' ? (
        <>
          <Ban className="size-5 text-destructive" />
          <span className="max-w-sm text-destructive">{job.error?.message ?? job.status}</span>
        </>
      ) : (
        <>
          <Spinner className="size-5" />
          <span>{job.status === 'queued' ? 'Queued' : 'Working…'}</span>
        </>
      )}
    </div>
  );
}

function JobRow({ job }: { job: Job }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate">{jobLabel(job)}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {job.status === 'queued'
              ? 'queued'
              : job.totalSteps
                ? `${job.step ?? 0}/${job.totalSteps}`
                : `${Math.round(job.progress * 100)}%`}
          </span>
        </div>
        <Progress value={job.progress} indeterminate={job.status === 'queued'} />
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Cancel"
        onClick={() => void api.post(`/v1/jobs/${job.id}/cancel`)}
      >
        <Ban />
      </Button>
    </div>
  );
}
