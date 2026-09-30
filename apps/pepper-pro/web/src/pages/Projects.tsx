import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Clapperboard, Plus } from 'lucide-react';
import { Page } from '@pepper/ui/components/layout';
import { Badge, Button, Card, Dialog, DialogContent, EmptyState, ErrorNote, Field, Input, Select, Spinner, Textarea } from '@pepper/ui/components/ui';
import { api, ApiRequestError, useResource } from '@pepper/ui/lib/api';
import { timeAgo } from '@pepper/ui/lib/utils';
import { ASPECTS, type Project } from '@/lib/pro';

/** Every project, newest first, and starting a new one. */
export function ProjectsPage() {
  const list = useResource<{ projects: Project[] }>('/v1/projects');
  const [creating, setCreating] = React.useState(false);
  const projects = [...(list.data?.projects ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <Page
      title="Projects"
      description="A project is a script, its cast and places, scenes of shots, takes of each shot, and a cut."
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New project
        </Button>
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
            <Button size="sm" onClick={() => setCreating(true)}>
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
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}

function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [name, setName] = React.useState('');
  const [aspect, setAspect] = React.useState<string>('9:16');
  const [style, setStyle] = React.useState('');
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const project = await api.post<Project>('/v1/projects', { name: name.trim(), aspect, style: style.trim() || undefined });
      onOpenChange(false);
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New project">
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
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <Button onClick={() => void create()} disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : <Plus />} Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
