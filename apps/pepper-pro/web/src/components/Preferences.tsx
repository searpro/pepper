import { Dialog, DialogContent, Field, Select, Spinner, Tabs, TabsContent, TabsList, TabsTrigger } from '@pepper/ui/components/ui';
import { BackendPanel, HuggingFacePanel, IdleTimeoutPanel } from '@pepper/ui/components/settings';
import type { Theme } from '@pepper/ui/components/layout';
import { useResource, type SystemStatus } from '@pepper/ui/lib/api';

/**
 * ComfyUI's and llama.cpp's settings (flags such as reserve_vram and sage
 * attention come from the backend's own declaration), the environment as
 * configured, credentials and appearance.
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
      <DialogContent title="Preferences" description="Engines, environment and appearance." className="[--dialog-w:56rem]">
        <Tabs defaultValue="backends" className="flex flex-col">
          <div className="border-b border-border px-5 py-3">
            <TabsList>
              <TabsTrigger value="backends">Engines</TabsTrigger>
              <TabsTrigger value="environment">Environment</TabsTrigger>
              <TabsTrigger value="credentials">Credentials</TabsTrigger>
              <TabsTrigger value="appearance">Appearance</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="backends" className="flex flex-col gap-3 p-5">
            <p className="mb-1 text-xs text-muted-foreground">
              ComfyUI runs every image, video and audio recipe, one at a time; llama.cpp serves text. Both
              start with the first job that needs them.
            </p>
            {status ? <IdleTimeoutPanel status={status} onChanged={onChanged} /> : null}
            {status?.backends.map((backend) => (
              <BackendPanel key={backend.backend} backend={backend} onChanged={onChanged} />
            ))}
          </TabsContent>
          <TabsContent value="environment" className="p-5">
            <p className="mb-3 text-xs text-muted-foreground">
              Set through the environment when the server starts (PEPPER_TIER, LICENCE_MODE, COMFY_DIR…),
              so read-only here.
            </p>
            {config.loading ? (
              <Spinner />
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
            <Field label="Theme">
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
                Pepper Pro v{status.version} · {status.platform} · {status.accel}
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
