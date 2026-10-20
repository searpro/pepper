import * as React from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { Badge, Button, Field, Input, Select, Slider } from '@pepper/ui/components/ui';
import { useResource } from '@pepper/ui/lib/api';
import type { Lora, LoraList, LoraUse, Recipe } from '@/lib/pro';

/**
 * LoRAs for one generation: the downloaded ones made for the recipe's base
 * model, each at a strength. A LoRA does little without its trigger words in
 * the prompt, so each row says which of them the prompt is missing and adds
 * them on a click.
 */
export function LoraPicker({
  recipe,
  value,
  onChange,
  prompt,
  onPromptChange,
}: {
  recipe: Recipe;
  value: LoraUse[];
  onChange: (value: LoraUse[]) => void;
  prompt: string;
  onPromptChange: (prompt: string) => void;
}) {
  const list = useResource<LoraList>('/v1/loras', 15_000);
  const base = list.data?.bases.find((b) => b.id === recipe.lora_base);
  const fitting = (list.data?.loras ?? []).filter((lora) => lora.base === recipe.lora_base && lora.state === 'installed');
  const chosen = value.flatMap((use) => {
    const lora = fitting.find((l) => l.id === use.id);
    return lora ? [{ use, lora }] : [];
  });
  const left = fitting.filter((lora) => !value.some((use) => use.id === lora.id));

  // LoRAs made for another model cannot follow the recipe that was changed to.
  React.useEffect(() => {
    if (!list.data) return;
    const kept = value.filter((use) => fitting.some((lora) => lora.id === use.id));
    if (kept.length !== value.length) onChange(kept);
    // `fitting` is derived from these two.
  }, [list.data, recipe.lora_base]);

  const set = (id: string, strength: number) => onChange(value.map((use) => (use.id === id ? { ...use, strength } : use)));
  const missing = (words: string[]) => words.filter((word) => !prompt.toLowerCase().includes(word.toLowerCase()));
  const addWords = (words: string[]) => {
    const text = prompt.trim();
    onPromptChange(text ? `${text}, ${words.join(', ')}` : words.join(', '));
  };

  return (
    <Field
      label="LoRAs"
      hint={
        fitting.length === 0 ? (
          <>
            No downloaded LoRA is made for {base?.label ?? 'this model'} yet.{' '}
            <Link to="/loras" className="underline underline-offset-2 hover:text-foreground">
              Add one
            </Link>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-2">
        {chosen.map(({ use, lora }) => {
          const absent = missing(lora.trigger_words);
          return (
            <div key={lora.id} className="flex flex-col gap-2 rounded-md border border-border p-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium" title={lora.name}>
                  {lora.name}
                </span>
                <Button variant="ghost" size="icon-sm" onClick={() => onChange(value.filter((u) => u.id !== lora.id))} aria-label={`Remove ${lora.name}`}>
                  <X />
                </Button>
              </div>
              <StrengthControl label={lora.name} value={use.strength} onChange={(strength) => set(lora.id, strength)} />
              {absent.length ? (
                <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                  <Badge variant="warning">Not in prompt</Badge>
                  {absent.map((word) => (
                    <span key={word} className="font-mono">
                      {word}
                    </span>
                  ))}
                  <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] underline underline-offset-2" onClick={() => addWords(absent)}>
                    Add to prompt
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
        {left.length ? (
          <Select
            // Remounted per pick, so it shows its placeholder again.
            key={value.length}
            value={undefined}
            placeholder={chosen.length ? 'Add another LoRA' : 'Add a LoRA'}
            onValueChange={(id) => {
              const lora = fitting.find((l) => l.id === id);
              if (lora) onChange([...value, { id, strength: lora.strength }]);
            }}
            options={left.map((lora) => ({
              value: lora.id,
              label: lora.name,
              description: lora.trigger_words.length ? lora.trigger_words.join(', ') : undefined,
            }))}
          />
        ) : chosen.length ? (
          <p className="text-[11px] text-muted-foreground">Every LoRA for this model is in use.</p>
        ) : null}
      </div>
    </Field>
  );
}

/** A LoRA's weight: a slider for the usual range, a number for anything else. */
function StrengthControl({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <Slider value={value} onValueChange={(s) => onChange(Math.round(s * 100) / 100)} min={0} max={2} step={0.05} />
      <Input
        type="number"
        step={0.05}
        min={0}
        max={4}
        value={value}
        onChange={(e) => Number.isFinite(Number(e.target.value)) && onChange(Number(e.target.value))}
        className="h-7 w-20 text-xs"
        aria-label={`${label} strength`}
      />
    </div>
  );
}

/** A LoRA an asset or shot names: by id, at its own strength unless one is given. */
export interface LoraRef {
  id: string;
  strength?: number;
}

/**
 * The LoRAs an asset or a shot carries, from the whole library: a cast member
 * may have one per model it is rendered with, and each take uses those its
 * recipe can run. With `recipe` (the shot's own), the ones it cannot are
 * marked. `inherited` lists what the shot's cast brings, which a row here
 * at strength 0 leaves out of the shot.
 */
export function LoraRefs({
  value,
  onChange,
  recipe,
  inherited = [],
}: {
  value: LoraRef[];
  onChange: (value: LoraRef[]) => void;
  recipe?: Pick<Recipe, 'name' | 'lora_base'>;
  inherited?: (LoraRef & { from: string })[];
}) {
  const list = useResource<LoraList>('/v1/loras', 15_000);
  const baseRow = recipe?.lora_base ? list.data?.bases.find((b) => b.id === recipe.lora_base) : undefined;
  const base = recipe && baseRow ? { id: baseRow.id, label: baseRow.label, recipe: recipe.name } : undefined;
  const library = list.data?.loras ?? [];
  const byId = new Map(library.map((lora) => [lora.id, lora]));
  const left = library.filter((lora) => !value.some((ref) => ref.id === lora.id));
  const strengthOf = (ref: LoraRef, lora: Lora) => ref.strength ?? lora.strength;
  const set = (id: string, strength: number) => onChange(value.map((ref) => (ref.id === id ? { ...ref, strength } : ref)));
  const shown = inherited.filter((ref) => byId.has(ref.id) && !value.some((own) => own.id === ref.id));

  return (
    <div className="flex flex-col gap-2">
      {recipe && !recipe.lora_base ? <p className="text-[11px] text-muted-foreground">{recipe.name} takes no LoRAs, so none of these run on it.</p> : null}
      {shown.length ? (
        <p className="text-[11px] text-muted-foreground">
          From the cast:{' '}
          {shown.map((ref, i) => {
            const lora = byId.get(ref.id)!;
            return (
              <React.Fragment key={`${ref.from}-${ref.id}`}>
                {i ? ', ' : ''}
                <span className="text-foreground">{lora.name}</span> ({ref.from}
                {base && lora.base !== base.id ? `, not for ${base.recipe}` : ''})
              </React.Fragment>
            );
          })}
          . Add one here at 0 to leave it out of this shot.
        </p>
      ) : null}
      {value.map((ref) => {
        const lora = byId.get(ref.id);
        if (!lora) {
          return (
            <div key={ref.id} className="flex items-center gap-2 rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">{ref.id} is no longer in the library</span>
              <Button variant="ghost" size="icon-sm" onClick={() => onChange(value.filter((r) => r.id !== ref.id))} aria-label={`Remove ${ref.id}`}>
                <X />
              </Button>
            </div>
          );
        }
        const unused = base && lora.base !== base.id;
        return (
          <div key={ref.id} className="flex flex-col gap-2 rounded-md border border-border p-2.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs font-medium" title={lora.name}>
                {lora.name}
              </span>
              <Badge variant={unused ? 'warning' : 'primary'} title={unused ? `${base.recipe} runs ${base.label}` : undefined}>
                {lora.base_label}
              </Badge>
              <Button variant="ghost" size="icon-sm" onClick={() => onChange(value.filter((r) => r.id !== ref.id))} aria-label={`Remove ${lora.name}`}>
                <X />
              </Button>
            </div>
            <StrengthControl label={lora.name} value={strengthOf(ref, lora)} onChange={(strength) => set(lora.id, strength)} />
            {strengthOf(ref, lora) === 0 ? <p className="text-[11px] text-muted-foreground">Off for this one.</p> : null}
          </div>
        );
      })}
      {left.length ? (
        <Select
          // Remounted per pick, so it shows its placeholder again.
          key={value.length}
          value={undefined}
          placeholder={value.length ? 'Add another LoRA' : 'Add a LoRA'}
          onValueChange={(id) => onChange([...value, { id }])}
          options={left.map((lora) => ({
            value: lora.id,
            label: lora.name,
            description: [lora.base_label, ...lora.trigger_words].join(' · '),
          }))}
        />
      ) : list.data && library.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          The library is empty.{' '}
          <Link to="/loras" className="underline underline-offset-2 hover:text-foreground">
            Add a LoRA
          </Link>
        </p>
      ) : null}
    </div>
  );
}
