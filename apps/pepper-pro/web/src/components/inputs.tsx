import * as React from 'react';
import { FileAudio, FileVideo, ImagePlus, Upload, X } from 'lucide-react';
import { Button, ErrorNote, Field, Input, Select, Spinner, Switch, Textarea } from '@pepper/ui/components/ui';
import { cn } from '@pepper/ui/lib/utils';
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
 * Pick uploads for a media input: files go to /v1/inputs and the field holds
 * their stored names, which is what recipes and shots take.
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
  const full = !multiple ? value.length >= 1 : max !== undefined && value.length >= max;

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
        {!full ? (
          <Button variant="outline" size="sm" onClick={() => ref.current?.click()} disabled={busy}>
            {busy ? <Spinner /> : value.length ? <Upload /> : <Icon />}
            {value.length && !multiple ? 'Replace' : `Add ${kind}`}
          </Button>
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
    </div>
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
