import * as React from 'react';
import { AudioLines, Mic, Play, Upload, Volume2 } from 'lucide-react';
import { api, useResource, waitForJob, type BundleInfo } from '@/lib/api';
import {
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Select,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { Page } from '@/components/layout';

interface VoiceRef {
  name: string;
  size: number;
  url: string;
}

/**
 * Speech, voice design and transcription (requirement 2), with the player the
 * generation screens are required to have.
 *
 * Speech goes through the job queue like every other generation. audio.cpp
 * holds a whole model in memory per request, so leaving it outside the queue
 * meant `MAX_CONCURRENT_JOBS` only ever bounded images and a clip could load a
 * second model alongside a running image job. The clip is fetched back from
 * `OUTPUT_DIR` afterwards, which is also what puts it in the media library.
 *
 * `POST /v1/audio/speech` still returns audio inline for API clients.
 */
export function AudioPage() {
  const models = useResource<{ models: BundleInfo[] }>('/v1/models?kind=audio');
  const voiceRefs = useResource<{ voiceRefs: VoiceRef[] }>('/v1/audio/voice-refs');

  const ready = (models.data?.models ?? []).filter((model) => model.ready);
  const ttsModels = ready.filter((model) => (model.manifest?.task as string) !== 'asr');
  const asrModels = ready.filter((model) => (model.manifest?.task as string) === 'asr');

  return (
    <Page
      title="Audio"
      description="Speech generation, voice design and transcription through audio.cpp."
    >
      <Tabs defaultValue="speech">
        <TabsList>
          <TabsTrigger value="speech">
            <Volume2 className="size-3.5" /> Speech
          </TabsTrigger>
          <TabsTrigger value="transcribe">
            <Mic className="size-3.5" /> Transcription
          </TabsTrigger>
          <TabsTrigger value="voices">
            <AudioLines className="size-3.5" /> Voice references
          </TabsTrigger>
        </TabsList>

        <TabsContent value="speech" className="mt-4">
          <SpeechPanel
            models={ttsModels}
            voiceRefs={voiceRefs.data?.voiceRefs ?? []}
            loading={models.loading}
          />
        </TabsContent>

        <TabsContent value="transcribe" className="mt-4">
          <TranscribePanel models={asrModels} loading={models.loading} />
        </TabsContent>

        <TabsContent value="voices" className="mt-4">
          <VoiceRefPanel voiceRefs={voiceRefs.data?.voiceRefs ?? []} onChange={voiceRefs.reload} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

function SpeechPanel({
  models,
  voiceRefs,
  loading,
}: {
  models: BundleInfo[];
  voiceRefs: VoiceRef[];
  loading: boolean;
}) {
  const [model, setModel] = React.useState('');
  const [text, setText] = React.useState('');
  const [voiceRef, setVoiceRef] = React.useState<string>();
  const [voice, setVoice] = React.useState<string>();
  const [instructions, setInstructions] = React.useState('');
  const [audioUrl, setAudioUrl] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();

  React.useEffect(() => {
    if (!model && models.length > 0) setModel(models[0].id);
  }, [models, model]);

  const selected = models.find((entry) => entry.id === model);

  /**
   * Voice design synthesises a speaker from an instruction instead of cloning
   * one from audio. The server does not reject a `vdes` request that omits it —
   * it falls back to some default speaker — which is precisely why the field is
   * surfaced: without it the model's entire point is silently skipped, and the
   * user gets an arbitrary voice with nothing indicating why.
   */
  const isVoiceDesign =
    (selected?.manifest?.task as string) === 'vdes' ||
    (selected?.manifest?.task as string) === 'voice-design';

  // Packaged speakers and configured presets, which only some families ship.
  const voices = useResource<{ voices: string[] }>(
    model ? `/v1/audio/voices?model=${encodeURIComponent(model)}` : null,
  );
  const builtInVoices = voices.data?.voices ?? [];

  // A voice picked for one model means nothing to the next.
  React.useEffect(() => setVoice(undefined), [model]);

  const generate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const job = await api.post<{ id: string }>('/v1/jobs/audio', {
        model,
        input: text,
        ...(voice ? { voice } : {}),
        ...(voiceRef ? { voice_ref: voiceRef } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      });

      // The queue is the point — the clip is fetched from OUTPUT_DIR once the
      // job lands, so it also appears in Jobs and in the media library.
      const finished = await waitForJob(job.id);
      if (finished.status === 'failed') {
        throw new Error(finished.error?.message ?? 'Speech generation failed');
      }
      const url = finished.result?.audio_url as string | undefined;
      if (url) setAudioUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3" /> Loading audio models…
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <EmptyState
        icon={Volume2}
        title="No speech models installed"
        description="Open Models in the top bar to install a TTS or voice-design model from the catalogue."
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(320px,420px)_1fr]">
      <Card className="flex flex-col gap-4 p-4">
        <Field label="Model">
          <Select
            value={model}
            onValueChange={setModel}
            options={models.map((entry) => ({
              value: entry.id,
              label: entry.name,
              description: (entry.manifest?.family as string) ?? undefined,
            }))}
          />
        </Field>

        <Field label="Text">
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={6}
            placeholder="Type what you want spoken."
          />
        </Field>

        {isVoiceDesign ? (
          <Field
            label="Voice direction"
            hint="Describe the voice to synthesise — age, tone, pace, accent. Without it this model picks an arbitrary speaker."
          >
            <Textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={2}
              placeholder="A warm adult narrator, unhurried, slightly gravelly."
            />
          </Field>
        ) : null}

        {builtInVoices.length > 0 ? (
          <Field
            label="Speaker"
            hint="Voices packaged with this model, plus any presets its manifest defines."
          >
            <Select
              value={voice ?? ''}
              onValueChange={(value) => setVoice(value || undefined)}
              options={[
                { value: '', label: 'Model default' },
                ...builtInVoices.map((name) => ({ value: name, label: name })),
              ]}
              placeholder="Model default"
            />
          </Field>
        ) : null}

        <Field
          label="Voice reference"
          hint="For voice cloning. Upload clips in the Voice references tab."
        >
          <Select
            value={voiceRef ?? ''}
            onValueChange={(value) => setVoiceRef(value || undefined)}
            options={[
              { value: '', label: 'None' },
              ...voiceRefs.map((ref) => ({ value: ref.name, label: ref.name })),
            ]}
            placeholder="None"
          />
        </Field>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <Button
          onClick={() => void generate()}
          disabled={!text || !model || busy}
        >
          {busy ? <Spinner className="size-4" /> : <Play />}
          Generate speech
        </Button>
      </Card>

      <Card className="flex min-h-[240px] flex-col items-center justify-center gap-4 p-6">
        {audioUrl ? (
          <div className="flex w-full max-w-lg flex-col gap-3">
            <audio src={audioUrl} controls className="w-full" autoPlay />
            <a
              href={audioUrl}
              download="speech.wav"
              className="self-center text-xs text-primary hover:underline"
            >
              Download clip
            </a>
          </div>
        ) : (
          <EmptyState
            icon={Volume2}
            title="Nothing generated yet"
            description="Generated speech plays here as soon as it is ready."
          />
        )}
      </Card>
    </div>
  );
}

function TranscribePanel({ models, loading }: { models: BundleInfo[]; loading: boolean }) {
  const [model, setModel] = React.useState('');
  const [result, setResult] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();

  React.useEffect(() => {
    if (!model && models.length > 0) setModel(models[0].id);
  }, [models, model]);

  const transcribe = async (file: File) => {
    setBusy(true);
    setError(undefined);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('model', model);

      const response = await fetch('/v1/audio/transcriptions', { method: 'POST', body: form });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message ?? `${response.status} ${response.statusText}`);
      }
      const body = await response.json();
      setResult(typeof body === 'string' ? body : (body.text ?? JSON.stringify(body, null, 2)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner className="size-4" />;

  if (models.length === 0) {
    return (
      <EmptyState
        icon={Mic}
        title="No transcription models installed"
        description='Install a model whose manifest declares task: "asr" from the catalogue.'
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(320px,420px)_1fr]">
      <Card className="flex flex-col gap-4 p-4">
        <Field label="Model">
          <Select
            value={model}
            onValueChange={setModel}
            options={models.map((entry) => ({ value: entry.id, label: entry.name }))}
          />
        </Field>

        <Field label="Audio file">
          <label>
            <input
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void transcribe(file);
              }}
            />
            <span className="flex h-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-input text-xs text-muted-foreground hover:bg-accent">
              <Upload className="size-4" />
              Choose an audio file to transcribe
            </span>
          </label>
        </Field>

        {busy ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3" /> Transcribing…
          </div>
        ) : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </Card>

      <Card className="min-h-[240px] p-4">
        {result ? (
          <pre className="whitespace-pre-wrap text-xs leading-relaxed">{result}</pre>
        ) : (
          <EmptyState icon={Mic} title="No transcript yet" description="Upload a clip to transcribe it." />
        )}
      </Card>
    </div>
  );
}

function VoiceRefPanel({ voiceRefs, onChange }: { voiceRefs: VoiceRef[]; onChange: () => void }) {
  const [busy, setBusy] = React.useState(false);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      // The voice-ref endpoint takes the raw body rather than a multipart form:
      // its route scope swaps in a no-op multipart parser so transcription
      // uploads can be forwarded untouched.
      await fetch('/v1/audio/voice-refs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4 p-4">
      <Field label="Upload a reference clip" hint="A short, clean WAV of the target voice works best.">
        <label>
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <span className="flex h-16 cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-input text-xs text-muted-foreground hover:bg-accent">
            {busy ? <Spinner className="size-3" /> : <Upload className="size-4" />}
            Upload voice reference
          </span>
        </label>
      </Field>

      {voiceRefs.length === 0 ? (
        <EmptyState icon={AudioLines} title="No voice references" />
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {voiceRefs.map((ref) => (
            <div key={ref.name} className="flex items-center gap-3 py-2">
              <audio src={ref.url} controls className="h-8 flex-1" preload="none" />
              <span className="w-40 truncate text-xs text-muted-foreground">{ref.name}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await api.delete(`/v1/audio/voice-refs/${encodeURIComponent(ref.name)}`);
                  onChange();
                }}
              >
                Delete
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
