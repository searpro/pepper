import * as React from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, Music, Sparkles, Wand2, X } from 'lucide-react';
import { Page } from '@pepper/ui/components/layout';
import { GenerationTime, MediaTile, MediaViewer, StatusBadge, generationOf, jobMedia } from '@pepper/ui/components/media';
import { Button, Card, EmptyState, ErrorNote, Field, Input, Progress, Select, Spinner } from '@pepper/ui/components/ui';
import { api, ApiRequestError, useResource, type Job } from '@pepper/ui/lib/api';
import { ParamForm } from '@/components/inputs';
import { LicenceNotice } from '@/components/licence';
import { LoraPicker } from '@/components/loras';
import { isActive, type LoraUse, type Recipe, type RecipeList } from '@/lib/pro';

/**
 * One recipe, outside a project: looks, character sheets, keyframes, a song.
 * The form is generated from the recipe's parameters; results appear as the
 * jobs finish.
 */
export function GeneratePage() {
  const list = useResource<RecipeList>('/v1/recipes', 15_000);
  const installed = (list.data?.recipes ?? []).filter((r) => r.state === 'installed' && !r.licence_block);
  const [recipeId, setRecipeId] = React.useState<string>();
  const recipe = installed.find((r) => r.id === recipeId) ?? installed[0];
  const [mode, setMode] = React.useState<string>();
  const [values, setValues] = React.useState<Record<string, unknown>>({});
  const [loras, setLoras] = React.useState<LoraUse[]>([]);
  const [batch, setBatch] = React.useState(1);
  const [jobIds, setJobIds] = React.useState<string[]>(loadRecent);
  const results = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => saveRecent(jobIds), [jobIds]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();

  // A different recipe has different parameters; carry over only the prompt.
  const choose = (id: string) => {
    setRecipeId(id);
    setMode(undefined);
    setValues((v) => (v.prompt ? { prompt: v.prompt } : {}));
  };

  const modeId = recipe ? (mode ?? recipe.default_mode) : undefined;
  const modeSpec = recipe?.modes.find((m) => m.id === modeId);
  const takesLoras = Boolean(modeSpec?.loras);
  // The form asks only for what this mode reads (a cover's song only in cover
  // mode), and marks what it needs although the recipe does not.
  const reads = (name: string) => !modeSpec?.params || modeSpec.params.includes(name);
  const formParams = (recipe?.params ?? []).map((p) => (modeSpec?.required?.includes(p.name) ? { ...p, required: true } : p));

  /** Sing a score a take returned: switch to the recipe's score mode with it filled in. */
  const useScore = (job: Job, score: string) => {
    const id = String(job.params.recipe ?? '');
    if (!installed.some((r) => r.id === id)) return;
    const params = (job.params.params ?? {}) as Record<string, unknown>;
    setRecipeId(id);
    setMode('score');
    setValues({
      ...Object.fromEntries(['prompt', 'lyrics', 'plan'].filter((k) => params[k] !== undefined).map((k) => [k, params[k]])),
      score,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const submit = async () => {
    if (!recipe) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.post<Job | { jobs: Job[] }>('/v1/jobs', {
        recipe: recipe.id,
        mode: mode ?? recipe.default_mode,
        params: Object.fromEntries(Object.entries(values).filter(([name]) => reads(name))),
        loras: takesLoras && loras.length ? loras : undefined,
        batch,
      });
      const created = 'jobs' in result ? result.jobs : [result];
      setJobIds((ids) => [...created.map((j) => j.id), ...ids].slice(0, 24));
      // On a phone the results are below the form: show the run starting,
      // once its card has rendered from the first poll.
      if (window.matchMedia('(max-width: 1023px)').matches) {
        setTimeout(() => results.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 500);
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (list.data && installed.length === 0) {
    return (
      <Page title="Generate">
        <EmptyState
          icon={Wand2}
          title="No recipe installed"
          description="Install a recipe to generate with it; its model files download for this server's tier."
          action={
            <Button asChild size="sm">
              <Link to="/recipes">Open recipes</Link>
            </Button>
          }
        />
      </Page>
    );
  }

  return (
    <Page title="Generate" description="Run one recipe outside a project.">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <Card className="flex flex-col gap-4 p-4">
          {list.loading && !list.data ? <Spinner /> : null}
          {recipe ? (
            <>
              <Field label="Recipe" hint={recipe.description}>
                <Select
                  value={recipe.id}
                  onValueChange={choose}
                  options={installed.map((r) => ({ value: r.id, label: r.name, description: r.kind }))}
                />
              </Field>
              <Field label="Mode">
                <Select
                  value={mode ?? recipe.default_mode}
                  onValueChange={setMode}
                  options={recipe.modes.map((m) => ({ value: m.id, label: m.label, description: m.description }))}
                />
              </Field>
              <ParamForm
                params={formParams}
                values={values}
                onChange={setValues}
                hide={recipe.params.map((p) => p.name).filter((name) => !reads(name))}
              />
              {takesLoras ? (
                <LoraPicker
                  recipe={recipe}
                  value={loras}
                  onChange={setLoras}
                  prompt={typeof values.prompt === 'string' ? values.prompt : ''}
                  onPromptChange={(prompt) => setValues((v) => ({ ...v, prompt }))}
                />
              ) : null}
              <Field label="Batch" hint="Each gets its own seed.">
                <Input type="number" min={1} max={8} value={batch} onChange={(e) => setBatch(Math.max(1, Math.min(8, Number(e.target.value) || 1)))} />
              </Field>
              {error ? <ErrorNote>{error}</ErrorNote> : null}
              <Button onClick={() => void submit()} disabled={busy}>
                {busy ? <Spinner /> : <Sparkles />} Generate
              </Button>
              <LicenceNotice licence={recipe.licence} />
            </>
          ) : null}
        </Card>
        <div ref={results} className="scroll-mt-4">
          <Results
            ids={jobIds}
            recipes={installed}
            onClear={() => setJobIds([])}
            onGone={(gone) => setJobIds((ids) => ids.filter((id) => !gone.includes(id)))}
            onUseScore={useScore}
          />
        </div>
      </div>
    </Page>
  );
}

/** Where this page keeps its recent runs, so leaving and coming back keeps them on screen. */
const RECENT_KEY = 'pepper-pro.generate.jobs';

function loadRecent(): string[] {
  try {
    const ids = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecent(ids: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids));
  } catch {
    // A private window or blocked storage: the runs just are not remembered.
  }
}

/**
 * The jobs behind `ids`, each polled until it settles. A job the server no
 * longer has (deleted in Jobs) is dropped rather than asked for forever.
 */
function useJobs(ids: string[]): Map<string, Job | 'gone'> {
  const [jobs, setJobs] = React.useState<Map<string, Job | 'gone'>>(new Map());
  const latest = React.useRef(jobs);
  latest.current = jobs;
  const key = ids.join(',');

  React.useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const pending = ids.filter((id) => {
        const job = latest.current.get(id);
        return !job || (job !== 'gone' && isActive(job.status));
      });
      if (pending.length) {
        const fetched = await Promise.all(
          pending.map((id) =>
            api.get<Job>(`/v1/jobs/${id}`).then(
              (job) => [id, job] as const,
              (err) => [id, err instanceof ApiRequestError && err.status === 404 ? ('gone' as const) : undefined] as const,
            ),
          ),
        );
        if (!live) return;
        setJobs((current) => {
          const next = new Map(current);
          for (const [id, job] of fetched) if (job) next.set(id, job);
          return next;
        });
      }
      timer = setTimeout(() => void tick(), 1500);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `ids` is read through `key`, its contents.
  }, [key]);

  return jobs;
}

/**
 * This page's runs, newest first: a running job counts up its time, a
 * finished one is a tile per file that opens the viewer, with every result
 * of the page a key press apart there.
 */
function Results({
  ids,
  recipes,
  onClear,
  onGone,
  onUseScore,
}: {
  ids: string[];
  recipes: Recipe[];
  onClear: () => void;
  /** Jobs deleted since (or from a server's earlier database), to forget. */
  onGone: (ids: string[]) => void;
  /** Sing a score a finished job returned (YuE2's ABC). */
  onUseScore: (job: Job, score: string) => void;
}) {
  const jobs = useJobs(ids);
  const gone = ids.filter((id) => jobs.get(id) === 'gone');
  React.useEffect(() => {
    if (gone.length) onGone(gone);
  }, [gone.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const [open, setOpen] = React.useState<string>();
  const shown = ids.map((id) => jobs.get(id)).filter((job): job is Job => Boolean(job) && job !== 'gone');
  const media = shown.flatMap((job) => (job.status === 'completed' ? jobMedia(job) : []));
  const index = open ? media.findIndex((item) => item.url === open) : -1;
  const recipeName = (job: Job) => recipes.find((r) => r.id === job.params.recipe)?.name ?? String(job.params.recipe ?? job.kind);

  if (ids.length === gone.length) {
    return <p className="text-xs text-muted-foreground">Results appear here, with how long each took, and stay in Jobs and Media.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {shown.length} recent {shown.length === 1 ? 'run' : 'runs'}
        </span>
        <Button size="sm" variant="ghost" onClick={onClear}>
          <X /> Clear
        </Button>
      </div>
      <div className="grid content-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.flatMap((job) => {
          const files = job.status === 'completed' ? jobMedia(job) : [];
          if (files.length) {
            const tiles = files.map((item) => <MediaTile key={item.url} item={item} onOpen={() => setOpen(item.url)} />);
            const text = (job.result as { text?: unknown } | undefined)?.text;
            const scored = recipes.find((r) => r.id === job.params.recipe)?.modes.some((m) => m.id === 'score');
            if (typeof text === 'string' && text) {
              tiles.push(<ScoreCard key={`${job.id}-text`} text={text} onUse={scored ? () => onUseScore(job, text) : undefined} />);
            }
            return tiles;
          }
          return [<RunCard key={job.id} job={job} name={recipeName(job)} />];
        })}
      </div>
      <MediaViewer
        item={index >= 0 ? media[index] : undefined}
        position={index >= 0 ? `${index + 1} of ${media.length}` : undefined}
        onPrev={index > 0 ? () => setOpen(media[index - 1].url) : undefined}
        onNext={index >= 0 && index < media.length - 1 ? () => setOpen(media[index + 1].url) : undefined}
        onClose={() => setOpen(undefined)}
      />
    </div>
  );
}

/** The text a run returned beside its files (YuE2's ABC score): to read, copy, or sing again edited. */
function ScoreCard({ text, onUse }: { text: string; onUse?: () => void }) {
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <Card className="flex flex-col gap-2 p-3">
      <span className="text-xs font-medium">Score (ABC)</span>
      <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-[11px] leading-snug whitespace-pre-wrap">{text}</pre>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
        </Button>
        {onUse ? (
          <Button size="sm" variant="outline" onClick={onUse}>
            <Music /> Sing this score
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/** A run with nothing to show yet, or nothing to show at all: its state, its time so far and what it was asked for. */
function RunCard({ job, name }: { job: Job; name: string }) {
  const generation = generationOf(job);
  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate font-medium">{name}</span>
        <StatusBadge status={job.status} />
      </div>
      {isActive(job.status) ? (
        <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded-md bg-muted text-muted-foreground">
          <Spinner />
          <GenerationTime generation={generation} status={job.status} className="text-xs" />
          {job.totalSteps ? (
            <span className="text-[11px] tabular-nums">
              step {job.step ?? 0}/{job.totalSteps}
            </span>
          ) : null}
        </div>
      ) : null}
      {isActive(job.status) ? <Progress value={job.progress} indeterminate={job.status === 'queued'} /> : null}
      {job.error ? <ErrorNote>{job.error.message}</ErrorNote> : null}
      {generation.prompt ? (
        <p className="line-clamp-2 text-xs leading-snug text-muted-foreground" title={generation.prompt}>
          {generation.prompt}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">{[generation.mode, generation.seed !== undefined ? `seed ${generation.seed}` : undefined].filter(Boolean).join(' · ')}</span>
        {!isActive(job.status) ? <GenerationTime generation={generation} /> : null}
      </div>
    </Card>
  );
}
