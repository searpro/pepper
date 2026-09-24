import * as React from 'react';
import {
  Ban,
  Download,
  Mic,
  RefreshCw,
  Sparkles,
  Upload,
  Video,
  Wand2,
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
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { Page } from '@/components/layout';
import { formatDuration, timeAgo } from '@/lib/utils';

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

/** Where an uploaded input is served from, for the thumbnails. */
const inputUrl = (name: string) => `/v1/inputs/${encodeURIComponent(name)}`;

interface FormState {
  prompt: string;
  negative_prompt: string;
  model: string;
  steps: number;
  cfg_scale: number;
  width: number;
  height: number;
  seed: number;
  sampler: string;
  init_image?: string;
  strength: number;
  video_frames: number;
  flow_shift: number;
  audio?: string;
  audio_name?: string;
  audio_chunk_seconds: number;
  audio_overlap_seconds: number;
}

const DEFAULTS: FormState = {
  prompt: '',
  negative_prompt: '',
  model: '',
  steps: 20,
  cfg_scale: 7,
  width: 1024,
  height: 1024,
  seed: -1,
  sampler: 'euler_a',
  strength: 0.75,
  video_frames: 33,
  flow_shift: 3,
  audio_chunk_seconds: 5,
  audio_overlap_seconds: 0.5,
};

/** The video screen's tabs. Speech-to-video is its own entry point. */
type VideoTab = 'prompt' | 'speech';

/**
 * Video generation (requirement 10: a generation screen with a preview/player
 * alongside the controls). Images have their own screen, `pages/Image.tsx`.
 */
export function GeneratePage() {
  const models = useResource<{ models: BundleInfo[] }>('/v1/models?kind=video');
  const [form, setForm] = React.useState<FormState>(DEFAULTS);
  const [error, setError] = React.useState<string>();
  const [submitting, setSubmitting] = React.useState(false);
  const [activeJobs, setActiveJobs] = React.useState<Job[]>([]);
  const [tab, setTab] = React.useState<VideoTab>('prompt');
  const recent = useResource<{ outputs: MediaItem[] }>('/v1/outputs?kind=video&limit=12');

  const speech = tab === 'speech';

  // The Speech to Video tab only offers models that declare the capability:
  // the server rejects the rest, and a picker that lists a model the request
  // cannot use is a worse way to find that out than not listing it.
  const ready = React.useMemo(() => {
    const usable = (models.data?.models ?? []).filter((model) => model.ready);
    return speech ? usable.filter((model) => model.capabilities?.includes('s2v')) : usable;
  }, [models.data, speech]);

  // Select the first usable model once they load, so a fresh install with one
  // model installed does not make the user pick it before generating. Switching
  // tabs re-runs this: the previously selected model may not be in the new
  // tab's list at all.
  React.useEffect(() => {
    setForm((state) =>
      state.model && ready.some((model) => model.id === state.model)
        ? state
        : { ...state, model: ready[0]?.id ?? '' },
    );
  }, [ready]);

  // Live job updates. Everything on this screen that moves — progress bars,
  // the result appearing — comes from here rather than from polling.
  useEventStream(
    '/v1/jobs/stream',
    (event, data) => {
      const job = data as Job;
      if (!job?.id || job.kind !== 'video') return;

      setActiveJobs((jobs) => {
        const next = jobs.some((existing) => existing.id === job.id)
          ? jobs.map((existing) => (existing.id === job.id ? job : existing))
          : [job, ...jobs];
        return next.slice(0, 8);
      });

      if (event === 'completed') recent.reload();
    },
    ['created', 'updated', 'progress', 'completed', 'failed'],
  );

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((state) => ({ ...state, [key]: value }));

  const submit = async () => {
    setError(undefined);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        prompt: form.prompt,
        model: form.model,
        steps: form.steps,
        cfg_scale: form.cfg_scale,
        width: form.width,
        height: form.height,
        sampler: form.sampler,
      };
      if (form.negative_prompt) body.negative_prompt = form.negative_prompt;
      // -1 means "random" to sd-cli, but omitting it entirely is what actually
      // gives a different image each run.
      if (form.seed >= 0) body.seed = form.seed;
      if (form.init_image) {
        body.init_image = form.init_image;
        body.strength = form.strength;
      }
      body.flow_shift = form.flow_shift;
      if (speech) {
        // The audio's length decides the frame count, chunk by chunk, so
        // sending `video_frames` here would only fight the orchestrator.
        body.audio = form.audio;
        body.audio_chunk_seconds = form.audio_chunk_seconds;
        body.audio_overlap_seconds = form.audio_overlap_seconds;
      } else {
        body.video_frames = form.video_frames;
      }

      await api.post('/v1/jobs', body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const uploadInit = async (file: File) => {
    try {
      const result = await api.upload<{ name: string }>('/v1/inputs', file);
      update('init_image', result.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const uploadAudio = async (file: File) => {
    try {
      const result = await api.upload<{ name: string }>('/v1/inputs', file);
      // The stored name is a generated one; keeping the original alongside it
      // is what lets the user tell two uploads apart in the UI.
      setForm((state) => ({ ...state, audio: result.name, audio_name: file.name }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Page
      title="Video generation"
      description="Wan text-to-video, image-to-video and speech-to-video. Runs take considerably longer than an image."
    >
      {/* Speech to video is a distinct entry point, not a hidden mode: it takes
          a different input and only some video models can do it. */}
      <Tabs value={tab} onValueChange={(value) => setTab(value as VideoTab)} className="mb-4">
        <TabsList>
          <TabsTrigger value="prompt">
            <Video className="size-3.5" />
            Prompt to video
          </TabsTrigger>
          <TabsTrigger value="speech">
            <Mic className="size-3.5" />
            Speech to video
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid gap-4 xl:grid-cols-[minmax(320px,380px)_1fr]">
        {/* Controls */}
        <Card className="flex h-fit flex-col gap-4 p-4">
          {speech ? (
            <Field
              label="Speech"
              hint="WAV or MP3. Longer clips are rendered in chunks and joined, so runtime scales with length."
            >
              <div className="flex items-center gap-2">
                <label className="flex-1">
                  <input
                    type="file"
                    accept="audio/wav,audio/mpeg,audio/x-wav,.wav,.mp3,.flac,.ogg"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void uploadAudio(file);
                      event.target.value = '';
                    }}
                  />
                  <span className="flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-input px-3 text-xs text-muted-foreground hover:bg-accent">
                    <Upload className="size-3.5" />
                    {form.audio ? 'Replace audio' : 'Upload audio'}
                  </span>
                </label>
                {form.audio ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove audio"
                    onClick={() =>
                      setForm((state) => ({ ...state, audio: undefined, audio_name: undefined }))
                    }
                  >
                    <Ban />
                  </Button>
                ) : null}
              </div>
            </Field>
          ) : null}

          {speech && form.audio ? (
            <div className="flex flex-col gap-2">
              <audio src={inputUrl(form.audio)} controls className="w-full" preload="metadata" />
              <p className="truncate text-[11px] text-muted-foreground">{form.audio_name}</p>
            </div>
          ) : null}

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
                onValueChange={(value) => update('model', value)}
                options={ready.map((model) => ({ value: model.id, label: model.name }))}
                placeholder="Choose a model"
              />
            )}
          </Field>

          <Field label="Prompt">
            <Textarea
              value={form.prompt}
              onChange={(event) => update('prompt', event.target.value)}
              placeholder="A lantern-lit alley after rain, cinematic lighting"
              rows={4}
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

          <div className="grid grid-cols-2 gap-3">
            <Field label="Width">
              <Input
                type="number"
                step={8}
                value={form.width}
                onChange={(event) => update('width', Number(event.target.value))}
              />
            </Field>
            <Field label="Height">
              <Input
                type="number"
                step={8}
                value={form.height}
                onChange={(event) => update('height', Number(event.target.value))}
              />
            </Field>
          </div>

          <Field label={`Steps · ${form.steps}`}>
            <Slider value={form.steps} onValueChange={(value) => update('steps', value)} min={1} max={100} />
          </Field>

          <Field label={`CFG scale · ${form.cfg_scale}`}>
            <Slider
              value={form.cfg_scale}
              onValueChange={(value) => update('cfg_scale', value)}
              min={0}
              max={20}
              step={0.5}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Sampler">
              <Select
                value={form.sampler}
                onValueChange={(value) => update('sampler', value)}
                options={SAMPLERS.map((sampler) => ({ value: sampler, label: sampler }))}
              />
            </Field>
            <Field label="Seed" hint="-1 for random">
              <Input
                type="number"
                value={form.seed}
                onChange={(event) => update('seed', Number(event.target.value))}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* With speech, the audio's length sets the frame count. */}
            {speech ? null : (
              <Field label="Frames">
                <Input
                  type="number"
                  value={form.video_frames}
                  onChange={(event) => update('video_frames', Number(event.target.value))}
                />
              </Field>
            )}
            <Field label="Flow shift">
              <Input
                type="number"
                step={0.1}
                value={form.flow_shift}
                onChange={(event) => update('flow_shift', Number(event.target.value))}
              />
            </Field>
          </div>
          {speech ? (
            <details className="rounded-md border border-border px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                Advanced
              </summary>
              <div className="mt-3 flex flex-col gap-3">
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
                  hint="How much each segment replays from the previous one, to blend the seam. Trimmed back out when the segments are joined."
                >
                  <Slider
                    value={form.audio_overlap_seconds}
                    onValueChange={(value) => update('audio_overlap_seconds', value)}
                    min={0}
                    max={2}
                    step={0.1}
                  />
                </Field>
              </div>
            </details>
          ) : null}

          <Field
            label={
              speech
                ? 'Speaker image (optional)'
                : 'Conditioning image (image-to-video)'
            }
            hint={speech ? 'Seeds the first segment; later segments chain from the previous one.' : undefined}
          >
            <div className="flex items-center gap-2">
              <label className="flex-1">
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadInit(file);
                  }}
                />
                <span className="flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-input px-3 text-xs text-muted-foreground hover:bg-accent">
                  <Upload className="size-3.5" />
                  {form.init_image ? 'Replace image' : 'Upload image'}
                </span>
              </label>
              {form.init_image ? (
                <Button variant="ghost" size="icon-sm" onClick={() => update('init_image', undefined)}>
                  <Ban />
                </Button>
              ) : null}
            </div>
          </Field>

          {form.init_image ? (
            <>
              <img
                src={inputUrl(form.init_image)}
                alt="Init image"
                className="h-28 w-full rounded-md border border-border object-contain bg-muted"
              />
              <Field label={`Denoising strength · ${form.strength}`}>
                <Slider
                  value={form.strength}
                  onValueChange={(value) => update('strength', value)}
                  min={0}
                  max={1}
                  step={0.05}
                />
              </Field>
            </>
          ) : null}

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <Button
            onClick={() => void submit()}
            disabled={!form.prompt || !form.model || submitting || (speech && !form.audio)}
          >
            {submitting ? <Spinner className="size-4" /> : <Sparkles />}
            Generate
          </Button>
        </Card>

        {/* Preview + queue */}
        <div className="flex flex-col gap-4">
          <ActiveJobs jobs={activeJobs} />

          <Card className="flex min-h-[320px] flex-col p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Recent videos</h3>
              <Button variant="ghost" size="icon-sm" onClick={recent.reload} aria-label="Refresh">
                <RefreshCw />
              </Button>
            </div>

            {(recent.data?.outputs.length ?? 0) === 0 ? (
              <EmptyState
                icon={Video}
                title="No videos yet"
                description="Generated results appear here and in the Media library."
              />
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {recent.data?.outputs.map((item) => (
                  <PreviewTile key={item.name} item={item} />
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
}

function ActiveJobs({ jobs }: { jobs: Job[] }) {
  const live = jobs.filter((job) => job.status === 'queued' || job.status === 'running');
  if (live.length === 0) return null;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h3 className="text-sm font-semibold">In progress</h3>
      {live.map((job) => (
        <div key={job.id} className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="truncate text-muted-foreground">
              {String(job.params.prompt ?? '').slice(0, 80) || job.id}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {job.status === 'queued'
                ? 'queued'
                : job.totalSteps
                  ? `${job.step ?? 0}/${job.totalSteps}`
                  : `${Math.round(job.progress * 100)}%`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Progress value={job.progress} indeterminate={job.status === 'queued'} className="flex-1" />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void api.post(`/v1/jobs/${job.id}/cancel`)}
              aria-label="Cancel"
            >
              <Ban />
            </Button>
          </div>
        </div>
      ))}
    </Card>
  );
}

/** A result tile that plays the video inline rather than linking away from it. */
function PreviewTile({ item }: { item: MediaItem }) {
  return (
    <figure className="group relative overflow-hidden rounded-lg border border-border bg-muted">
      <video src={item.url} controls className="aspect-square w-full object-cover" preload="metadata" />
      <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
        <span className="truncate text-[10px] text-white/90">{timeAgo(item.modified)}</span>
        <a
          href={item.url}
          download
          className="pointer-events-auto rounded bg-white/15 p-1 text-white hover:bg-white/25"
          aria-label="Download"
        >
          <Download className="size-3" />
        </a>
      </figcaption>
    </figure>
  );
}

/** Shown on the job list when a result carries timing metadata. */
export function JobDurationBadge({ job }: { job: Job }) {
  const duration = (job.result?.metadata as { duration_ms?: number } | undefined)?.duration_ms;
  if (!duration) return null;
  return (
    <Badge variant="outline">
      <Wand2 className="size-2.5" />
      {formatDuration(duration)}
    </Badge>
  );
}
