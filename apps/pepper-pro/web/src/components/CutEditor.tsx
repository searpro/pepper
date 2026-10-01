import * as React from 'react';
import { ArrowDown, ArrowUp, Check, Film, ListRestart, Plus, Scissors, Trash2 } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Progress, Select, Spinner, Switch } from '@pepper/ui/components/ui';
import { api, ApiRequestError } from '@pepper/ui/lib/api';
import { TakeMedia } from '@/components/ShotDialog';
import { beatsOf, isActive, type Asset, type Cut, type CutItem, type ProjectDetail, type Shot, type Take } from '@/lib/pro';

const NONE = '__none__';

/**
 * The edit: chosen takes in order with their trims and transitions, a music
 * bed ducked under dialogue, burned-in subtitles, exported with ffmpeg as a
 * `render` job normalised to -14 LUFS.
 */
export function CutEditor({ project, onChanged }: { project: ProjectDetail; onChanged: () => void }) {
  const cut = project.cuts[0];
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();

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

  if (!cut) {
    const chosen = project.scenes.flatMap((s) => s.shots).filter((s) => s.chosenTakeId).length;
    return (
      <div className="flex flex-col gap-3">
        <EmptyState
          icon={Scissors}
          title="No cut yet"
          description={
            chosen
              ? `Start from the ${chosen} chosen take${chosen === 1 ? '' : 's'}, in storyboard order.`
              : 'Choose a take for each shot on the storyboard first.'
          }
          action={
            <Button size="sm" disabled={busy || !chosen} onClick={() => void act(() => api.post(`/v1/projects/${project.id}/cuts`, {}))}>
              <Plus /> Create the cut
            </Button>
          }
        />
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
    );
  }
  return <CutForm key={cut.id} cut={cut} project={project} busy={busy} error={error} act={act} />;
}

function CutForm({
  cut,
  project,
  busy,
  error,
  act,
}: {
  cut: Cut;
  project: ProjectDetail;
  busy: boolean;
  error: string | undefined;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [items, setItems] = React.useState<CutItem[]>(cut.items);
  const [music, setMusic] = React.useState(cut.music);
  const [subtitles, setSubtitles] = React.useState(cut.subtitles);
  const [beatSync, setBeatSync] = React.useState(cut.beatSync);

  const shots = project.scenes.flatMap((s) => s.shots);
  const takes = new Map<string, { take: Take; shot: Shot }>();
  for (const shot of shots) for (const take of shot.takes) takes.set(take.id, { take, shot });
  const musicAssets = project.assets.filter((a: Asset) => a.audio);
  const dirty =
    JSON.stringify([items, music, subtitles, beatSync]) !== JSON.stringify([cut.items, cut.music, cut.subtitles, cut.beatSync]);
  const musicBeats = beatsOf(project.assets.find((a) => a.id === music?.asset_id));
  const exported = cut.export?.result as { video_url?: string; subtitles_url?: string } | undefined;

  const move = (index: number, by: number) => {
    const next = [...items];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item);
    setItems(next);
  };
  const update = (index: number, patch: Partial<CutItem>) => setItems(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  const fromChosen = () =>
    setItems(
      shots
        .filter((s) => s.chosenTakeId)
        .map((s) => items.find((i) => i.take_id === s.chosenTakeId) ?? { take_id: s.chosenTakeId as string }),
    );
  const save = () => act(() => api.patch(`/v1/cuts/${cut.id}`, { items, music, subtitles, beatSync }));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex flex-col gap-2">
        {items.length === 0 ? <p className="text-xs text-muted-foreground">The cut is empty.</p> : null}
        {items.map((item, index) => {
          const found = takes.get(item.take_id);
          return (
            <Card key={`${item.take_id}-${index}`} className="flex items-center gap-3 p-2">
              <div className="w-40 shrink-0">{found ? <TakeMedia take={found.take} /> : <Badge variant="destructive">take deleted</Badge>}</div>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <p className="truncate text-xs">
                  <span className="font-medium">{index + 1}.</span> {found?.shot.prompt ?? item.take_id}
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="In (s)" className="w-20">
                    <Input type="number" min={0} step={0.1} value={item.in ?? ''} placeholder="0" onChange={(e) => update(index, { in: e.target.value === '' ? undefined : Number(e.target.value) })} />
                  </Field>
                  <Field label="Out (s)" className="w-20">
                    <Input type="number" min={0} step={0.1} value={item.out ?? ''} placeholder="end" onChange={(e) => update(index, { out: e.target.value === '' ? undefined : Number(e.target.value) })} />
                  </Field>
                  <Field label="Into next" className="w-28">
                    <Select
                      value={item.transition ?? 'cut'}
                      onValueChange={(v) => update(index, { transition: v as 'cut' | 'fade' })}
                      options={[
                        { value: 'cut', label: 'Cut' },
                        { value: 'fade', label: 'Crossfade' },
                      ]}
                    />
                  </Field>
                </div>
              </div>
              <div className="flex flex-col">
                <Button size="icon-sm" variant="ghost" aria-label="Earlier" disabled={index === 0} onClick={() => move(index, -1)}>
                  <ArrowUp />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Later" disabled={index === items.length - 1} onClick={() => move(index, 1)}>
                  <ArrowDown />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => setItems(items.filter((_, i) => i !== index))}>
                  <Trash2 />
                </Button>
              </div>
            </Card>
          );
        })}
        <Button variant="outline" size="sm" className="self-start" onClick={fromChosen}>
          <ListRestart /> Match the chosen takes
        </Button>
      </div>

      <Card className="flex h-fit flex-col gap-3 p-4">
        <Field label="Music">
          <Select
            value={music?.asset_id ?? NONE}
            onValueChange={(v) => setMusic(v === NONE ? null : { asset_id: v, gain_db: music?.gain_db ?? -12, duck: music?.duck ?? true })}
            options={[{ value: NONE, label: 'None' }, ...musicAssets.map((a) => ({ value: a.id, label: a.name }))]}
          />
        </Field>
        {music ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Level (dB)">
              <Input type="number" min={-40} max={6} value={music.gain_db ?? -12} onChange={(e) => setMusic({ ...music, gain_db: Number(e.target.value) })} />
            </Field>
            <Field label="Duck under speech">
              <Switch checked={music.duck ?? true} onCheckedChange={(duck) => setMusic({ ...music, duck })} />
            </Field>
          </div>
        ) : null}
        {music ? (
          <Field
            label="Cut on the beat"
            hint={
              musicBeats
                ? `Joins move back to the nearest of ${musicBeats.beats.length} beats (${Math.round(musicBeats.bpm)} bpm).`
                : 'Find the track\'s beats under Cast first.'
            }
          >
            <Switch checked={beatSync} onCheckedChange={setBeatSync} disabled={!musicBeats && !beatSync} />
          </Field>
        ) : null}
        <Field label="Burn in subtitles" hint="From each shot's dialogue; an .srt is written alongside either way.">
          <Switch checked={subtitles} onCheckedChange={setSubtitles} />
        </Field>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy || !dirty} onClick={() => void save()}>
            <Check /> Save
          </Button>
          <Button
            disabled={busy || items.length === 0 || (cut.export !== null && isActive(cut.export.status))}
            onClick={() => void act(async () => {
              if (dirty) await api.patch(`/v1/cuts/${cut.id}`, { items, music, subtitles, beatSync });
              await api.post(`/v1/cuts/${cut.id}/export`, {});
            })}
          >
            {busy ? <Spinner /> : <Film />} Export
          </Button>
        </div>
        {cut.export ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs">
              <Badge variant={cut.export.status === 'failed' ? 'destructive' : cut.export.status === 'completed' ? 'success' : 'default'}>
                {cut.export.status}
              </Badge>
              {isActive(cut.export.status) ? <Progress value={cut.export.progress} className="flex-1" /> : null}
            </div>
            {cut.export.error ? <ErrorNote>{cut.export.error.message}</ErrorNote> : null}
            {exported?.video_url ? (
              <>
                <video src={exported.video_url} controls className="w-full rounded-md bg-black" />
                <a href={exported.video_url} download className="text-xs text-primary underline-offset-2 hover:underline">
                  Download the export
                </a>
              </>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
