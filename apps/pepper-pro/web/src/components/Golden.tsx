import * as React from 'react';
import { Equal, Play, Trophy } from 'lucide-react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  ErrorNote,
  Field,
  Select,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@pepper/ui/components/ui';
import { api, ApiRequestError, useResource } from '@pepper/ui/lib/api';
import { timeAgo } from '@pepper/ui/lib/utils';
import type { Recipe } from '@/lib/pro';

interface GoldenRun {
  id: string;
  recipeVersion: number;
  mode: string;
  status: 'preparing' | 'rendering' | 'done' | 'failed';
  error: string | null;
  createdAt: number;
  results: { id: string; shotId: string; status: string; file: string | null; error: string | null }[];
}

type Pair =
  | { done: true; versions: number[] }
  | { done: false; shot: string; remaining: number; left: { file: string; token: string }; right: { file: string; token: string } };

const fileUrl = (file: string) => `/v1/golden/files/${file.split('/').map(encodeURIComponent).join('/')}`;

function GoldenMedia({ file, kind }: { file: string; kind: Recipe['kind'] }) {
  if (kind === 'image') return <img src={fileUrl(file)} alt="" className="w-full rounded-md" />;
  if (kind === 'audio') return <audio src={fileUrl(file)} controls className="w-full" />;
  return <video src={fileUrl(file)} controls loop preload="metadata" className="w-full rounded-md bg-black" />;
}

/**
 * A recipe's golden shots (docs/PEPPER-PRO.md §9.4): render them for the
 * current version, see every version's results, and compare two versions
 * shot by shot without knowing which is which.
 */
export function GoldenDialog({ recipe, onOpenChange }: { recipe: Recipe | undefined; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={Boolean(recipe)} onOpenChange={onOpenChange}>
      {recipe ? (
        <DialogContent
          title={`Golden shots · ${recipe.name}`}
          description="Fixed shots and seeds, rendered for each version, compared blind."
          className="[--dialog-w:64rem]"
        >
          <Tabs defaultValue="runs" className="flex flex-col gap-3 p-5">
            <TabsList className="self-start">
              <TabsTrigger value="runs">Runs</TabsTrigger>
              <TabsTrigger value="compare">Blind A/B</TabsTrigger>
            </TabsList>
            <TabsContent value="runs">
              <Runs recipe={recipe} />
            </TabsContent>
            <TabsContent value="compare">
              <Compare recipe={recipe} />
            </TabsContent>
          </Tabs>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function Runs({ recipe }: { recipe: Recipe }) {
  const runs = useResource<{ runs: GoldenRun[] }>(`/v1/golden/runs?recipe=${encodeURIComponent(recipe.id)}`, 5000);
  const golden = useResource<{ inputs: { name: string; supply?: { path: string; present: boolean; note?: string } }[] }>('/v1/golden');
  const [mode, setMode] = React.useState(recipe.modes.some((m) => m.id === 'final') ? 'final' : recipe.default_mode);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const missing = (golden.data?.inputs ?? []).filter((i) => i.supply && !i.supply.present);

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.post('/v1/golden/runs', { recipe: recipe.id, mode });
      runs.reload();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Mode" className="w-48">
          <Select value={mode} onValueChange={setMode} options={recipe.modes.map((m) => ({ value: m.id, label: m.label }))} />
        </Field>
        <Button onClick={() => void start()} disabled={busy || recipe.state !== 'installed'}>
          {busy ? <Spinner /> : <Play />} Render v{recipe.version}
        </Button>
      </div>
      {missing.length ? (
        <p className="text-xs text-muted-foreground">
          Shots that need {missing.map((m) => m.name).join(', ')} are skipped until you add{' '}
          {missing.map((m) => (
            <code key={m.name} className="text-foreground">
              {m.supply!.path}
            </code>
          ))}
          {missing[0].supply?.note ? ` (${missing[0].supply.note})` : ''}.
        </p>
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {runs.data?.runs.length === 0 ? <p className="text-xs text-muted-foreground">No runs yet.</p> : null}
      {runs.data?.runs.map((run) => (
        <div key={run.id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="primary">v{run.recipeVersion}</Badge>
            <Badge variant="outline">{run.mode}</Badge>
            <Badge variant={run.status === 'failed' ? 'destructive' : run.status === 'done' ? 'success' : 'warning'}>{run.status}</Badge>
            <span className="text-muted-foreground">
              {run.results.filter((r) => r.status === 'completed').length}/{run.results.length} rendered · {timeAgo(new Date(run.createdAt).toISOString())}
            </span>
          </div>
          {run.error ? <ErrorNote>{run.error}</ErrorNote> : null}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {run.results.map((result) => (
              <div key={result.id} className="flex flex-col gap-1 text-[11px]">
                <span className="font-mono text-muted-foreground">{result.shotId}</span>
                {result.file ? <GoldenMedia file={result.file} kind={recipe.kind} /> : null}
                {result.status === 'running' || result.status === 'queued' ? <Spinner /> : null}
                {result.error ? <span className="text-muted-foreground">{result.status}: {result.error}</span> : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Compare({ recipe }: { recipe: Recipe }) {
  const [mode, setMode] = React.useState(recipe.modes.some((m) => m.id === 'final') ? 'final' : recipe.default_mode);
  const [pair, setPair] = React.useState<Pair>();
  const [reveal, setReveal] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  const tally = useResource<{ versions: { version: number; wins: number; losses: number; ties: number }[] }>(
    `/v1/golden/tally?recipe=${encodeURIComponent(recipe.id)}`,
  );

  const next = React.useCallback(async () => {
    setError(undefined);
    try {
      setPair(await api.get<Pair>(`/v1/golden/pair?recipe=${encodeURIComponent(recipe.id)}&mode=${encodeURIComponent(mode)}`));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : String(err));
    }
  }, [recipe.id, mode]);

  React.useEffect(() => void next(), [next]);

  const vote = async (winner: 'left' | 'right' | 'tie') => {
    if (!pair || pair.done) return;
    const result = await api.post<{ left: number; right: number; winner: number | null }>('/v1/golden/votes', {
      recipe: recipe.id,
      mode,
      shot: pair.shot,
      left: pair.left.token,
      right: pair.right.token,
      winner,
    });
    setReveal(`Left was v${result.left}, right was v${result.right}.`);
    tally.reload();
    void next();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Mode" className="w-48">
          <Select value={mode} onValueChange={setMode} options={recipe.modes.map((m) => ({ value: m.id, label: m.label }))} />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          {tally.data?.versions.map((v) => (
            <Badge key={v.version} variant="outline">
              v{v.version}: {v.wins} won · {v.ties} tied · {v.losses} lost
            </Badge>
          ))}
        </div>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {reveal ? <p className="text-xs text-muted-foreground">{reveal}</p> : null}
      {!pair ? <Spinner /> : null}
      {pair?.done ? (
        <p className="text-xs text-muted-foreground">
          {pair.versions.length < 2
            ? 'Two versions need golden runs in this mode before they can be compared.'
            : `Every shared shot of v${pair.versions[0]} and v${pair.versions[1]} has a vote.`}
        </p>
      ) : null}
      {pair && !pair.done ? (
        <>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">{pair.shot}</span> · {pair.remaining} to go
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <GoldenMedia file={pair.left.file} kind={recipe.kind} />
            <GoldenMedia file={pair.right.file} kind={recipe.kind} />
          </div>
          <div className="flex justify-center gap-2">
            <Button variant="outline" onClick={() => void vote('left')}>
              <Trophy /> Left is better
            </Button>
            <Button variant="outline" onClick={() => void vote('tie')}>
              <Equal /> Tie
            </Button>
            <Button variant="outline" onClick={() => void vote('right')}>
              <Trophy /> Right is better
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
