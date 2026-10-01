import * as React from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Wand2 } from 'lucide-react';
import { Page } from '@pepper/ui/components/layout';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Progress, Select, Spinner } from '@pepper/ui/components/ui';
import { api, ApiRequestError, useResource, type Job } from '@pepper/ui/lib/api';
import { ParamForm } from '@/components/inputs';
import { LicenceNotice } from '@/components/licence';
import { isActive, type Recipe, type RecipeList } from '@/lib/pro';

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
  const [batch, setBatch] = React.useState(1);
  const [jobIds, setJobIds] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();

  // A different recipe has different parameters; carry over only the prompt.
  const choose = (id: string) => {
    setRecipeId(id);
    setMode(undefined);
    setValues((v) => (v.prompt ? { prompt: v.prompt } : {}));
  };

  const submit = async () => {
    if (!recipe) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.post<Job | { jobs: Job[] }>('/v1/jobs', {
        recipe: recipe.id,
        mode: mode ?? recipe.default_mode,
        params: values,
        batch,
      });
      const created = 'jobs' in result ? result.jobs : [result];
      setJobIds((ids) => [...created.map((j) => j.id), ...ids].slice(0, 24));
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
      <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
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
              <ParamForm params={recipe.params} values={values} onChange={setValues} />
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
        <div className="grid content-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {jobIds.length === 0 ? (
            <p className="text-xs text-muted-foreground">Results appear here, and stay in Jobs and Media.</p>
          ) : null}
          {jobIds.map((id) => (
            <JobResult key={id} id={id} recipes={installed} />
          ))}
        </div>
      </div>
    </Page>
  );
}

/** One job's result, polled until it settles. */
export function JobResult({ id, recipes }: { id: string; recipes: Recipe[] }) {
  const [job, setJob] = React.useState<Job>();
  React.useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const next = await api.get<Job>(`/v1/jobs/${id}`);
        if (!live) return;
        setJob(next);
        if (isActive(next.status)) setTimeout(() => void tick(), 1500);
      } catch {
        if (live) setTimeout(() => void tick(), 5000);
      }
    };
    void tick();
    return () => {
      live = false;
    };
  }, [id]);

  const result = job?.result as { video_url?: string; image_url?: string; audio_url?: string } | undefined;
  const recipe = recipes.find((r) => r.id === job?.params.recipe);
  return (
    <Card className="flex flex-col gap-2 overflow-hidden p-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate">{recipe?.name ?? String(job?.params.recipe ?? '')}</span>
        <Badge variant={job?.status === 'failed' ? 'destructive' : job?.status === 'completed' ? 'success' : 'default'}>
          {job?.status ?? '…'}
        </Badge>
      </div>
      {job && isActive(job.status) ? <Progress value={job.progress} indeterminate={job.status === 'queued'} /> : null}
      {result?.video_url ? <video src={result.video_url} controls className="w-full rounded-md" /> : null}
      {result?.image_url ? <img src={result.image_url} alt="" className="w-full rounded-md" /> : null}
      {result?.audio_url ? <audio src={result.audio_url} controls className="w-full" /> : null}
      {job?.error ? <ErrorNote>{job.error.message}</ErrorNote> : null}
    </Card>
  );
}
