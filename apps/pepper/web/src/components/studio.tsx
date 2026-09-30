import * as React from 'react';
import { X } from 'lucide-react';
import { inputUrl } from '@/lib/images';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';

/**
 * Pieces the generation studios (Image, Video) share: aspect-ratio chips, the
 * thumbnail of a chosen input, a file button, and an elapsed-time ticker for
 * progress overlays.
 */

export function AspectChip({
  value,
  pressed,
  shape,
  onClick,
}: {
  value: string;
  pressed: boolean;
  shape?: [number, number];
  onClick: () => void;
}) {
  const scale = shape ? 14 / Math.max(shape[0], shape[1]) : 0;
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-xs font-medium transition hover:bg-accent',
        pressed && 'border-primary bg-primary text-primary-foreground hover:bg-primary',
      )}
    >
      {shape ? (
        <i
          className="inline-block rounded-[2px] border-[1.5px] border-current opacity-80"
          style={{ width: Math.round(shape[0] * scale), height: Math.round(shape[1] * scale) }}
        />
      ) : null}
      {value === 'match' ? 'Match input' : value === 'custom' ? 'Custom' : value}
    </button>
  );
}

export function InputThumb({
  name,
  label,
  onRemove,
  className,
}: {
  name: string;
  label?: string;
  onRemove: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'checkerboard group relative aspect-square overflow-hidden rounded-md border border-border',
        className,
      )}
    >
      <img src={inputUrl(name)} alt="" className="size-full object-cover" />
      {label ? (
        <span className="absolute left-1 top-1 rounded bg-black/65 px-1.5 text-[10px] font-semibold text-white">
          {label}
        </span>
      ) : null}
      <button
        type="button"
        aria-label="Remove"
        onClick={onRemove}
        className="absolute right-1 top-1 rounded-full bg-black/65 p-0.5 text-white opacity-80 transition hover:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

export function FileButton({
  children,
  multiple,
  accept = 'image/*',
  onFiles,
}: {
  children: React.ReactNode;
  multiple?: boolean;
  accept?: string;
  onFiles: (files: File[]) => void;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
      <Button variant="outline" size="sm" onClick={() => ref.current?.click()}>
        {children}
      </Button>
    </>
  );
}

export function useElapsed(since?: string): number {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since ? Math.max(0, now - Date.parse(since)) : 0;
}

