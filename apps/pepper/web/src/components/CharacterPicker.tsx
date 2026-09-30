import * as React from 'react';
import { Link } from 'react-router-dom';
import { Check, Mic, Plus, UserRound, Users, X } from 'lucide-react';
import { useResource } from '@/lib/api';
import { inputUrl } from '@/lib/images';
import {
  ROLE_LABELS,
  thumbnailUrl,
  voiceSummary,
  type Character,
} from '@/lib/characters';
import { Badge, Button, Dialog, DialogContent, EmptyState, Spinner } from '@/components/ui';
import { cn } from '@/lib/utils';

/**
 * Picking a Character Studio character from a generation screen.
 *
 * `CharacterField` is the form control: the chosen character's thumbnail and
 * name, a way to change or clear it, and — when the screen uses one of the
 * character's images — a strip to choose which. The dialog behind it is a
 * thumbnail grid of the whole cast.
 */

export function useCharacters() {
  return useResource<{ characters: Character[] }>('/v1/characters');
}

export function CharacterAvatar({
  character,
  className,
}: {
  character: Character | undefined;
  className?: string;
}) {
  const url = character ? thumbnailUrl(character) : undefined;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-muted-foreground',
        className,
      )}
    >
      {url ? (
        <img src={url} alt="" className="size-full object-cover object-top" />
      ) : (
        <UserRound className="size-1/2" />
      )}
    </span>
  );
}

export function CharacterPickerDialog({
  open,
  onOpenChange,
  selectedId,
  onPick,
  need,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedId?: string;
  onPick: (character: Character) => void;
  /** Emphasise characters that have what the screen needs. */
  need?: 'image' | 'voice';
}) {
  const cast = useCharacters();
  const characters = cast.data?.characters ?? [];
  const usable = (character: Character) =>
    need === 'voice'
      ? Boolean(character.voice?.model)
      : need === 'image'
        ? character.images.length > 0
        : true;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          title="Choose a character"
          description={
            need === 'voice'
              ? 'Characters with a voice set speak in it; the others can be given one in the Character Studio.'
              : 'The character’s description goes into the prompt, and its images can guide the result.'
          }
          className="[--dialog-w:56rem] h-[75vh]"
        >
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {cast.loading ? (
                <Spinner />
              ) : characters.length === 0 ? (
                <EmptyState
                  icon={Users}
                  title="No characters yet"
                  description="Create one in the Character Studio — a one-line idea is enough to generate a full character sheet."
                />
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {characters.map((character) => {
                    const selected = character.id === selectedId;
                    return (
                      <button
                        key={character.id}
                        type="button"
                        onClick={() => {
                          onPick(character);
                          onOpenChange(false);
                        }}
                        className={cn(
                          'group flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left outline-none transition hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                          selected && 'ring-2 ring-primary',
                          !usable(character) && 'opacity-60',
                        )}
                      >
                        <span className="relative aspect-square overflow-hidden bg-muted">
                          {thumbnailUrl(character) ? (
                            <img
                              src={thumbnailUrl(character)}
                              alt=""
                              loading="lazy"
                              className="size-full object-cover object-top transition duration-200 group-hover:scale-[1.03]"
                            />
                          ) : (
                            <span className="flex size-full items-center justify-center text-muted-foreground">
                              <UserRound className="size-10" />
                            </span>
                          )}
                          {selected ? (
                            <span className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                              <Check className="size-3" />
                            </span>
                          ) : null}
                        </span>
                        <span className="flex flex-col gap-1 p-2.5">
                          <span className="truncate text-sm font-semibold">{character.name}</span>
                          <span className="flex flex-wrap gap-1">
                            <Badge variant="outline">{character.images.length} img</Badge>
                            {character.voice?.model ? (
                              <Badge variant="primary">
                                <Mic className="size-2.5" /> voice
                              </Badge>
                            ) : null}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
              <Button asChild variant="outline" size="sm">
                <Link to="/characters" onClick={() => onOpenChange(false)}>
                  <Plus /> New character…
                </Link>
              </Button>
              <span className="text-[11px] text-muted-foreground">
                Manage the cast in the Character Studio.
              </span>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/**
 * The picker as a form field. `imageName` / `onImageChange` add the strip for
 * choosing which of the character's images the screen uses.
 */
export function CharacterField({
  character,
  onChange,
  imageName,
  onImageChange,
  need,
  hint,
  children,
}: {
  character: Character | undefined;
  onChange: (character: Character | undefined) => void;
  imageName?: string;
  onImageChange?: (name: string) => void;
  need?: 'image' | 'voice';
  hint?: React.ReactNode;
  /** Extra controls shown under a chosen character (toggles for how it is used). */
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">Character</span>
      {character ? (
        <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-muted/30 p-2.5">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              title="Change character"
            >
              <CharacterAvatar character={character} className="size-11" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-semibold">{character.name}</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {need === 'voice'
                    ? voiceSummary(character.voice)
                    : character.appearance || character.brief || 'No description yet'}
                </span>
              </span>
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove character"
              onClick={() => onChange(undefined)}
            >
              <X />
            </Button>
          </div>

          {onImageChange && character.images.length > 1 ? (
            <div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-thin">
              {character.images.map((image) => (
                <button
                  key={image.name}
                  type="button"
                  onClick={() => onImageChange(image.name)}
                  title={`Use this ${ROLE_LABELS[image.role].toLowerCase()}`}
                  className={cn(
                    'relative size-12 shrink-0 overflow-hidden rounded-md border border-border',
                    imageName === image.name && 'ring-2 ring-primary',
                  )}
                >
                  <img src={inputUrl(image.name)} alt="" className="size-full object-cover object-top" />
                  <span className="absolute inset-x-0 bottom-0 bg-black/60 text-center text-[9px] font-medium text-white">
                    {ROLE_LABELS[image.role]}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {children}
        </div>
      ) : (
        <Button variant="outline" size="sm" className="justify-start" onClick={() => setOpen(true)}>
          <Users /> Choose a character…
        </Button>
      )}
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
      <CharacterPickerDialog
        open={open}
        onOpenChange={setOpen}
        selectedId={character?.id}
        need={need}
        onPick={onChange}
      />
    </div>
  );
}

/**
 * Keep a chosen character in sync with the server (a sheet finishing in the
 * studio, a voice edited) and persisted by id across reloads.
 */
export function useChosenCharacter(storageKey: string) {
  const cast = useCharacters();
  const [id, setId] = React.useState<string | undefined>(() => {
    try {
      return localStorage.getItem(storageKey) ?? undefined;
    } catch {
      return undefined;
    }
  });
  React.useEffect(() => {
    try {
      if (id) localStorage.setItem(storageKey, id);
      else localStorage.removeItem(storageKey);
    } catch {
      // Storage disabled: the choice lasts for this visit.
    }
  }, [id, storageKey]);

  // The dialog has its own copy of the list, so a character created since this
  // screen loaded is known from the pick until the reload below lands.
  const [picked, setPicked] = React.useState<Character>();
  const listed = cast.data?.characters.find((candidate) => candidate.id === id);
  const character = listed ?? (picked?.id === id ? picked : undefined);

  // A character deleted in the studio drops out of every screen.
  React.useEffect(() => {
    if (id && cast.data && !cast.loading && !character) setId(undefined);
  }, [id, cast.data, cast.loading, character]);

  const { reload } = cast;
  const setCharacter = React.useCallback(
    (next: Character | undefined) => {
      setPicked(next);
      setId(next?.id);
      reload();
    },
    [reload],
  );

  return { character, setCharacter, reload };
}
