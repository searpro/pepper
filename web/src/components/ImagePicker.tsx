import * as React from 'react';
import { Check, Image as ImageIcon, Library, Upload } from 'lucide-react';
import { api, useResource, type MediaItem } from '@/lib/api';
import { outputToInput } from '@/lib/images';
import {
  Button,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorNote,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { cn, timeAgo } from '@/lib/utils';

/**
 * Choose init or reference images from what is already on the server —
 * generated images or earlier uploads — or from the computer.
 *
 * Whatever is picked comes back as *upload* names, since that is what
 * `init_image` and `ref_images` take: generated images are copied into
 * uploads on the way out (see `POST /v1/inputs/from-output`).
 */
export function ImagePickerDialog({
  open,
  onOpenChange,
  title,
  max,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** How many may be picked at once; 1 makes it a single-select. */
  max: number;
  onPick: (names: string[]) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          title={title}
          description="Pick from generated images or earlier uploads, or choose a file from this computer."
          className="[--dialog-w:60rem] h-[80vh]"
        >
          <PickerBody
            max={max}
            onPick={(names) => {
              onPick(names);
              onOpenChange(false);
            }}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

type Source = 'output' | 'upload';

function PickerBody({ max, onPick }: { max: number; onPick: (names: string[]) => void }) {
  const outputs = useResource<{ outputs: MediaItem[] }>('/v1/outputs?kind=image&limit=300');
  const uploads = useResource<{ uploads: MediaItem[] }>('/v1/inputs');
  const [tab, setTab] = React.useState<Source>('output');
  const [selected, setSelected] = React.useState<{ name: string; source: Source }[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const fileInput = React.useRef<HTMLInputElement>(null);

  const uploadImages = (uploads.data?.uploads ?? []).filter((item) => item.kind === 'image');

  const toggle = (name: string, source: Source) => {
    if (max === 1) {
      // Single-select picks on click: a confirm step for one image is noise.
      void finish([{ name, source }]);
      return;
    }
    setSelected((current) =>
      current.some((item) => item.name === name)
        ? current.filter((item) => item.name !== name)
        : current.length >= max
          ? current
          : [...current, { name, source }],
    );
  };

  const finish = async (items: { name: string; source: Source }[]) => {
    setBusy(true);
    setError(undefined);
    try {
      const names = await Promise.all(
        items.map((item) => (item.source === 'output' ? outputToInput(item.name) : item.name)),
      );
      onPick(names);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const fromComputer = async (files: File[]) => {
    setBusy(true);
    setError(undefined);
    try {
      const uploaded = await Promise.all(
        files.slice(0, max).map((file) => api.upload<{ name: string }>('/v1/inputs', file)),
      );
      onPick(uploaded.map((item) => item.name));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const grid = (items: MediaItem[], source: Source) =>
    items.length === 0 ? (
      <EmptyState
        icon={source === 'output' ? ImageIcon : Upload}
        title={source === 'output' ? 'No generated images yet' : 'No uploaded images'}
        description="Choose a file from this computer instead."
      />
    ) : (
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {items.map((item) => {
          const order = selected.findIndex((other) => other.name === item.name);
          return (
            <button
              key={item.name}
              type="button"
              disabled={busy}
              onClick={() => toggle(item.name, source)}
              title={`${item.name} · ${timeAgo(item.modified)}`}
              className={cn(
                'checkerboard group relative aspect-square overflow-hidden rounded-md border border-border outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                order >= 0 && 'ring-2 ring-primary',
              )}
            >
              <img
                src={item.url}
                alt=""
                loading="lazy"
                className="size-full object-cover transition group-hover:scale-[1.03]"
              />
              {order >= 0 ? (
                <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                  {max > 1 ? order + 1 : <Check className="size-3" />}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as Source)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="px-5 pt-3">
          <TabsList>
            <TabsTrigger value="output">
              <Library className="size-3.5" /> Generated
            </TabsTrigger>
            <TabsTrigger value="upload">
              <Upload className="size-3.5" /> Uploads
            </TabsTrigger>
          </TabsList>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <TabsContent value="output" className="m-0">
            {outputs.loading ? <Spinner /> : grid(outputs.data?.outputs ?? [], 'output')}
          </TabsContent>
          <TabsContent value="upload" className="m-0">
            {uploads.loading ? <Spinner /> : grid(uploadImages, 'upload')}
          </TabsContent>
        </div>
      </Tabs>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple={max > 1}
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (files.length) void fromComputer(files);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          <Upload /> Choose from computer…
        </Button>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="ml-auto flex items-center gap-2">
          {busy ? <Spinner className="size-4" /> : null}
          {max > 1 ? (
            <Button
              size="sm"
              disabled={busy || selected.length === 0}
              onClick={() => void finish(selected)}
            >
              Use {selected.length || ''} selected
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
