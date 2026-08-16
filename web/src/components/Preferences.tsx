import * as React from 'react';
import { Check, Download, Play, RefreshCw, Square, TriangleAlert } from 'lucide-react';
import {
  api,
  useResource,
  type ArgDefinition,
  type BackendStatus,
  type SystemStatus,
} from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  ErrorNote,
  Field,
  Input,
  Select,
  Spinner,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
} from '@/components/ui';
import { backendState, formatBytes } from '@/lib/utils';
import type { Theme } from '@/components/layout';

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
              <TabsTrigger value="environment">Environment</TabsTrigger>
              <TabsTrigger value="credentials">Credentials</TabsTrigger>
              <TabsTrigger value="appearance">Appearance</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="backends" className="flex flex-col gap-3 p-5">
            {status?.backends.map((backend) => (
              <BackendPanel key={backend.backend} backend={backend} onChanged={onChanged} />
            ))}
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

function BackendPanel({ backend, onChanged }: { backend: BackendStatus; onChanged: () => void }) {
  const [values, setValues] = React.useState<Record<string, string | number | boolean | null>>({});
  const [extraArgs, setExtraArgs] = React.useState(backend.extraArgs.join(' '));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [expanded, setExpanded] = React.useState(false);

  const editable = backend.args.filter((arg) => !arg.locked);
  const locked = backend.args.filter((arg) => arg.locked);

  const valueOf = (arg: ArgDefinition) =>
    Object.prototype.hasOwnProperty.call(values, arg.key) ? values[arg.key] : arg.value;

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const merged: Record<string, string | number | boolean | null> = {};
      for (const arg of editable) {
        const value = valueOf(arg);
        // Only send what differs from the seeded default, so a later change to
        // the default still reaches deployments that never touched the field.
        if (value !== arg.defaultValue) merged[arg.key] = value;
      }
      await api.put(`/v1/backends/${backend.backend}/args`, {
        values: merged,
        extraArgs: extraArgs.split(/\s+/).filter(Boolean),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const act = async (action: 'start' | 'stop' | 'restart' | 'install') => {
    setError(undefined);
    try {
      await api.post(`/v1/backends/${backend.backend}/${action}`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Shared with the header pills, so a CLI backend cannot read "ready" up
  // there and "stopped" down here — sd-cli has no process to be either.
  const state = backendState(backend);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{backend.label}</span>
            <Tooltip label={state.label}>
              <Badge variant={state.variant} className="cursor-default">
                {state.state}
              </Badge>
            </Tooltip>
            {backend.installed ? (
              <Tooltip label={backend.binaryPath ?? ''}>
                <Badge variant="outline">{backend.releaseTag}</Badge>
              </Tooltip>
            ) : (
              <Badge variant="outline">not installed</Badge>
            )}
          </div>
          <span className="truncate text-[11px] text-muted-foreground">
            {backend.releaseRepo}
            {backend.stats
              ? ` · ${formatBytes(backend.stats.rssKb * 1024)} resident${
                  backend.stats.swapKb ? ` · ${formatBytes(backend.stats.swapKb * 1024)} swapped` : ''
                }`
              : ''}
            {backend.restarts > 0 ? ` · ${backend.restarts} restart(s)` : ''}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {/* Outline rather than ghost: these were invisible until hovered, so
              a backend that needed installing looked like it had no controls. */}
          <Tooltip label="Install or update to the latest release">
            <Button variant="outline" size="sm" onClick={() => void act('install')}>
              <Download />
              {backend.installed ? 'Update' : 'Install'}
            </Button>
          </Tooltip>
          {backend.kind === 'server' ? (
            <>
              <Tooltip label="Start">
                <Button variant="outline" size="icon-sm" onClick={() => void act('start')}>
                  <Play />
                </Button>
              </Tooltip>
              <Tooltip label="Stop">
                <Button variant="outline" size="icon-sm" onClick={() => void act('stop')}>
                  <Square />
                </Button>
              </Tooltip>
              <Tooltip label="Restart">
                <Button variant="outline" size="icon-sm" onClick={() => void act('restart')}>
                  <RefreshCw />
                </Button>
              </Tooltip>
            </>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Hide settings' : 'Settings'}
          </Button>
        </div>
      </div>

      {backend.lastError ? (
        <p className="flex items-start gap-2 border-t border-border bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          {backend.lastError}
        </p>
      ) : null}

      {backend.lastRestartReason ? (
        <p className="border-t border-border bg-[var(--warning)]/8 px-3 py-1.5 text-[11px] text-muted-foreground">
          Last automatic restart: {backend.lastRestartReason}
        </p>
      ) : null}

      {expanded ? (
        <div className="flex flex-col gap-4 border-t border-border bg-muted/30 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {editable.map((arg) => (
              <Field key={arg.key} label={`${arg.label}  ·  ${arg.flag}`} hint={arg.description}>
                <ArgControl
                  arg={arg}
                  value={valueOf(arg)}
                  onChange={(value) => setValues((current) => ({ ...current, [arg.key]: value }))}
                />
              </Field>
            ))}
          </div>

          <Field
            label="Additional arguments"
            hint="Passed verbatim, for flags this form does not model yet."
          >
            <Input
              value={extraArgs}
              onChange={(event) => setExtraArgs(event.target.value)}
              placeholder="--some-flag value"
              className="font-mono text-xs"
            />
          </Field>

          {locked.length > 0 ? (
            <Field
              label="Managed by the app"
              hint="Bind address, port and model paths are set by the process manager — a backend on anything but loopback would be an unauthenticated inference server."
            >
              <div className="flex flex-wrap gap-1.5">
                {locked.map((arg) => (
                  <Badge key={arg.key} variant="outline" className="font-mono">
                    {arg.flag} {String(arg.value ?? '')}
                  </Badge>
                ))}
              </div>
            </Field>
          ) : null}

          <Field label="Effective command line">
            <pre className="overflow-x-auto rounded-md bg-background p-2 font-mono text-[11px] scrollbar-thin">
              {backend.binaryPath ?? backend.backend} {backend.argv.join(' ')}
            </pre>
          </Field>

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <div className="flex justify-end">
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner className="size-3.5" /> : <Check />}
              Save and restart
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function ArgControl({
  arg,
  value,
  onChange,
}: {
  arg: ArgDefinition;
  value: string | number | boolean | null;
  onChange: (value: string | number | boolean | null) => void;
}) {
  if (arg.type === 'boolean') {
    return (
      <div className="flex h-9 items-center">
        <Switch checked={value === true} onCheckedChange={onChange} />
      </div>
    );
  }
  if (arg.type === 'enum' && arg.options) {
    return (
      <Select
        value={String(value ?? '')}
        onValueChange={onChange}
        options={arg.options.map((option) => ({ value: option, label: option }))}
      />
    );
  }
  return (
    <Input
      type={arg.type === 'number' ? 'number' : 'text'}
      value={value === null || value === undefined ? '' : String(value)}
      min={arg.min}
      max={arg.max}
      // An emptied field means "drop this flag" rather than "send an empty
      // string" — that is how the backend's own default is restored.
      onChange={(event) => {
        const raw = event.target.value;
        if (raw === '') return onChange(null);
        onChange(arg.type === 'number' ? Number(raw) : raw);
      }}
      placeholder={arg.defaultValue === null ? 'backend default' : String(arg.defaultValue ?? '')}
    />
  );
}

function HuggingFacePanel() {
  const auth = useResource<{ valid: boolean; name?: string; error?: string; token?: string }>(
    '/v1/auth/hf',
  );
  const [token, setToken] = React.useState('');
  const [result, setResult] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);

  const verify = async () => {
    setBusy(true);
    try {
      const response = await api.post<{ valid: boolean; name?: string; error?: string }>(
        '/v1/auth/hf/verify',
        { token },
      );
      setResult(response.valid ? `Valid — signed in as ${response.name}` : (response.error ?? 'Invalid token'));
      auth.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">HuggingFace</span>
        {auth.data?.valid ? (
          <Badge variant="success">signed in as {auth.data.name}</Badge>
        ) : (
          <Badge variant="outline">no valid token</Badge>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Gated and private repositories need a token. The durable setting is the{' '}
        <code className="text-foreground">HF_TOKEN</code> environment variable; a token entered here is
        held in memory for this process only and is never written to disk or returned by the API.
      </p>

      <div className="flex items-end gap-2">
        <Field label="Token" className="flex-1">
          <Input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="hf_…"
          />
        </Field>
        <Button onClick={() => void verify()} disabled={!token || busy}>
          {busy ? <Spinner className="size-4" /> : <Check />}
          Verify
        </Button>
      </div>

      {result ? <p className="text-xs text-muted-foreground">{result}</p> : null}
    </div>
  );
}
