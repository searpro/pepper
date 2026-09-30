import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Clapperboard, FileText, Plus } from 'lucide-react';
import { Page } from '@pepper/ui/components/layout';
import { Badge, Button, Card, Dialog, DialogContent, EmptyState, ErrorNote, Field, Input, Select, Spinner, Textarea } from '@pepper/ui/components/ui';
import { api, ApiRequestError, useResource, waitForJob } from '@pepper/ui/lib/api';
import { timeAgo } from '@pepper/ui/lib/utils';
import { ASPECTS, type Project } from '@/lib/pro';

/** Every project, newest first, and starting a new one. */
export function ProjectsPage() {
  const list = useResource<{ projects: Project[] }>('/v1/projects');
  const [creating, setCreating] = React.useState<false | 'blank' | 'script'>(false);
  const projects = [...(list.data?.projects ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <Page
      title="Projects"
      description="A project is a script, its cast and places, scenes of shots, takes of each shot, and a cut."
      actions={
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setCreating('script')}>
            <FileText /> New from script
          </Button>
          <Button size="sm" onClick={() => setCreating('blank')}>
            <Plus /> New project
          </Button>
        </div>
      }
    >
      {list.error ? <ErrorNote>{list.error.message}</ErrorNote> : null}
      {list.loading && !list.data ? <Spinner /> : null}
      {list.data && projects.length === 0 ? (
        <EmptyState
          icon={Clapperboard}
          title="No projects yet"
          description="Start one here, or ask Claude to plan one over MCP (plan_project)."
          action={
            <Button size="sm" onClick={() => setCreating('blank')}>
              <Plus /> New project
            </Button>
          }
        />
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {projects.map((project) => (
          <Link key={project.id} to={`/projects/${project.id}`}>
            <Card className="flex h-full flex-col gap-2 p-4 transition-colors hover:bg-accent/40">
              <div className="flex items-center justify-between gap-2">
                <h3 className="truncate text-sm font-semibold">{project.name}</h3>
                <Badge variant="outline">{project.aspect}</Badge>
              </div>
              {project.description ? <p className="line-clamp-2 text-xs text-muted-foreground">{project.description}</p> : null}
              {project.style ? <p className="line-clamp-2 text-xs italic text-muted-foreground">{project.style}</p> : null}
              <p className="mt-auto text-[11px] text-muted-foreground">Updated {timeAgo(new Date(project.updatedAt).toISOString())}</p>
            </Card>
          </Link>
        ))}
      </div>
      <NewProjectDialog
        open={Boolean(creating)}
        fromScript={creating === 'script'}
        onOpenChange={(open) => setCreating(open ? creating || 'blank' : false)}
      />
    </Page>
  );
}

/**
 * A new project, blank or from a script. From a script, the local plan model
 * (PLAN_MODEL) breaks it into cast, scenes and shots before the project
 * opens; if it fails the project still opens, with the script kept, to plan
 * by hand or with Claude.
 */
function NewProjectDialog({ open, fromScript, onOpenChange }: { open: boolean; fromScript: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [name, setName] = React.useState('');
  const [aspect, setAspect] = React.useState<string>('9:16');
  const [style, setStyle] = React.useState('');
  const [script, setScript] = React.useState('');
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState<string>();
  const [created, setCreated] = React.useState<string>();

  const create = async () => {
    setBusy('Creating');
    setError(undefined);
    let project: Project | undefined;
    try {
      project = await api.post<Project>('/v1/projects', {
        name: name.trim(),
        aspect,
        style: style.trim() || undefined,
        script: fromScript ? script : undefined,
      });
      if (fromScript) {
        setBusy('Planning shots');
        const job = await api.post<{ id: string }>('/v1/analyze', { task: 'plan', project_id: project.id });
        const done = await waitForJob(job.id, 1500);
        if (done.status !== 'completed') throw new Error(done.error?.message ?? 'Planning failed');
      }
      onOpenChange(false);
      navigate(`/projects/${project.id}`);
    } catch (err) {
      const text = err instanceof ApiRequestError ? err.error.message : err instanceof Error ? err.message : String(err);
      setError(project ? `The project was created, but planning failed: ${text}` : text);
      setCreated(project?.id);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={fromScript ? 'New project from a script' : 'New project'}>
        <div className="flex flex-col gap-3 p-5">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Aspect ratio" hint="9:16 for Reels, Shorts and TikTok; 16:9 for YouTube.">
            <Select value={aspect} onValueChange={setAspect} options={ASPECTS.map((a) => ({ value: a, label: a }))} />
          </Field>
          <Field label="Look" hint="Prepended to every shot's prompt: film stock, grade, lens, era.">
            <Textarea rows={3} value={style} onChange={(e) => setStyle(e.target.value)} />
          </Field>
          {fromScript ? (
            <Field label="Script" hint="A local model (PLAN_MODEL) breaks it into cast, scenes and shots. Claude can do the same through plan_project.">
              <Textarea rows={10} value={script} onChange={(e) => setScript(e.target.value)} />
            </Field>
          ) : null}
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {created ? (
            <Button onClick={() => navigate(`/projects/${created}`)}>Open the project</Button>
          ) : (
            <Button onClick={() => void create()} disabled={Boolean(busy) || !name.trim() || (fromScript && !script.trim())}>
              {busy ? <Spinner /> : <Plus />} {busy ?? 'Create'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
