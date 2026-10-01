import * as React from 'react';
import { Library, Trash2 } from 'lucide-react';
import { Page } from '@pepper/ui/components/layout';
import { Button, Card, EmptyState, ErrorNote, Select, Spinner, Tabs, TabsContent, TabsList, TabsTrigger } from '@pepper/ui/components/ui';
import { api, useResource, type MediaItem } from '@pepper/ui/lib/api';
import { formatBytes, timeAgo } from '@pepper/ui/lib/utils';

/** Everything generated (outputs) and everything uploaded (inputs). */
export function MediaPage() {
  const [kind, setKind] = React.useState('all');
  const query = kind === 'all' ? '' : `?kind=${kind}`;
  const outputs = useResource<{ outputs: MediaItem[] }>(`/v1/outputs${query}`, 20_000);
  const uploads = useResource<{ uploads: MediaItem[] }>('/v1/inputs', 20_000);

  return (
    <Page
      title="Media"
      actions={
        <Select
          value={kind}
          onValueChange={setKind}
          className="w-32"
          options={[
            { value: 'all', label: 'All' },
            { value: 'video', label: 'Video' },
            { value: 'image', label: 'Images' },
            { value: 'audio', label: 'Audio' },
          ]}
        />
      }
    >
      <Tabs defaultValue="outputs" className="flex flex-col gap-3">
        <TabsList className="self-start">
          <TabsTrigger value="outputs">Generated</TabsTrigger>
          <TabsTrigger value="uploads">Uploads</TabsTrigger>
        </TabsList>
        <TabsContent value="outputs">
          <Grid
            items={outputs.data?.outputs}
            loading={outputs.loading}
            error={outputs.error?.message}
            onDelete={(item) => void api.delete(`/v1/outputs/${encodeURIComponent(item.name)}`).then(outputs.reload)}
          />
        </TabsContent>
        <TabsContent value="uploads">
          <Grid
            items={uploads.data?.uploads.filter((u) => kind === 'all' || u.kind === kind)}
            loading={uploads.loading}
            error={uploads.error?.message}
          />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

function Grid({
  items,
  loading,
  error,
  onDelete,
}: {
  items: MediaItem[] | undefined;
  loading: boolean;
  error?: string;
  onDelete?: (item: MediaItem) => void;
}) {
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (loading && !items) return <Spinner />;
  if (!items?.length) return <EmptyState icon={Library} title="Nothing here yet" />;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {items.map((item) => (
        <Card key={item.name} className="flex flex-col gap-2 overflow-hidden p-2">
          {item.kind === 'video' ? <video src={item.url} controls preload="metadata" className="w-full rounded-md bg-black" /> : null}
          {item.kind === 'image' ? <img src={item.url} alt="" loading="lazy" className="w-full rounded-md" /> : null}
          {item.kind === 'audio' ? <audio src={item.url} controls preload="none" className="w-full" /> : null}
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <a href={item.url} download className="truncate font-mono hover:text-foreground">
              {item.name}
            </a>
            <span className="shrink-0">
              {formatBytes(item.size)} · {timeAgo(item.modified)}
            </span>
            {onDelete ? (
              <Button size="icon-sm" variant="ghost" aria-label="Delete" onClick={() => confirm(`Delete ${item.name}?`) && onDelete(item)}>
                <Trash2 />
              </Button>
            ) : null}
          </div>
        </Card>
      ))}
    </div>
  );
}
