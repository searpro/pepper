import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Clapperboard, Plus, Sparkles, Trash2 } from 'lucide-react';
import { Page } from '@pepper/ui/components/layout';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Select,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@pepper/ui/components/ui';
import { api, ApiRequestError, useResource } from '@pepper/ui/lib/api';
import { cn } from '@pepper/ui/lib/utils';
import { AssetsPanel } from '@/components/Assets';
import { CutEditor } from '@/components/CutEditor';
import { ShotDialog, TakeMedia } from '@/components/ShotDialog';
import { ASPECTS, isActive, type ProjectDetail, type RecipeList, type Scene, type Shot } from '@/lib/pro';

/**
 * One project: the storyboard (scenes of shots, each with its takes), the
 * cast, the cut and the project's settings. Polls fast while anything is
 * rendering so takes appear as they finish.
 */
export function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [fast, setFast] = React.useState(false);
  const project = useResource<ProjectDetail>(id ? `/v1/projects/${id}` : null, fast ? 2000 : 15_000);
  const recipes = useResource<RecipeList>('/v1/recipes?kind=video', 30_000);
  const [openShot, setOpenShot] = React.useState<string>();

  const data = project.data;
  React.useEffect(() => {
    if (!data) return;
    const rendering =
      data.scenes.some((s) => s.shots.some((shot) => shot.takes.some((t) => isActive(t.status)))) ||
      data.cuts.some((c) => c.export && isActive(c.export.status));
    setFast(rendering);
  }, [data]);

  const shots = data?.scenes.flatMap((s) => s.shots) ?? [];
  const shot = shots.find((s) => s.id === openShot);
  const videoRecipes = (recipes.data?.recipes ?? []).filter((r) => r.params.some((p) => p.name === 'prompt'));

  if (project.error) {
    return (
      <Page title="Project">
        <ErrorNote>{project.error.message}</ErrorNote>
      </Page>
    );
  }
  if (!data) {
    return (
      <Page title="Project">
        <Spinner />
      </Page>
    );
  }

  return (
    <Page
      title={data.name}
      description={`${data.aspect} · ${data.fps} fps · ${shots.length} shots · ${shots.filter((s) => s.chosenTakeId).length} chosen`}
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link to="/projects">
            <ArrowLeft /> Projects
          </Link>
        </Button>
      }
    >
      <Tabs defaultValue="storyboard" className="flex flex-col gap-4">
        <TabsList className="self-start">
          <TabsTrigger value="storyboard">Storyboard</TabsTrigger>
          <TabsTrigger value="cast">Cast ({data.assets.length})</TabsTrigger>
          <TabsTrigger value="cut">Cut</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="storyboard">
          <Storyboard project={data} onOpenShot={setOpenShot} onChanged={project.reload} />
        </TabsContent>
        <TabsContent value="cast">
          <AssetsPanel projectId={data.id} assets={data.assets} onChanged={project.reload} />
        </TabsContent>
        <TabsContent value="cut">
          <CutEditor project={data} onChanged={project.reload} />
        </TabsContent>
        <TabsContent value="settings">
          <Settings key={data.updatedAt} project={data} onChanged={project.reload} />
        </TabsContent>
      </Tabs>
      <ShotDialog
        shot={shot}
        assets={data.assets}
        recipes={videoRecipes}
        onOpenChange={(open) => !open && setOpenShot(undefined)}
        onChanged={project.reload}
      />
    </Page>
  );
}

function Storyboard({ project, onOpenShot, onChanged }: { project: ProjectDetail; onOpenShot: (id: string) => void; onChanged: () => void }) {
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const untaken = project.scenes.flatMap((s) => s.shots).filter((s) => s.takes.length === 0);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (project.scenes.length === 0) {
    return (
      <EmptyState
        icon={Clapperboard}
        title="An empty storyboard"
        description="Add a scene and its shots here, or give Claude the script and ask it to plan the project."
        action={
          <Button size="sm" onClick={() => void act(() => api.post(`/v1/projects/${project.id}/scenes`, { title: 'Scene 1' }))}>
            <Plus /> Add a scene
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {untaken.length ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void act(() => api.post('/v1/shots/render', { shot_ids: untaken.map((s) => s.id), mode: 'draft', count: 2 }))}
          >
            {busy ? <Spinner /> : <Sparkles />} Draft {untaken.length} new shot{untaken.length === 1 ? '' : 's'} ×2
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void act(() => api.post(`/v1/projects/${project.id}/scenes`, { title: `Scene ${project.scenes.length + 1}` }))}
        >
          <Plus /> Scene
        </Button>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {project.scenes.map((scene, index) => (
        <SceneRow key={scene.id} scene={scene} index={index} onOpenShot={onOpenShot} act={act} />
      ))}
    </div>
  );
}

function SceneRow({
  scene,
  index,
  onOpenShot,
  act,
}: {
  scene: Scene;
  index: number;
  onOpenShot: (id: string) => void;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [title, setTitle] = React.useState(scene.title);
  React.useEffect(() => setTitle(scene.title), [scene.title]);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{index + 1}</span>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title !== scene.title && void act(() => api.patch(`/v1/scenes/${scene.id}`, { title }))}
          className="h-8 max-w-md border-transparent bg-transparent font-semibold shadow-none hover:border-border"
        />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Delete scene"
          onClick={() => confirm(`Delete "${scene.title}" and its ${scene.shots.length} shots?`) && void act(() => api.delete(`/v1/scenes/${scene.id}`))}
        >
          <Trash2 />
        </Button>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
        {scene.shots.map((shot) => (
          <ShotCard key={shot.id} shot={shot} onOpen={() => onOpenShot(shot.id)} />
        ))}
        <button
          onClick={() =>
            void act(async () => {
              const created = await api.post<Shot>(`/v1/scenes/${scene.id}/shots`, { prompt: '' });
              onOpenShot(created.id);
            })
          }
          className="flex w-40 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:bg-accent/40"
        >
          <Plus className="size-4" /> Shot
        </button>
      </div>
    </section>
  );
}

function ShotCard({ shot, onOpen }: { shot: Shot; onOpen: () => void }) {
  const chosen = shot.takes.find((t) => t.id === shot.chosenTakeId);
  const latest = chosen ?? shot.takes.find((t) => t.status === 'completed');
  const running = shot.takes.filter((t) => isActive(t.status)).length;
  const failed = shot.takes.filter((t) => t.status === 'failed').length;

  return (
    <Card
      onClick={onOpen}
      className={cn('flex w-56 shrink-0 cursor-pointer flex-col gap-2 p-2 transition-colors hover:bg-accent/40', chosen && 'border-primary/60')}
    >
      <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-muted">
        {latest ? <TakeMedia take={latest} className="pointer-events-none max-h-full" /> : <Clapperboard className="size-5 text-muted-foreground/50" />}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="outline">{shot.kind}</Badge>
        <Badge>{shot.durationS}s</Badge>
        {chosen ? <Badge variant="primary">{chosen.mode}</Badge> : null}
        {running ? <Badge variant="warning">{running} rendering</Badge> : null}
        {failed ? <Badge variant="destructive">{failed} failed</Badge> : null}
      </div>
      <p className="line-clamp-3 text-xs text-muted-foreground">{shot.prompt || 'No prompt yet'}</p>
      {shot.dialogue.length ? <p className="line-clamp-2 text-xs italic">“{shot.dialogue[0].line}”</p> : null}
    </Card>
  );
}

function Settings({ project, onChanged }: { project: ProjectDetail; onChanged: () => void }) {
  const navigate = useNavigate();
  const [draft, setDraft] = React.useState({
    name: project.name,
    description: project.description,
    aspect: project.aspect,
    fps: project.fps,
    style: project.style,
    licenceMode: project.licenceMode,
    script: project.script,
  });
  const [error, setError] = React.useState<string>();
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    setError(undefined);
    try {
      await api.patch(`/v1/projects/${project.id}`, draft);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : String(err));
    }
  };

  return (
    <Card className="flex max-w-3xl flex-col gap-3 p-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Name" className="sm:col-span-2">
          <Input value={draft.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Aspect">
          <Select value={draft.aspect} onValueChange={(v) => set('aspect', v)} options={ASPECTS.map((a) => ({ value: a, label: a }))} />
        </Field>
        <Field label="Frame rate">
          <Input type="number" min={8} max={60} value={draft.fps} onChange={(e) => set('fps', Number(e.target.value))} />
        </Field>
      </div>
      <Field label="Look" hint="Prepended to every shot's prompt.">
        <Textarea rows={2} value={draft.style} onChange={(e) => set('style', e.target.value)} />
      </Field>
      <Field label="Use" hint="Commercial projects cannot render with research-only recipes.">
        <Select
          value={draft.licenceMode}
          onValueChange={(v) => set('licenceMode', v as 'personal' | 'commercial')}
          options={[
            { value: 'personal', label: 'Personal' },
            { value: 'commercial', label: 'Commercial' },
          ]}
        />
      </Field>
      <Field label="Script" hint="Kept with the project; Claude plans scenes and shots from it.">
        <Textarea rows={10} value={draft.script} onChange={(e) => set('script', e.target.value)} />
      </Field>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="flex justify-between gap-2">
        <Button onClick={() => void save()}>Save</Button>
        <Button
          variant="destructive"
          onClick={() => {
            if (confirm(`Delete "${project.name}", its takes and cuts?`)) void api.delete(`/v1/projects/${project.id}`).then(() => navigate('/projects'));
          }}
        >
          <Trash2 /> Delete project
        </Button>
      </div>
    </Card>
  );
}
