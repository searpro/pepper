import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Image as ImageIcon, Library, Maximize2, Trash2, Upload } from 'lucide-react';
import { api, useResource, type MediaItem } from '@pepper/ui/lib/api';
import { outputToInput, setHandoff } from '@/lib/images';
import { ImageDetailsDialog } from '@/components/ImageDetails';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogTrigger,
  EmptyState,
  ErrorNote,
  Field,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@pepper/ui/components/ui';
import { Page } from '@pepper/ui/components/layout';
import { formatBytes, timeAgo } from '@pepper/ui/lib/utils';

/**
 * The Media library (requirement 10): every generation in one place, with a
 * dedicated tab for uploads.
 *
 * Both lists come from scanning their directories rather than from the job
 * table, so a file survives its job being pruned and a file copied onto the
 * volume by hand shows up without anything having to import it.
 */
export function MediaPage() {
  const outputs = useResource<{ outputs: MediaItem[] }>('/v1/outputs?limit=500');
  const uploads = useResource<{ uploads: MediaItem[] }>('/v1/inputs');
  const [filter, setFilter] = React.useState<'all' | 'image' | 'video' | 'audio'>('all');
  const [detail, setDetail] = React.useState<MediaItem | null>(null);
  const navigate = useNavigate();

  const items = (outputs.data?.outputs ?? []).filter(
    (item) => filter === 'all' || item.kind === filter,
  );

  const images = items.filter((item) => item.kind === 'image');

  const deleteOutput = async (name: string) => {
    await api.delete(`/v1/outputs/${encodeURIComponent(name)}`);
    outputs.reload();
  };

  const uploadFile = async (file: File) => {
    await api.upload('/v1/inputs', file);
    uploads.reload();
  };

  return (
    <Page
      title="Media"
      description="Everything generated on this server, plus the files uploaded to it."
    >
      <Tabs defaultValue="generations">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="generations">
              <Library className="size-3.5" /> Generations
              <Badge variant="outline">{outputs.data?.outputs.length ?? 0}</Badge>
            </TabsTrigger>
            <TabsTrigger value="uploads">
              <Upload className="size-3.5" /> Uploads
              <Badge variant="outline">{uploads.data?.uploads.length ?? 0}</Badge>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="generations" className="m-0">
            <div className="flex gap-1">
              {(['all', 'image', 'video', 'audio'] as const).map((kind) => (
                <Button
                  key={kind}
                  variant={filter === kind ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setFilter(kind)}
                  className="capitalize"
                >
                  {kind}
                </Button>
              ))}
            </div>
          </TabsContent>
        </div>

        <TabsContent value="generations" className="mt-4">
          {items.length === 0 ? (
            <EmptyState
              icon={ImageIcon}
              title="Nothing generated yet"
              description="Images, videos and audio produced on this server collect here."
            />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
              {items.map((item) => (
                <MediaCard
                  key={item.name}
                  item={item}
                  onOpen={item.kind === 'image' ? () => setDetail(item) : undefined}
                  onDelete={() => deleteOutput(item.name)}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="uploads" className="mt-4 flex flex-col gap-4">
          <label className="self-start">
            <input
              type="file"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadFile(file);
              }}
            />
            <span className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-dashed border-input px-4 text-xs text-muted-foreground hover:bg-accent">
              <Upload className="size-3.5" /> Upload a file
            </span>
          </label>

          {(uploads.data?.uploads.length ?? 0) === 0 ? (
            <EmptyState
              icon={Upload}
              title="No uploads"
              description="Init images, masks, reference images and voice clips appear here."
            />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
              {uploads.data?.uploads.map((item) => (
                <MediaCard
                  key={item.name}
                  item={item}
                  onDelete={async () => {
                    await api.delete(`/v1/inputs/${encodeURIComponent(item.name)}`);
                    uploads.reload();
                  }}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Images get the full popup: details, reuse, upscale. The actions that
          feed the generator hand the image over to the Image screen. */}
      <ImageDetailsDialog
        item={detail}
        items={images}
        onItemChange={setDetail}
        onOpenChange={(open) => !open && setDetail(null)}
        onReuse={(settings) => {
          setHandoff({ settings });
          navigate('/image');
        }}
        onUseAsInit={async (name) => {
          setHandoff({ init: await outputToInput(name) });
          navigate('/image');
        }}
        onUseAsReference={async (name) => {
          setHandoff({ refs: [await outputToInput(name)] });
          navigate('/image');
        }}
        onDelete={deleteOutput}
      />
    </Page>
  );
}

function MediaCard({
  item,
  onOpen,
  onDelete,
}: {
  item: MediaItem;
  /** Open a richer viewer than the plain preview dialog. */
  onOpen?: () => void;
  onDelete: () => Promise<void>;
}) {
  return (
    <Card className="group relative overflow-hidden">
      {onOpen ? (
        <button
          className="checkerboard relative block w-full text-left"
          aria-label={`Open ${item.name}`}
          onClick={onOpen}
        >
          <MediaThumb item={item} />
          {upscaledLabel(item.name) ? (
            <span className="absolute bottom-1 left-1 inline-flex items-center gap-0.5 rounded bg-black/60 px-1 text-[10px] font-semibold text-white">
              <Maximize2 className="size-2.5" />
              {upscaledLabel(item.name)}
            </span>
          ) : null}
        </button>
      ) : (
        <Dialog>
          <DialogTrigger asChild>
            <button className="block w-full text-left" aria-label={`Open ${item.name}`}>
              <MediaThumb item={item} />
            </button>
          </DialogTrigger>
          <DialogContent
            title={item.name}
            description={`${item.kind} · ${formatBytes(item.size)} · ${timeAgo(item.modified)}`}
            className="[--dialog-w:64rem]"
          >
            <div className="flex items-center justify-center bg-black/5 p-4 dark:bg-black/30">
              <MediaPlayer item={item} />
            </div>
            {item.kind === 'video' ? <VideoUpscale name={item.name} /> : null}
          </DialogContent>
        </Dialog>
      )}

      <div className="flex items-center justify-between gap-1 px-2 py-1.5">
        <span className="truncate text-[10px] text-muted-foreground">{timeAgo(item.modified)}</span>
        <div className="flex shrink-0 items-center">
          <a
            href={item.url}
            download
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Download"
          >
            <Download className="size-3" />
          </a>
          <button
            onClick={() => void onDelete()}
            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label="Delete"
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      </div>
    </Card>
  );
}

function MediaThumb({ item }: { item: MediaItem }) {
  if (item.kind === 'image') {
    return (
      <img
        src={item.url}
        alt={item.name}
        loading="lazy"
        className="aspect-square w-full object-cover"
      />
    );
  }
  if (item.kind === 'video') {
    return (
      <video
        src={item.url}
        className="aspect-square w-full object-cover"
        preload="metadata"
        muted
      />
    );
  }
  return (
    <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 bg-muted p-2">
      <Library className="size-6 text-muted-foreground/60" />
      <span className="line-clamp-2 text-center text-[10px] text-muted-foreground">
        {item.name}
      </span>
    </div>
  );
}

/** "2x", "4x" or "1080p" for an upscaled output's badge. */
function upscaledLabel(name: string): string | undefined {
  return /^upscaled-(\d+x|\d+p)/.exec(name)?.[1];
}

/**
 * SeedVR2 finishing pass for a generated clip: diffusion super-resolution that
 * adds detail consistently across frames, keeping the soundtrack. Queued like
 * any job; the result lands here in Media.
 */
function VideoUpscale({ name }: { name: string }) {
  const [resolution, setResolution] = React.useState('1080');
  const [quality, setQuality] = React.useState('best');
  const [state, setState] = React.useState<{ busy?: boolean; message?: string; error?: string }>({});

  const start = async () => {
    setState({ busy: true });
    try {
      await api.post('/v1/jobs/upscale', { image: name, resolution: Number(resolution), quality });
      setState({ message: 'Queued. It takes a few minutes; the result appears here and in Jobs.' });
    } catch (err) {
      setState({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-3 border-t border-border p-3">
      <Field label="Upscale to" className="w-32">
        <Select
          value={resolution}
          onValueChange={setResolution}
          options={['720', '1080', '1440', '2160'].map((value) => ({ value, label: `${value}p` }))}
        />
      </Field>
      <Field label="Quality" className="w-44">
        <Select
          value={quality}
          onValueChange={setQuality}
          options={[
            { value: 'best', label: 'Best (SeedVR2 7B)' },
            { value: 'sharp', label: 'Sharp (7B sharp)' },
            { value: 'fast', label: 'Fast (SeedVR2 3B)' },
          ]}
        />
      </Field>
      <Button size="sm" onClick={() => void start()} disabled={state.busy}>
        <Maximize2 /> Upscale video
      </Button>
      {state.message ? <span className="text-xs text-muted-foreground">{state.message}</span> : null}
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
    </div>
  );
}

function MediaPlayer({ item }: { item: MediaItem }) {
  if (item.kind === 'image') {
    return <img src={item.url} alt={item.name} className="max-h-[70vh] w-auto rounded-md" />;
  }
  if (item.kind === 'video') {
    return <video src={item.url} controls autoPlay className="max-h-[70vh] w-auto rounded-md" />;
  }
  if (item.kind === 'audio') {
    return <audio src={item.url} controls autoPlay className="w-full max-w-lg" />;
  }
  return (
    <a href={item.url} download className="text-sm text-primary hover:underline">
      Download {item.name}
    </a>
  );
}
