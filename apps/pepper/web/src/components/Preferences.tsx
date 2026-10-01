import * as React from 'react';
import { Check, Download } from 'lucide-react';
import { api, useResource, type BundleInfo, type SystemStatus } from '@pepper/ui/lib/api';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  ErrorNote,
  Field,
  Select,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
} from '@pepper/ui/components/ui';
import { formatBytes } from '@pepper/ui/lib/utils';
import type { UpscalerInfo } from '@/lib/images';
import type { Theme } from '@pepper/ui/components/layout';
import { BackendPanel, HuggingFacePanel, IdleTimeoutPanel } from '@pepper/ui/components/settings';

/**
 * Preferences (requirement 10): the environment as configured, per-backend
 * settings, and appearance.
 *
 * The backend panel is generated from each backend's own argument
 * declaration rather than hand-built per backend, so adding a flag to the
 * server's spec puts a correctly-typed control here with no UI change — which
 * is the point of requirement 5's "clean interface to configure the CLI args".
 */
export function PreferencesDialog({
  open,
  onOpenChange,
  status,
  theme,
  onThemeChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: SystemStatus | undefined;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onChanged: () => void;
}) {
  const config = useResource<Record<string, unknown>>(open ? '/v1/config' : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Preferences"
        description="Backend settings, environment and appearance."
        className="[--dialog-w:56rem]"
      >
        <Tabs defaultValue="backends" className="flex flex-col">
          <div className="border-b border-border px-5 py-3">
            <TabsList>
              <TabsTrigger value="backends">Backends</TabsTrigger>
              <TabsTrigger value="upscalers">Upscalers</TabsTrigger>
              <TabsTrigger value="environment">Environment</TabsTrigger>
              <TabsTrigger value="credentials">Credentials</TabsTrigger>
              <TabsTrigger value="appearance">Appearance</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="backends" className="flex flex-col gap-3 p-5">
            <p className="mb-1 text-xs text-muted-foreground">
              sd.cpp, llama.cpp and audio.cpp are lightweight native servers; vLLM-Omni is the
              heavier CUDA backend for production GPU deployments. Model choice — and which of
              these serves a request — is made here, not on the generation screens: those exist to
              verify a backend works, not as the API's real consumer.
            </p>
            {status ? <IdleTimeoutPanel status={status} onChanged={onChanged} /> : null}
            {status?.backends.some((b) => b.backend === 'vllm') ? (
              <VllmModelPanel onChanged={onChanged} />
            ) : null}
            {status?.backends.some((b) => b.backend === 'python') ? (
              <PythonModelPanel onChanged={onChanged} />
            ) : null}
            {status?.backends.map((backend) => (
              <BackendPanel key={backend.backend} backend={backend} onChanged={onChanged} />
            ))}
          </TabsContent>

          <TabsContent value="upscalers" className="p-5">
            <UpscalersPanel />
          </TabsContent>

          <TabsContent value="environment" className="p-5">
            <p className="mb-3 text-xs text-muted-foreground">
              Set through the environment when the server starts, so they are read-only here. Storage
              paths are all derived from <code className="text-foreground">DATA_DIR</code>.
            </p>
            {config.loading ? (
              <Spinner className="size-4" />
            ) : (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                {Object.entries(config.data ?? {})
                  .filter(([, value]) => typeof value !== 'object' || value === null)
                  .map(([key, value]) => (
                    <div key={key} className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1">
                      <dt className="text-[11px] font-medium text-muted-foreground">{key}</dt>
                      <dd className="truncate text-right font-mono text-[11px]">{String(value)}</dd>
                    </div>
                  ))}
              </dl>
            )}
          </TabsContent>

          <TabsContent value="credentials" className="p-5">
            <HuggingFacePanel />
          </TabsContent>

          <TabsContent value="appearance" className="flex flex-col gap-4 p-5">
            <Field label="Theme" hint="Light by default. System follows your operating system setting.">
              <Select
                value={theme}
                onValueChange={(value) => onThemeChange(value as Theme)}
                options={[
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                  { value: 'system', label: 'System' },
                ]}
                className="w-56"
              />
            </Field>
            {status ? (
              <div className="text-xs text-muted-foreground">
                Pepper v{status.version} · {status.platform} · {status.accel}
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/**
 * vLLM cannot hot-swap models, so "which model" is a setting here rather than
 * a per-request choice (see `routes/vllm.ts`). Only bundles tagged
 * `backend: "vllm"` in their manifest are offered — anything else has no
 * `huggingface_id` for vLLM to load.
 */
function VllmModelPanel({ onChanged }: { onChanged: () => void }) {
  const models = useResource<{ models: BundleInfo[] }>('/v1/models');
  const current = useResource<{ modelId: string | null }>('/v1/vllm/model');
  const gpu = useResource<{ gpuCount: number }>('/v1/vllm/gpu-count');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string>();

  const vllmModels = (models.data?.models ?? []).filter(
    (m) => (m.manifest as { backend?: string } | null)?.backend === 'vllm',
  );

  const select = async (modelId: string) => {
    setSaving(true);
    setError(undefined);
    try {
      await api.put('/v1/vllm/model', { modelId });
      current.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">vLLM-Omni model</span>
        {gpu.data ? (
          <Badge variant="outline">
            {gpu.data.gpuCount} GPU{gpu.data.gpuCount === 1 ? '' : 's'} detected
          </Badge>
        ) : null}
      </div>

      {vllmModels.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No installed model is tagged for vLLM yet. Install one from the catalogue whose entry
          declares a HuggingFace id — it will appear here once downloaded.
        </p>
      ) : (
        <Field
          label="Active model"
          hint="vLLM serves one model per process and restarts on change — this is not a per-request choice."
        >
          <Select
            value={current.data?.modelId ?? ''}
            onValueChange={(value) => void select(value)}
            options={vllmModels.map((m) => ({ value: m.id, label: m.name }))}
            className="w-72"
            disabled={saving}
          />
        </Field>
      )}

      <p className="text-[11px] text-muted-foreground">
        Tensor parallel size, GPU memory utilization and other vLLM flags are in the vLLM-Omni
        panel below. The GPU count above is a hint for setting tensor parallel size — it is not
        applied automatically.
      </p>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </Card>
  );
}

/**
 * The Python backend runs models two ways, and only one needs a setting here.
 *
 * Runner models (Wan 2.2 5B, LTX-Video, EchoMimicV3 — manifests with a
 * `python_runner`) run once per job through Pepper's own runner, exactly like
 * sd-cli: pick them on the Video page, nothing to select or start here.
 *
 * Server models (`python_package` + `python_entrypoint`, e.g. ComfyUI) are a
 * long-running process serving one model, like vLLM — so "which model" is a
 * setting rather than a per-request choice (see `routes/python.ts`).
 */
function PythonModelPanel({ onChanged }: { onChanged: () => void }) {
  const models = useResource<{ models: BundleInfo[] }>('/v1/models');
  const current = useResource<{ modelId: string | null }>('/v1/python/model');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string>();

  const manifestOf = (m: BundleInfo) =>
    m.manifest as { backend?: string; python_runner?: string; python_entrypoint?: string } | null;
  const pythonModels = (models.data?.models ?? []).filter((m) => manifestOf(m)?.backend === 'python');
  const runnerModels = pythonModels.filter((m) => manifestOf(m)?.python_runner);
  const serverModels = pythonModels.filter((m) => manifestOf(m)?.python_entrypoint);

  const select = async (modelId: string) => {
    setSaving(true);
    setError(undefined);
    try {
      await api.put('/v1/python/model', { modelId });
      current.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-3">
      <span className="text-sm font-medium">Python backend</span>

      <p className="text-xs text-muted-foreground">
        {runnerModels.length > 0 ? (
          <>
            <strong className="text-foreground">{runnerModels.map((m) => m.name).join(', ')}</strong>{' '}
            {runnerModels.length === 1 ? 'runs' : 'run'} per job from the Video page — nothing to
            select here.{' '}
          </>
        ) : null}
        Video models like Wan 2.2 5B, LTX-Video and EchoMimicV3 run once per job through
        Pepper&apos;s Python runner. The runtime and its packages (torch, diffusers) install on the
        first job, or ahead of time with Install above. Other resident backends (llama.cpp,
        audio.cpp) are stopped during a Python video job to free memory, and restart on their next
        request.
      </p>

      {serverModels.length > 0 ? (
        <>
          <Field
            label="Server model"
            hint="For server-style Python packages (e.g. ComfyUI), which run as one resident process. Restarts the Python backend on change."
          >
            <Select
              value={current.data?.modelId ?? ''}
              onValueChange={(value) => void select(value)}
              options={serverModels.map((m) => ({ value: m.id, label: m.name }))}
              className="w-72"
              disabled={saving}
            />
          </Field>
          <p className="text-[11px] text-muted-foreground">
            What a server model exposes over HTTP is up to its own entrypoint script — pepper
            reverse-proxies to it unmodified at{' '}
            <code className="text-foreground">/v1/python/proxy/*</code>.
          </p>
        </>
      ) : null}

      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </Card>
  );
}

/**
 * Upscaler checkpoints: which engine runs them, which one each scale uses by
 * default, and the curated list to install more from.
 */
function UpscalersPanel() {
  const info = useResource<UpscalerInfo>('/v1/upscalers');
  const [error, setError] = React.useState<string>();
  const [installing, setInstalling] = React.useState<Set<string>>(new Set());

  const setPrefs = async (patch: Partial<UpscalerInfo['preferences']>) => {
    setError(undefined);
    try {
      await api.put('/v1/upscalers/preferences', patch);
      info.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const install = async (id: string) => {
    setError(undefined);
    setInstalling((current) => new Set(current).add(id));
    try {
      await api.post('/v1/upscalers/install', { id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      info.reload();
    }
  };

  if (info.loading && !info.data) return <Spinner />;
  const data = info.data;
  if (!data) return <ErrorNote>{info.error?.message ?? 'Could not load upscalers'}</ErrorNote>;

  const modelOptions = [
    { value: '__auto', label: 'Automatic', description: 'Best installed checkpoint for the scale' },
    ...data.models.map((model) => ({
      value: model.name,
      label: `${model.label} · ${model.scale}×`,
      description: model.architecture,
    })),
  ];
  const BEST_FOR: Record<string, string> = {
    general: 'General',
    photo: 'Photo',
    illustration: 'Illustration',
    fast: 'Fast',
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Engine"
          hint={
            data.pythonReady
              ? 'Auto uses Python (spandrel) — every architecture, fp16 on the GPU.'
              : 'Auto uses sd-cli until the Python runtime is installed (first video job installs it).'
          }
        >
          <Select
            value={data.preferences.engine}
            onValueChange={(value) => void setPrefs({ engine: value as 'auto' | 'python' | 'sdcpp' })}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'python', label: 'Python (spandrel)', description: 'All architectures; fastest' },
              { value: 'sdcpp', label: 'stable-diffusion.cpp', description: 'Plain RRDBNet models only' },
            ]}
          />
        </Field>
        <Field label="Default for 2×" hint={`Now: ${data.defaults[2] ?? '—'}`}>
          <Select
            value={data.preferences.default_x2 ?? '__auto'}
            onValueChange={(value) => void setPrefs({ default_x2: value === '__auto' ? null : value })}
            options={modelOptions}
          />
        </Field>
        <Field label="Default for 4×" hint={`Now: ${data.defaults[4] ?? '—'}`}>
          <Select
            value={data.preferences.default_x4 ?? '__auto'}
            onValueChange={(value) => void setPrefs({ default_x4: value === '__auto' ? null : value })}
            options={modelOptions}
          />
        </Field>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <section className="flex flex-col gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Recommended upscalers
        </h4>
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {data.catalogue.map((entry) => {
            const busy = installing.has(entry.id) || entry.installing;
            return (
              <div key={entry.id} className="flex items-start gap-3 p-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {entry.label}
                    <Badge variant="outline">{entry.scale}×</Badge>
                    <Badge variant="outline">{entry.architecture}</Badge>
                    <Badge variant="primary">{BEST_FOR[entry.bestFor]}</Badge>
                    {entry.sdcpp ? null : (
                      <Tooltip label="stable-diffusion.cpp cannot load this architecture">
                        <Badge variant="warning">Python</Badge>
                      </Tooltip>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">{entry.description}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {formatBytes(entry.sizeBytes)} · {entry.license}
                  </span>
                </div>
                {entry.installed ? (
                  <Badge variant="success">
                    <Check className="size-2.5" /> Installed
                  </Badge>
                ) : (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void install(entry.id)}>
                    {busy ? <Spinner className="size-3.5" /> : <Download />} Install
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Installed · <code className="normal-case">{data.dir}</code>
        </h4>
        {data.models.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing installed yet.</p>
        ) : (
          <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {data.models.map((model) => (
              <div key={model.name} className="flex items-center gap-3 px-3 py-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-medium">{model.name}</span>
                <span className="text-muted-foreground">{model.scale}×</span>
                <span className="w-16 text-right text-muted-foreground">{formatBytes(model.size)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10"
                  onClick={async () => {
                    if (!window.confirm(`Delete ${model.name}?`)) return;
                    await api.delete(`/v1/upscalers/${encodeURIComponent(model.name)}`);
                    info.reload();
                  }}
                >
                  Delete
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
