import * as React from 'react';
import {
  AudioLines,
  Ban,
  Dice5,
  Download,
  History,
  ImagePlus,
  Mic,
  RotateCcw,
  Shuffle,
  Sparkles,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-react';
import {
  api,
  useEventStream,
  useResource,
  waitForJob,
  type BundleInfo,
  type Job,
  type MediaItem,
} from '@/lib/api';
import {
  inputUrl,
  outputToInput,
  takeVideoHandoff,
  type OutputInfo,
} from '@/lib/images';
import { primaryImage, voiceParams, voiceSummary, withCharacter } from '@/lib/characters';
import {
  Badge,
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
import { ImagePickerDialog } from '@/components/ImagePicker';
import { AudioPickerDialog } from '@/components/AudioPicker';
import { CharacterField, useChosenCharacter } from '@/components/CharacterPicker';
import { AspectChip, FileButton, InputThumb, useElapsed } from '@/components/studio';
import { cn, formatDuration, timeAgo } from '@/lib/utils';

/**
 * The video studio, laid out like the image studio: a Prompt/Speech switch in
 * place of Generate/Edit, aspect chips and a resolution instead of raw sizes,
 * a length in seconds instead of a frame count, speed presets over the
 * model's step count, the rarely-touched knobs under Advanced — and a large
 * player with the run's progress on top of it.
 *
 * The start image (image-to-video, or the speaker in speech-to-video) comes
 * from generated images, earlier uploads or the computer, or from a Character
 * Studio character — whose description is also folded into the prompt, and
 * whose voice can speak a script for speech-to-video.
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

type Mode = 'prompt' | 'speech';
type Speed = 'fast' | 'balanced' | 'quality';
type SpeechSource = 'clip' | 'script';

const ASPECTS: Record<string, [number, number]> = {
  '16:9': [16, 9],
  '9:16': [9, 16],
  '1:1': [1, 1],
  '4:3': [4, 3],
  '3:4': [3, 4],
  '11:8': [11, 8],
};

/** Short-side sizes. Video models are trained near 480–720p; above that is slow and off-distribution. */
const RESOLUTIONS = [
  { value: 320, note: 'preview' },
  { value: 384, note: 'draft' },
  { value: 480, note: '480p' },
  { value: 512, note: 'standard' },
  { value: 576, note: '576p' },
  { value: 704, note: 'more detail · slow' },
  { value: 720, note: '720p · slowest' },
];

const LENGTHS = [1, 2, 3, 5];

const SPEEDS: Record<Speed, { label: string; factor: number }> = {
  fast: { label: 'Fast', factor: 0.5 },
  balanced: { label: 'Balanced', factor: 1 },
  quality: { label: 'Quality', factor: 1.5 },
};

interface FormState {
  mode: Mode;
  model: string;
  prompt: string;
  negative_prompt: string;
  aspect: string;
  resolution: number;
  customWidth: number;
  customHeight: number;
  /** `null` means the model's default clip length. */
  frames: number | null;
  fps: number | null;
  speed: Speed;
  steps: number | null;
  cfg_scale: number | null;
  sampler: string | null;
  flow_shift: number | null;
  seed: number;
  init_image?: string;
  strength: number;
  speechSource: SpeechSource;
  audio?: string;
  audio_name?: string;
  script: string;
  audio_chunk_seconds: number;
  audio_overlap_seconds: number;
  /** Fold the chosen character's description into the prompt. */
  characterPrompt: boolean;
}

const DEFAULTS: FormState = {
  mode: 'prompt',
  model: '',
  prompt: '',
  negative_prompt: '',
  aspect: '16:9',
  resolution: 512,
  customWidth: 704,
  customHeight: 512,
  frames: null,
  fps: null,
  speed: 'balanced',
  steps: null,
  cfg_scale: null,
  sampler: null,
  flow_shift: null,
  seed: -1,
  strength: 0.75,
  speechSource: 'clip',
  script: '',
  audio_chunk_seconds: 5,
  audio_overlap_seconds: 0.5,
  characterPrompt: true,
};

const STORE_KEY = 'pepper-video-form';

function loadForm(): FormState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<FormState>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

interface ModelDefaults {
  steps?: number;
  cfg_scale?: number;
  sampler?: string;
  width?: number;
  height?: number;
  video_frames?: number;
  fps?: number;
  flow_shift?: number;
}

function modelDefaults(model: BundleInfo | undefined): ModelDefaults {
  return ((model?.manifest as { defaults?: ModelDefaults } | null)?.defaults ?? {}) as ModelDefaults;
}

const isPython = (model: BundleInfo | undefined) => model?.manifest?.backend === 'python';
const isSpeechOnly = (model: BundleInfo) =>
  isPython(model) && model.capabilities?.includes('s2v');

/** Width × height with the given short side at the aspect, in multiples of 32. */
function fit(aw: number, ah: number, shortSide: number): [number, number] {
  const round = (value: number) => Math.max(128, Math.round(value / 32) * 32);
  return aw >= ah
    ? [round((shortSide * aw) / ah), round(shortSide)]
    : [round(shortSide), round((shortSide * ah) / aw)];
}

/** The closest aspect chip to a width/height pair. */
function nearestAspect(width: number, height: number): string {
  const ratio = width / height;
  let best = '16:9';
  let bestDiff = Infinity;
  for (const [key, [aw, ah]] of Object.entries(ASPECTS)) {
    const diff = Math.abs(Math.log(ratio / (aw / ah)));
    if (diff < bestDiff) {
      best = key;
      bestDiff = diff;
    }
  }
  return best;
}

/** Video models take 4n+1 frames (the VAE's temporal stride plus the first frame). */
function snapFrames(frames: number): number {
  return Math.min(257, Math.max(5, Math.round((frames - 1) / 4) * 4 + 1));
}

function presetSteps(defaults: ModelDefaults, speed: Speed): number {
  return Math.max(1, Math.round((defaults.steps ?? 20) * SPEEDS[speed].factor));
}

function outputOf(job: Job): MediaItem | null {
  const url = job.result?.video_url;
  if (typeof url !== 'string') return null;
  return {
    name: decodeURIComponent(url.split('/').pop()!),
    kind: 'video',
    size: 0,
    modified: job.finishedAt ?? new Date().toISOString(),
    url,
  };
}

interface VideoSettings {
  prompt?: string;
  negative_prompt?: string;
  model?: string;
  steps?: number;
  cfg_scale?: number;
  width?: number;
  height?: number;
  seed?: number;
  sampler?: string;
  video_frames?: number;
  frames?: number;
  fps?: number;
  flow_shift?: number;
  init_image?: string;
  strength?: number;
  audio?: string;
  duration_ms?: number;
  audio_duration_s?: number;
  audio_chunks?: number;
  character_id?: string;
}

function settingsOf(info: OutputInfo | undefined): VideoSettings | null {
  if (!info?.job) return null;
  return {
    ...(info.job.params as VideoSettings),
    ...((info.job.metadata ?? {}) as VideoSettings),
  };
}

export function GeneratePage() {
  const models = useResource<{ models: BundleInfo[] }>('/v1/models?kind=video');
  const recent = useResource<{ outputs: MediaItem[] }>('/v1/outputs?kind=video&limit=48');
  const { character, setCharacter } = useChosenCharacter('pepper-character-video');

  const [form, setForm] = React.useState<FormState>(loadForm);
  const [error, setError] = React.useState<string>();
  const [submitting, setSubmitting] = React.useState<string>();
  const [jobs, setJobs] = React.useState<Record<string, Job>>({});
  const [followed, setFollowed] = React.useState<string>();
  const [selected, setSelected] = React.useState<MediaItem>();
  const [lastRequest, setLastRequest] = React.useState<Record<string, unknown>>();
  const [lastSeed, setLastSeed] = React.useState<number>();
  const [picker, setPicker] = React.useState<'image' | 'audio' | null>(null);
  const [refSize, setRefSize] = React.useState<[number, number]>();
  const [dragOver, setDragOver] = React.useState(false);
  const promptRef = React.useRef<HTMLTextAreaElement>(null);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((state) => ({ ...state, [key]: value }));

  React.useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(form));
    } catch {
      // Storage disabled or full; the form still works for this visit.
    }
  }, [form]);

  const speech = form.mode === 'speech';

  // The Speech tab only offers models that declare s2v; the Prompt tab hides
  // Python models that are audio-driven only (EchoMimicV3).
  const ready = React.useMemo(() => {
    const usable = (models.data?.models ?? []).filter((model) => model.ready);
    return speech
      ? usable.filter((model) => model.capabilities?.includes('s2v'))
      : usable.filter((model) => !isSpeechOnly(model));
  }, [models.data, speech]);

  const selectedModel = ready.find((model) => model.id === form.model);
  const defaults = modelDefaults(selectedModel);
  const pythonRunner = isPython(selectedModel);

  // A model's own shape and length become the starting point when it is picked.
  const applyModelDefaults = React.useCallback((model: BundleInfo | undefined) => {
    const d = modelDefaults(model);
    setForm((state) => ({
      ...state,
      model: model?.id ?? '',
      steps: null,
      cfg_scale: null,
      sampler: null,
      flow_shift: null,
      frames: null,
      fps: null,
      ...(d.width && d.height && state.aspect !== 'match'
        ? {
            aspect: nearestAspect(d.width, d.height),
            resolution: Math.min(d.width, d.height),
            customWidth: d.width,
            customHeight: d.height,
          }
        : {}),
    }));
  }, []);

  React.useEffect(() => {
    if (ready.length === 0) return;
    if (!ready.some((model) => model.id === form.model)) applyModelDefaults(ready[0]);
  }, [ready, form.model, applyModelDefaults]);

  // --- Hand-offs and reuse ---------------------------------------------------

  const applySettings = React.useCallback(
    (settings: VideoSettings) => {
      setForm((state) => {
        const next: FormState = { ...state };
        if (settings.prompt !== undefined) next.prompt = settings.prompt;
        next.negative_prompt = settings.negative_prompt ?? '';
        if (settings.model && (models.data?.models ?? []).some((m) => m.id === settings.model)) {
          next.model = settings.model;
        }
        if (settings.steps !== undefined) next.steps = settings.steps;
        if (settings.cfg_scale !== undefined) next.cfg_scale = settings.cfg_scale;
        if (settings.sampler) next.sampler = settings.sampler;
        if (settings.flow_shift !== undefined) next.flow_shift = settings.flow_shift;
        if (settings.seed !== undefined) next.seed = settings.seed;
        if (settings.width && settings.height) {
          next.aspect = 'custom';
          next.customWidth = settings.width;
          next.customHeight = settings.height;
        }
        const frames = settings.video_frames ?? settings.frames;
        if (frames && !settings.audio) next.frames = frames;
        if (settings.fps) next.fps = settings.fps;
        next.init_image = settings.init_image;
        if (settings.strength !== undefined) next.strength = settings.strength;
        if (settings.audio) {
          next.mode = 'speech';
          next.speechSource = 'clip';
          next.audio = settings.audio;
          next.audio_name = settings.audio;
        } else {
          next.mode = 'prompt';
        }
        // The stored prompt already carries the character's description.
        next.characterPrompt = false;
        return next;
      });
      promptRef.current?.focus();
    },
    [models.data],
  );

  const handoffDone = React.useRef(false);
  React.useEffect(() => {
    if (handoffDone.current || !models.data) return;
    handoffDone.current = true;
    const handoff = takeVideoHandoff();
    if (!handoff) return;
    if (handoff.settings) applySettings(handoff.settings as VideoSettings);
    if (handoff.init) {
      setForm((state) => ({ ...state, init_image: handoff.init, aspect: 'match' }));
    }
  }, [models.data, applySettings]);

  // A character chosen with no start image set lends its portrait.
  const pickCharacter = (next: typeof character) => {
    setCharacter(next);
    const image = next ? primaryImage(next) : undefined;
    if (image) {
      setForm((state) => ({
        ...state,
        init_image: state.init_image && character ? image : (state.init_image ?? image),
        aspect: state.aspect === 'custom' ? state.aspect : 'match',
        characterPrompt: true,
      }));
    }
  };

  // --- Sizing ------------------------------------------------------------------

  React.useEffect(() => {
    setRefSize(undefined);
    if (!form.init_image) return;
    const img = new window.Image();
    img.onload = () => setRefSize([img.naturalWidth, img.naturalHeight]);
    img.src = inputUrl(form.init_image);
  }, [form.init_image]);

  const aspect = form.aspect === 'match' && !form.init_image ? '16:9' : form.aspect;
  const [width, height] =
    aspect === 'custom'
      ? [form.customWidth, form.customHeight]
      : aspect === 'match'
        ? refSize
          ? fit(refSize[0], refSize[1], form.resolution)
          : fit(16, 9, form.resolution)
        : fit(...ASPECTS[aspect], form.resolution);
  const fps = form.fps ?? defaults.fps ?? 24;
  const frames = form.frames ?? defaults.video_frames ?? 33;
  const steps = form.steps ?? presetSteps(defaults, form.speed);

  // --- Jobs ------------------------------------------------------------------

  useEventStream(
    '/v1/jobs/stream',
    (event, data) => {
      const job = data as Job;
      if (!job?.id || job.kind !== 'video') return;
      setJobs((current) => ({ ...current, [job.id]: job }));
      if (event === 'completed') {
        recent.reload();
        const seed = (job.result?.metadata as { seed?: number } | undefined)?.seed;
        if (seed !== undefined) setLastSeed(seed);
      }
    },
    ['created', 'updated', 'progress', 'completed', 'failed'],
  );

  const followedJob = followed ? jobs[followed] : undefined;
  const followedActive = followedJob?.status === 'queued' || followedJob?.status === 'running';
  const otherActive = Object.values(jobs).filter(
    (job) => job.id !== followed && (job.status === 'queued' || job.status === 'running'),
  );

  const useVoiceScript = speech && form.speechSource === 'script';
  const voice = character?.voice;

  const buildRequest = (): Record<string, unknown> => {
    const prompt =
      character && form.characterPrompt ? withCharacter(form.prompt, character) : form.prompt.trim();
    const body: Record<string, unknown> = { prompt, model: form.model, steps, width, height };
    if (form.cfg_scale !== null) body.cfg_scale = form.cfg_scale;
    if (pythonRunner) body.fps = fps;
    else {
      if (form.sampler) body.sampler = form.sampler;
      if (form.flow_shift !== null) body.flow_shift = form.flow_shift;
    }
    if (form.negative_prompt.trim()) body.negative_prompt = form.negative_prompt.trim();
    if (form.seed >= 0) body.seed = form.seed;
    if (form.init_image) {
      body.init_image = form.init_image;
      if (!pythonRunner) body.strength = form.strength;
    }
    if (character) body.character_id = character.id;
    if (speech) {
      body.audio = form.audio;
      if (!pythonRunner) {
        body.audio_chunk_seconds = form.audio_chunk_seconds;
        body.audio_overlap_seconds = form.audio_overlap_seconds;
      }
    } else {
      body.video_frames = frames;
    }
    return body;
  };

  const submit = async (override?: Record<string, unknown>) => {
    setError(undefined);
    let body = override ?? buildRequest();
    if (!String(body.prompt ?? '').trim()) {
      setError('Write a prompt first.');
      promptRef.current?.focus();
      return;
    }
    try {
      // Speaking a script is a speech job first; its clip then drives the video.
      if (!override && useVoiceScript) {
        if (!voice?.model) throw new Error('Choose a character with a voice to speak the script.');
        if (!form.script.trim()) throw new Error('Write the script for the character to speak.');
        setSubmitting(`Speaking as ${character!.name}…`);
        const speechJob = await api.post<Job>('/v1/jobs/audio', {
          ...voiceParams(voice),
          input: form.script.trim(),
          character_id: character!.id,
        });
        const spoken = await waitForJob(speechJob.id);
        if (spoken.status !== 'completed' || typeof spoken.result?.audio_url !== 'string') {
          throw new Error(spoken.error?.message ?? 'Speech generation failed');
        }
        const clip = await outputToInput(decodeURIComponent(spoken.result.audio_url.split('/').pop()!));
        setForm((state) => ({ ...state, audio: clip, audio_name: `${character!.name}: script` }));
        body = { ...body, audio: clip };
      } else if (speech && !body.audio) {
        throw new Error('Add the speech clip first.');
      }
      setSubmitting('Queueing…');
      const job = await api.post<Job>('/v1/jobs', body);
      setJobs((current) => ({ ...current, [job.id]: job }));
      setFollowed(job.id);
      setSelected(undefined);
      setLastRequest(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(undefined);
    }
  };

  // --- Start image input -------------------------------------------------------

  const uploadImage = async (files: File[]) => {
    const image = files.find((file) => file.type.startsWith('image/'));
    if (!image) return;
    try {
      const uploaded = await api.upload<{ name: string }>('/v1/inputs', image);
      setForm((state) => ({ ...state, init_image: uploaded.name, aspect: 'match' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  React.useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
        file.type.startsWith('image/'),
      );
      if (files.length === 0) return;
      event.preventDefault();
      void uploadImage(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  // --- Viewer ----------------------------------------------------------------

  const followedOutput = followedJob ? outputOf(followedJob) : null;
  const latest = recent.data?.outputs[0];
  const focus: MediaItem | undefined =
    selected ?? followedOutput ?? (followed ? undefined : latest);
  const focusInfo = useResource<OutputInfo>(
    focus ? `/v1/outputs/${encodeURIComponent(focus.name)}/info` : null,
  );
  const focusSettings = settingsOf(focusInfo.data);

  const canSubmit =
    Boolean(form.prompt.trim()) &&
    Boolean(form.model) &&
    !submitting &&
    (!speech || (useVoiceScript ? Boolean(voice?.model && form.script.trim()) : Boolean(form.audio)));

  const seconds = speech ? undefined : frames / fps;

  return (
    <Page
      title="Video generation"
      description="Text-to-video, image-to-video and speech-to-video. Start from any generated or uploaded image, or from a character."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(330px,400px)_minmax(0,1fr)]">
        {/* ---------------- Controls ---------------- */}
        <Card className="flex h-fit flex-col gap-4 p-4 lg:sticky lg:top-[4.5rem] lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist">
            {(['prompt', 'speech'] as const).map((mode) => (
              <button
                key={mode}
                role="tab"
                aria-selected={form.mode === mode}
                onClick={() => update('mode', mode)}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-md py-2 text-sm font-semibold text-muted-foreground transition',
                  form.mode === mode && 'bg-card text-foreground shadow-sm',
                )}
              >
                {mode === 'prompt' ? <Video className="size-3.5" /> : <Mic className="size-3.5" />}
                {mode === 'prompt' ? 'Prompt to video' : 'Speech to video'}
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
                {speech ? (
                  <>
                    No speech-to-video models installed yet. Open <strong>Models</strong> in the top
                    bar and install one whose capabilities include <code>s2v</code>.
                  </>
                ) : (
                  <>
                    No video models installed yet. Open <strong>Models</strong> in the top bar to
                    install one.
                  </>
                )}
              </p>
            ) : (
              <Select
                value={form.model}
                onValueChange={(value) => applyModelDefaults(ready.find((m) => m.id === value))}
                options={ready.map((model) => {
                  const d = modelDefaults(model);
                  return {
                    value: model.id,
                    label: model.name,
                    description: [
                      d.steps && `${d.steps} steps`,
                      d.width && `${d.width}×${d.height}`,
                      d.video_frames && d.fps && `${(d.video_frames / d.fps).toFixed(1)}s @ ${d.fps} fps`,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  };
                })}
                placeholder="Choose a model"
              />
            )}
          </Field>

          <CharacterField
            character={character}
            onChange={pickCharacter}
            imageName={form.init_image}
            onImageChange={(name) => setForm((state) => ({ ...state, init_image: name, aspect: 'match' }))}
            need={speech ? 'voice' : 'image'}
          >
            <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              Describe the character in the prompt
              <Switch
                checked={form.characterPrompt}
                onCheckedChange={(value) => update('characterPrompt', value)}
              />
            </label>
          </CharacterField>

          <Field
            label={speech ? 'Scene' : 'Prompt'}
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
                speech
                  ? 'A woman talking to the camera in a sunlit kitchen, natural gestures'
                  : 'Slow dolly shot through a lantern-lit alley after rain, reflections in puddles'
              }
              rows={4}
              className="text-[15px]"
            />
          </Field>

          {speech ? (
            <Field label="Speech">
              <div className="flex flex-col gap-2.5">
                <div className="grid grid-cols-2 gap-1.5">
                  {(['clip', 'script'] as const).map((source) => (
                    <button
                      key={source}
                      type="button"
                      aria-pressed={form.speechSource === source}
                      onClick={() => update('speechSource', source)}
                      className={cn(
                        'flex items-center justify-center gap-1.5 rounded-md border border-border bg-muted/50 py-1.5 text-xs font-medium transition hover:bg-accent',
                        form.speechSource === source && 'border-primary bg-primary/10 hover:bg-primary/10',
                      )}
                    >
                      {source === 'clip' ? <AudioLines className="size-3.5" /> : <Mic className="size-3.5" />}
                      {source === 'clip' ? 'Audio clip' : 'Character speaks'}
                    </button>
                  ))}
                </div>
                {form.speechSource === 'clip' ? (
                  form.audio ? (
                    <div className="flex flex-col gap-1.5 rounded-lg border border-border p-2">
                      <audio src={inputUrl(form.audio)} controls className="w-full" preload="metadata" />
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[11px] text-muted-foreground">{form.audio_name}</span>
                        <span className="flex gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setPicker('audio')}>
                            Replace…
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Remove audio"
                            onClick={() =>
                              setForm((state) => ({ ...state, audio: undefined, audio_name: undefined }))
                            }
                          >
                            <X />
                          </Button>
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <Button variant="outline" size="sm" onClick={() => setPicker('audio')}>
                        <AudioLines /> From library
                      </Button>
                      <FileButton
                        accept="audio/*,.wav,.mp3,.flac,.ogg"
                        onFiles={async ([file]) => {
                          try {
                            const uploaded = await api.upload<{ name: string }>('/v1/inputs', file);
                            setForm((state) => ({ ...state, audio: uploaded.name, audio_name: file.name }));
                          } catch (err) {
                            setError(err instanceof Error ? err.message : String(err));
                          }
                        }}
                      >
                        <Upload /> From computer
                      </FileButton>
                    </div>
                  )
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <Textarea
                      value={form.script}
                      onChange={(event) => update('script', event.target.value)}
                      rows={3}
                      placeholder={
                        character ? `What ${character.name} says…` : 'Choose a character with a voice first'
                      }
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {voice?.model
                        ? `Spoken in ${character!.name}’s voice (${voiceSummary(voice)}), then lip-synced.`
                        : 'The character’s voice from the Character Studio speaks this, and the clip drives the video.'}
                    </p>
                  </div>
                )}
              </div>
            </Field>
          ) : null}

          {/* Start image */}
          <Field
            label={speech ? 'Speaker image' : 'Start image (image-to-video)'}
            hint={
              form.init_image
                ? undefined
                : speech
                  ? 'Seeds the first segment; later segments chain from the previous one.'
                  : 'Optional. Drop, paste or pick a generated image or an upload.'
            }
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
                void uploadImage(Array.from(event.dataTransfer.files));
              }}
              className={cn(
                'rounded-lg border border-dashed border-input p-2.5 transition',
                dragOver && 'border-primary bg-accent',
              )}
            >
              {form.init_image ? (
                <div className="flex items-center gap-3">
                  <InputThumb
                    name={form.init_image}
                    className="size-20 shrink-0"
                    onRemove={() => update('init_image', undefined)}
                  />
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => setPicker('image')}>
                      <ImagePlus /> Replace…
                    </Button>
                    {refSize ? (
                      <span className="text-center text-[11px] text-muted-foreground tabular-nums">
                        {refSize[0]}×{refSize[1]}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" size="sm" onClick={() => setPicker('image')}>
                    <ImagePlus /> From gallery
                  </Button>
                  <FileButton onFiles={(files) => void uploadImage(files)}>
                    <Upload /> From computer
                  </FileButton>
                </div>
              )}
            </div>
          </Field>

          {form.init_image && !pythonRunner ? (
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
              {(form.init_image ? ['match'] : [])
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
                  step={32}
                  min={128}
                  value={form.customWidth}
                  onChange={(event) => update('customWidth', Number(event.target.value))}
                />
              </Field>
              <Field label="Height">
                <Input
                  type="number"
                  step={32}
                  min={128}
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
                  label: `${res.value}p · ${res.note}${
                    defaults.width && Math.min(defaults.width, defaults.height ?? 0) === res.value
                      ? ' · model default'
                      : ''
                  }`,
                }))}
              />
            </Field>
          )}

          {speech ? null : (
            <Field
              label={
                <span className="flex items-center justify-between">
                  <span>Length</span>
                  <span className="tabular-nums text-foreground">
                    {seconds!.toFixed(1)}s · {frames} frames
                  </span>
                </span>
              }
            >
              <div className="grid grid-cols-5 gap-1.5">
                <button
                  type="button"
                  aria-pressed={form.frames === null}
                  onClick={() => update('frames', null)}
                  className={cn(
                    'rounded-md border border-border bg-muted/50 py-1.5 text-xs font-medium transition hover:bg-accent',
                    form.frames === null && 'border-primary bg-primary/10 hover:bg-primary/10',
                  )}
                  title="The model's trained clip length"
                >
                  Model
                </button>
                {LENGTHS.map((secondsOption) => {
                  const value = snapFrames(secondsOption * fps);
                  return (
                    <button
                      key={secondsOption}
                      type="button"
                      aria-pressed={form.frames === value}
                      onClick={() => update('frames', value)}
                      className={cn(
                        'rounded-md border border-border bg-muted/50 py-1.5 text-xs font-medium transition hover:bg-accent',
                        form.frames === value && 'border-primary bg-primary/10 hover:bg-primary/10',
                      )}
                    >
                      {secondsOption}s
                    </button>
                  );
                })}
              </div>
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

          <details className="group rounded-lg border border-border bg-muted/30 px-3 [&[open]]:pb-3">
            <summary className="flex cursor-pointer list-none items-center justify-between py-2.5 text-sm font-semibold">
              Advanced
              <span className="text-xs font-normal text-muted-foreground group-open:hidden">
                seed, steps, CFG, frames, fps…
              </span>
            </summary>
            <div className="flex flex-col gap-3">
              <Field label="Seed" hint="-1 picks a random seed; the one used is recorded with the video.">
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
                      defaults.cfg_scale !== undefined ? `${defaults.cfg_scale} (model)` : 'model default'
                    }
                    onChange={(event) =>
                      update('cfg_scale', event.target.value ? Number(event.target.value) : null)
                    }
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {speech ? null : (
                  <Field label="Frames" hint="Snapped to 4n+1.">
                    <Input
                      type="number"
                      min={5}
                      max={257}
                      step={4}
                      value={form.frames ?? ''}
                      placeholder={`${defaults.video_frames ?? 33} (model)`}
                      onChange={(event) =>
                        update('frames', event.target.value ? snapFrames(Number(event.target.value)) : null)
                      }
                    />
                  </Field>
                )}
                {pythonRunner ? (
                  <Field label="FPS">
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={form.fps ?? ''}
                      placeholder={`${defaults.fps ?? 24} (model)`}
                      onChange={(event) =>
                        update('fps', event.target.value ? Number(event.target.value) : null)
                      }
                    />
                  </Field>
                ) : (
                  <Field label="Flow shift">
                    <Input
                      type="number"
                      step={0.1}
                      value={form.flow_shift ?? ''}
                      placeholder={defaults.flow_shift !== undefined ? `${defaults.flow_shift} (model)` : '3'}
                      onChange={(event) =>
                        update('flow_shift', event.target.value ? Number(event.target.value) : null)
                      }
                    />
                  </Field>
                )}
              </div>

              {pythonRunner ? null : (
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
              )}

              <Field label="Negative prompt">
                <Textarea
                  value={form.negative_prompt}
                  onChange={(event) => update('negative_prompt', event.target.value)}
                  placeholder="blurry, low quality, static, distorted"
                  rows={2}
                />
              </Field>

              {speech && !pythonRunner ? (
                <>
                  <Field
                    label={`Chunk length · ${form.audio_chunk_seconds}s`}
                    hint="Seconds of speech per generated segment. Past the model's trained window this degrades lip-sync rather than erroring."
                  >
                    <Slider
                      value={form.audio_chunk_seconds}
                      onValueChange={(value) => update('audio_chunk_seconds', value)}
                      min={1}
                      max={15}
                      step={0.5}
                    />
                  </Field>
                  <Field
                    label={`Overlap · ${form.audio_overlap_seconds}s`}
                    hint="How much each segment replays from the previous one, to blend the seam."
                  >
                    <Slider
                      value={form.audio_overlap_seconds}
                      onValueChange={(value) => update('audio_overlap_seconds', value)}
                      min={0}
                      max={2}
                      step={0.1}
                    />
                  </Field>
                </>
              ) : null}

              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setForm((state) => ({
                    ...DEFAULTS,
                    mode: state.mode,
                    model: state.model,
                    prompt: state.prompt,
                    init_image: state.init_image,
                    audio: state.audio,
                    audio_name: state.audio_name,
                    script: state.script,
                    speechSource: state.speechSource,
                  }));
                  applyModelDefaults(selectedModel);
                }}
              >
                <RotateCcw /> Reset settings
              </Button>
            </div>
          </details>

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <div className="sticky bottom-0 -mx-4 -mb-4 flex gap-2 border-t border-border bg-card/95 p-4 backdrop-blur">
            <Button size="lg" className="flex-1" onClick={() => void submit()} disabled={!canSubmit}>
              {submitting ? <Spinner className="size-4" /> : <Sparkles />}
              {submitting ?? 'Generate video'}
            </Button>
            {followedActive ? (
              <Button
                size="lg"
                variant="outline"
                onClick={() => void api.post(`/v1/jobs/${followed}/cancel`)}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </Card>

        {/* ---------------- Player + gallery ---------------- */}
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="overflow-hidden">
            <div className="relative flex min-h-[420px] items-center justify-center bg-black/90">
              {focus ? (
                <video
                  key={focus.url}
                  src={focus.url}
                  controls
                  autoPlay
                  loop
                  playsInline
                  className="max-h-[72vh] max-w-full"
                />
              ) : followedJob && !followedActive && followedJob.status !== 'completed' ? (
                <div className="flex max-w-md flex-col items-center gap-2 p-6 text-center text-xs text-destructive">
                  <Ban className="size-5" />
                  {followedJob.error?.message ?? followedJob.status}
                </div>
              ) : followedActive ? (
                <div className="flex flex-col items-center gap-2 text-xs text-white/70">
                  <Spinner className="size-5" />
                  {followedJob?.status === 'queued' ? 'Queued' : 'Rendering…'}
                </div>
              ) : (
                <div className="p-6">
                  <EmptyState
                    icon={Video}
                    title="Ready when you are"
                    description="Describe a shot, or give it a start image or a character. Results play here and collect in the gallery below."
                  />
                </div>
              )}
              {followedActive && followedJob ? <ProgressOverlay job={followedJob} /> : null}
            </div>

            {focus ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
                <span className="mr-auto min-w-0 truncate text-xs tabular-nums text-muted-foreground">
                  {focusSettings
                    ? [
                        focusSettings.width && `${focusSettings.width}×${focusSettings.height}`,
                        (focusSettings.video_frames ?? focusSettings.frames) &&
                          `${focusSettings.video_frames ?? focusSettings.frames} frames`,
                        focusSettings.fps && `${focusSettings.fps} fps`,
                        focusSettings.audio_chunks && `${focusSettings.audio_chunks} chunks`,
                        focusSettings.seed !== undefined && `seed ${focusSettings.seed}`,
                        focusSettings.duration_ms && formatDuration(focusSettings.duration_ms),
                        focusSettings.model,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : timeAgo(focus.modified)}
                </span>
                {focusSettings ? (
                  <Button size="sm" variant="ghost" onClick={() => applySettings(focusSettings)}>
                    <RotateCcw /> Reuse
                  </Button>
                ) : null}
                {lastRequest ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const { seed: _seed, ...rest } = lastRequest;
                      void submit(rest);
                    }}
                    title="Run the last request again with a new seed"
                  >
                    <Shuffle /> Vary
                  </Button>
                ) : null}
                <Button asChild size="sm" variant="ghost">
                  <a href={focus.url} download aria-label="Download">
                    <Download />
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Delete"
                  className="text-destructive hover:bg-destructive/10"
                  onClick={async () => {
                    if (!window.confirm('Delete this video?')) return;
                    await api.delete(`/v1/outputs/${encodeURIComponent(focus.name)}`);
                    setSelected(undefined);
                    setFollowed(undefined);
                    recent.reload();
                  }}
                >
                  <Trash2 />
                </Button>
                {focusSettings?.prompt ? (
                  <p
                    className="w-full cursor-text select-text text-[12px] leading-snug text-muted-foreground line-clamp-2 hover:line-clamp-none"
                    title="Prompt"
                  >
                    {focusSettings.prompt}
                  </p>
                ) : null}
              </div>
            ) : null}
          </Card>

          {otherActive.length > 0 ? (
            <Card className="flex flex-col gap-2.5 p-3">
              <h3 className="text-xs font-semibold text-muted-foreground">Also in the queue</h3>
              {otherActive.map((job) => (
                <div key={job.id} className="flex items-center gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate">{String(job.params.prompt ?? job.id)}</span>
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
              ))}
            </Card>
          ) : null}

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Recent</h3>
              <span className="text-[11px] text-muted-foreground">
                Hover to preview · click to play and reuse
              </span>
            </div>
            {(recent.data?.outputs.length ?? 0) === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">Nothing yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
                {recent.data!.outputs.map((item) => (
                  <VideoTile
                    key={item.name}
                    item={item}
                    active={focus?.name === item.name}
                    onClick={() => setSelected(item)}
                  />
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <ImagePickerDialog
        open={picker === 'image'}
        onOpenChange={(open) => !open && setPicker(null)}
        title={speech ? 'Choose the speaker image' : 'Choose a start image'}
        max={1}
        onPick={([name]) => setForm((state) => ({ ...state, init_image: name, aspect: 'match' }))}
      />
      <AudioPickerDialog
        open={picker === 'audio'}
        onOpenChange={(open) => !open && setPicker(null)}
        onPick={(name, label) => setForm((state) => ({ ...state, audio: name, audio_name: label }))}
      />
    </Page>
  );
}

/** A gallery tile that previews on hover rather than loading every clip at once. */
function VideoTile({
  item,
  active,
  onClick,
}: {
  item: MediaItem;
  active: boolean;
  onClick: () => void;
}) {
  const ref = React.useRef<HTMLVideoElement>(null);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => void ref.current?.play().catch(() => {})}
      onMouseLeave={() => {
        if (!ref.current) return;
        ref.current.pause();
        ref.current.currentTime = 0;
      }}
      title={`${item.name} · ${timeAgo(item.modified)}`}
      className={cn(
        'group relative aspect-video overflow-hidden rounded-md border border-border bg-black outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
        active && 'ring-2 ring-primary',
      )}
    >
      <video
        ref={ref}
        src={`${item.url}#t=0.1`}
        muted
        loop
        playsInline
        preload="metadata"
        className="size-full object-cover"
      />
      <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[10px] text-white">
        {timeAgo(item.modified)}
      </span>
      {item.name.endsWith('.webm') ? (
        <Badge variant="default" className="absolute right-1 top-1 bg-black/60 text-white">
          <Mic className="size-2.5" />
        </Badge>
      ) : null}
    </button>
  );
}

/** Stage, step count, elapsed and a naive ETA for the job the player follows. */
function ProgressOverlay({ job }: { job: Job }) {
  const running = job.status === 'running';
  const elapsed = useElapsed(job.startedAt ?? job.createdAt);
  const step = job.step ?? 0;
  const eta =
    running && step > 0 && job.totalSteps ? (elapsed / step) * (job.totalSteps - step) : undefined;
  const stage = !running
    ? 'Queued'
    : !job.totalSteps
      ? 'Loading model'
      : step >= job.totalSteps
        ? 'Decoding'
        : 'Sampling';

  return (
    <div className="absolute inset-x-3 bottom-3 flex flex-col gap-2 rounded-lg border border-border bg-card/90 p-3 shadow-lg backdrop-blur">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          <Spinner className="size-3 shrink-0" />
          {stage}
          <span className="truncate text-muted-foreground">· {String(job.params.prompt ?? '')}</span>
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {job.totalSteps ? `${step}/${job.totalSteps} · ` : ''}
          {eta !== undefined ? `~${formatDuration(eta)} left · ` : ''}
          {formatDuration(elapsed)}
        </span>
      </div>
      <Progress value={job.progress} indeterminate={!running || !job.totalSteps} />
    </div>
  );
}
