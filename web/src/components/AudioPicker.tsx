import * as React from 'react';
import { AudioLines, Library, Upload } from 'lucide-react';
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
import { timeAgo } from '@/lib/utils';

/**
 * Choose a speech clip from generated audio or earlier uploads — the audio
 * counterpart of `ImagePickerDialog`. Returns an upload name, which is what a
 * speech-to-video request's `audio` takes; generated clips are copied into
 * uploads on the way out.
 */
export function AudioPickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (name: string, label: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          title="Choose speech"
          description="Generated speech, earlier uploads, or a file from this computer."
          className="[--dialog-w:44rem] h-[70vh]"
        >
          <AudioPickerBody
            onPick={(name, label) => {
              onPick(name, label);
              onOpenChange(false);
            }}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function AudioPickerBody({ onPick }: { onPick: (name: string, label: string) => void }) {
  const outputs = useResource<{ outputs: MediaItem[] }>('/v1/outputs?kind=audio&limit=100');
  const uploads = useResource<{ uploads: MediaItem[] }>('/v1/inputs');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const fileInput = React.useRef<HTMLInputElement>(null);

  const pick = async (item: MediaItem, source: 'output' | 'upload') => {
    setBusy(true);
    setError(undefined);
    try {
      const name = source === 'output' ? await outputToInput(item.name) : item.name;
      onPick(name, item.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const fromComputer = async (file: File) => {
    setBusy(true);
    setError(undefined);
    try {
      const uploaded = await api.upload<{ name: string }>('/v1/inputs', file);
      onPick(uploaded.name, file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const list = (items: MediaItem[], source: 'output' | 'upload') =>
    items.length === 0 ? (
      <EmptyState
        icon={AudioLines}
        title={source === 'output' ? 'No generated speech yet' : 'No uploaded audio'}
        description="Choose a file from this computer instead."
      />
    ) : (
      <div className="flex flex-col divide-y divide-border">
        {items.map((item) => (
          <div key={item.name} className="flex items-center gap-3 py-2">
            <audio src={item.url} controls preload="none" className="h-8 flex-1" />
            <span className="w-32 truncate text-[11px] text-muted-foreground" title={item.name}>
              {timeAgo(item.modified)}
            </span>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void pick(item, source)}>
              Use
            </Button>
          </div>
        ))}
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs defaultValue="output" className="flex min-h-0 flex-1 flex-col">
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
            {outputs.loading ? <Spinner /> : list(outputs.data?.outputs ?? [], 'output')}
          </TabsContent>
          <TabsContent value="upload" className="m-0">
            {uploads.loading ? (
              <Spinner />
            ) : (
              list((uploads.data?.uploads ?? []).filter((item) => item.kind === 'audio'), 'upload')
            )}
          </TabsContent>
        </div>
      </Tabs>
      <div className="flex items-center gap-2 border-t border-border px-5 py-3">
        <input
          ref={fileInput}
          type="file"
          accept="audio/*,.wav,.mp3,.flac,.ogg"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void fromComputer(file);
          }}
        />
        <Button variant="outline" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
          <Upload /> Choose from computer…
        </Button>
        {busy ? <Spinner className="size-4" /> : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
    </div>
  );
}
