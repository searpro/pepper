import * as React from 'react';
import { Check, FileAudio, FileVideo, ImagePlus, Library, Music, Upload, X } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Select,
  Spinner,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@pepper/ui/components/ui';
import { api, useResource, type MediaItem } from '@pepper/ui/lib/api';
import { cn, timeAgo } from '@pepper/ui/lib/utils';
import { inputUrl, upload, type RecipeParam } from '@/lib/pro';

type MediaKind = 'image' | 'audio' | 'video';

const ACCEPT: Record<MediaKind, string> = { image: 'image/*', audio: 'audio/*', video: 'video/*' };

/** A preview of one upload, by kind. */
export function MediaThumb({ name, kind, className }: { name: string; kind: MediaKind; className?: string }) {
  if (kind === 'image') return <img src={inputUrl(name)} alt="" className={cn('size-16 rounded-md object-cover', className)} />;
  if (kind === 'audio') return <audio src={inputUrl(name)} controls preload="none" className={cn('h-8 w-56', className)} />;
  return <video src={inputUrl(name)} muted preload="metadata" className={cn('size-16 rounded-md object-cover', className)} />;
}

/**
 * Pick inputs for a media field: a file from this computer (uploaded to
 * /v1/inputs), or one already on the server, generated or uploaded before,
 * from the library. The field holds stored upload names, which is what
 * recipes and shots take.
 */
export function MediaField({
  kind,
  value,
  onChange,
  multiple,
  max,
}: {
  kind: MediaKind;
  value: string[];
  onChange: (names: string[]) => void;
  multiple?: boolean;
  max?: number;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [library, setLibrary] = React.useState(false);
  const full = !multiple ? value.length >= 1 : max !== undefined && value.length >= max;
  const room = multiple ? (max ?? Infinity) - value.length : 1;

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(undefined);
    try {
      const names: string[] = [];
      for (const file of [...files].slice(0, multiple ? (max ?? files.length) - value.length : 1)) names.push(await upload(file));
      onChange(multiple ? [...value, ...names] : names);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = '';
    }
  };

  const Icon = kind === 'image' ? ImagePlus : kind === 'audio' ? FileAudio : FileVideo;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {value.map((name, index) => (
          <div key={`${name}-${index}`} className="relative flex items-center gap-1 rounded-md border border-border p-1">
            <MediaThumb name={name} kind={kind} />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              <X />
            </Button>
          </div>
        ))}
        {!full || !multiple ? (
          <>
            <Button variant="outline" size="sm" onClick={() => ref.current?.click()} disabled={busy}>
              {busy ? <Spinner /> : value.length ? <Upload /> : <Icon />}
              {value.length && !multiple ? 'Replace' : `Upload ${kind}`}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setLibrary(true)} disabled={busy}>
              <Library /> From library
            </Button>
          </>
        ) : null}
        <input
          ref={ref}
          type="file"
          accept={ACCEPT[kind]}
          multiple={multiple}
          className="hidden"
          onChange={(event) => void onFiles(event.target.files)}
        />
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <LibraryPicker
        open={library}
        kind={kind}
        limit={room}
        onOpenChange={setLibrary}
        onPick={(names) => onChange(multiple ? [...value, ...names] : names.slice(0, 1))}
      />
    </div>
  );
}

/**
 * Files already on the server, to use as an input without downloading and
 * uploading them again. An upload is reused as it is; a generated file is
 * linked into uploads (POST /v1/inputs/from-output), once however often it
 * is picked.
 */
function LibraryPicker({
  open,
  kind,
  limit,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  kind: MediaKind;
  limit: number;
  onOpenChange: (open: boolean) => void;
  onPick: (names: string[]) => void;
}) {
  const [tab, setTab] = React.useState<'outputs' | 'uploads'>('outputs');
  const [search, setSearch] = React.useState('');
  const [chosen, setChosen] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const outputs = useResource<{ outputs: MediaItem[] }>(open ? `/v1/outputs?kind=${kind}&limit=1000` : null);
  const uploads = useResource<{ uploads: MediaItem[] }>(open ? '/v1/inputs' : null);

  React.useEffect(() => {
    if (open) {
      setChosen([]);
      setError(undefined);
    }
  }, [open]);

  const resource = tab === 'outputs' ? outputs : uploads;
  const needle = search.trim().toLowerCase();
  const items = ((tab === 'outputs' ? outputs.data?.outputs : uploads.data?.uploads) ?? []).filter(
    (item) => item.kind === kind && (!needle || item.name.toLowerCase().includes(needle)),
  );
  const key = (item: MediaItem) => `${tab}:${item.name}`;
  const toggle = (item: MediaItem) =>
    setChosen((current) =>
      current.includes(key(item)) ? current.filter((k) => k !== key(item)) : limit === 1 ? [key(item)] : current.length < limit ? [...current, key(item)] : current,
    );

  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const names: string[] = [];
      for (const k of chosen) {
        const [from, name] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
        names.push(from === 'uploads' ? name : (await api.post<{ name: string }>('/v1/inputs/from-output', { name })).name);
      }
      onPick(names);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          title={`Choose ${limit === 1 ? `an ${kind === 'image' ? 'image' : kind === 'audio' ? 'audio clip' : 'video'}` : `${kind === 'image' ? 'images' : kind === 'audio' ? 'audio clips' : 'videos'}`} from the library`}
          description="Something already generated or uploaded, used without downloading or uploading it again."
          className="[--dialog-w:64rem]"
        >
          <div className="flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
                <TabsList>
                  <TabsTrigger value="outputs">Generated</TabsTrigger>
                  <TabsTrigger value="uploads">Uploaded</TabsTrigger>
                </TabsList>
              </Tabs>
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name" className="min-w-40 flex-1" aria-label="Search the library" />
            </div>
            {resource.error ? <ErrorNote>{resource.error.message}</ErrorNote> : null}
            {resource.loading && !resource.data ? <Spinner /> : null}
            {resource.data && !items.length ? (
              <EmptyState icon={Library} title={`No ${kind} here`} description={tab === 'outputs' ? 'Generated files are kept for a day.' : undefined} />
            ) : null}
            <div className="grid max-h-[56vh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4">
              {items.map((item) => {
                const picked = chosen.includes(key(item));
                return (
                  <button
                    key={item.name}
                    type="button"
                    onClick={() => toggle(item)}
                    aria-pressed={picked}
                    aria-label={`Choose ${item.name}`}
                    className={cn('relative flex flex-col gap-1 overflow-hidden rounded-md border border-border p-1 text-left', picked && 'ring-2 ring-primary')}
                  >
                    {kind === 'image' ? <img src={item.url} alt="" loading="lazy" className="aspect-video w-full rounded object-cover" /> : null}
                    {kind === 'video' ? <video src={`${item.url}#t=0.1`} muted preload="metadata" className="aspect-video w-full rounded bg-black object-cover" /> : null}
                    {kind === 'audio' ? (
                      <div className="flex aspect-video w-full items-center justify-center rounded bg-muted text-muted-foreground">
                        <Music className="size-6" />
                      </div>
                    ) : null}
                    <span className="truncate font-mono text-[10px] text-muted-foreground" title={item.name}>
                      {item.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{timeAgo(item.modified)}</span>
                    {picked ? <Check className="absolute right-2 top-2 size-5 rounded-full bg-primary p-0.5 text-primary-foreground" /> : null}
                  </button>
                );
              })}
            </div>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <div className="flex items-center justify-end gap-2">
              {limit > 1 && limit !== Infinity ? <span className="mr-auto text-xs text-muted-foreground">Up to {limit}</span> : null}
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={!chosen.length || busy} onClick={() => void confirm()}>
                {busy ? <Spinner /> : <Check />} Use {chosen.length > 1 ? `${chosen.length} files` : 'this'}
              </Button>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function mediaKindOf(type: RecipeParam['type']): MediaKind | undefined {
  if (type === 'image' || type === 'images') return 'image';
  if (type === 'audio' || type === 'audios') return 'audio';
  if (type === 'video') return 'video';
  return undefined;
}

/**
 * A form for a recipe's parameters, generated from their declarations.
 * `values` holds only what the user set; defaults are shown as placeholders
 * and applied by the server, so a mode's own defaults still win.
 */
export function ParamForm({
  params,
  values,
  onChange,
  hide = [],
}: {
  params: RecipeParam[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  hide?: string[];
}) {
  const set = (name: string, value: unknown) => {
    const next = { ...values };
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) delete next[name];
    else next[name] = value;
    onChange(next);
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {params
        .filter((param) => !hide.includes(param.name))
        .map((param) => {
          const label = `${param.label}${param.required ? ' *' : ''}`;
          const media = mediaKindOf(param.type);
          const wide = param.type === 'text' || media !== undefined;
          const current = values[param.name];
          let control: React.ReactNode;
          if (media) {
            const list = current === undefined ? [] : Array.isArray(current) ? (current as string[]) : [current as string];
            const multiple = param.type === 'images' || param.type === 'audios';
            control = (
              <MediaField
                kind={media}
                value={list}
                multiple={multiple}
                max={param.max_items}
                onChange={(names) => set(param.name, multiple ? names : names[0])}
              />
            );
          } else if (param.type === 'text') {
            control = (
              <Textarea
                rows={4}
                value={(current as string) ?? ''}
                placeholder={typeof param.default === 'string' ? param.default : undefined}
                onChange={(event) => set(param.name, event.target.value)}
              />
            );
          } else if (param.type === 'enum') {
            control = (
              <Select
                value={current !== undefined ? String(current) : param.default !== undefined ? String(param.default) : undefined}
                onValueChange={(value) => {
                  const option = param.options?.find((o) => String(o) === value);
                  set(param.name, option);
                }}
                options={(param.options ?? []).map((o) => ({ value: String(o), label: String(o) }))}
              />
            );
          } else if (param.type === 'boolean') {
            control = (
              <Switch checked={Boolean(current ?? param.default)} onCheckedChange={(checked) => set(param.name, checked)} />
            );
          } else if (param.type === 'int' || param.type === 'float' || param.type === 'seed') {
            control = (
              <Input
                type="number"
                step={param.type === 'float' ? 'any' : 1}
                min={param.min}
                max={param.max}
                value={current === undefined ? '' : String(current)}
                placeholder={param.type === 'seed' ? 'random' : param.default !== undefined ? String(param.default) : undefined}
                onChange={(event) => set(param.name, event.target.value === '' ? undefined : Number(event.target.value))}
              />
            );
          } else {
            control = (
              <Input value={(current as string) ?? ''} onChange={(event) => set(param.name, event.target.value)} />
            );
          }
          return (
            <Field key={param.name} label={label} hint={param.description} className={wide ? 'sm:col-span-2' : undefined}>
              {control}
            </Field>
          );
        })}
    </div>
  );
}
