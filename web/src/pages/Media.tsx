import * as React from 'react';
import { Download, Image as ImageIcon, Library, Trash2, Upload } from 'lucide-react';
import { api, useResource, type MediaItem } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogTrigger,
  EmptyState,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { Page } from '@/components/layout';
import { formatBytes, timeAgo } from '@/lib/utils';

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

  const items = (outputs.data?.outputs ?? []).filter(
    (item) => filter === 'all' || item.kind === filter,
  );

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
                  onDelete={async () => {
                    await api.delete(`/v1/outputs/${encodeURIComponent(item.name)}`);
                    outputs.reload();
                  }}
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
    </Page>
  );
}

function MediaCard({ item, onDelete }: { item: MediaItem; onDelete: () => Promise<void> }) {
  return (
    <Card className="group relative overflow-hidden">
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
        </DialogContent>
      </Dialog>

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
      <img src={item.url} alt={item.name} loading="lazy" className="aspect-square w-full object-cover" />
    );
  }
  if (item.kind === 'video') {
    return <video src={item.url} className="aspect-square w-full object-cover" preload="metadata" muted />;
  }
  return (
    <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 bg-muted p-2">
      <Library className="size-6 text-muted-foreground/60" />
      <span className="line-clamp-2 text-center text-[10px] text-muted-foreground">{item.name}</span>
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
