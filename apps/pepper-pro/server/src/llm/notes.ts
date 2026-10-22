import type { GpuLanes } from '@pepper/core/engines/gpu.js';
import type { Job, JobManager } from '@pepper/core/jobs/manager.js';

/**
 * What a Claude Code running on the agent model is told about the GPU it
 * shares with renders (`x-pepper-agent: local`; see core's routes/mcp.ts).
 * Its turns wait for every queued render, which it cannot see from inside a
 * turn: without this it reads a ten-minute pause as nothing, and queues the
 * next render only after polling the last one, paying a model swap each time.
 */
export const AGENT_INSTRUCTIONS =
  'You run on a language model that shares this GPU with the renders, and renders go first: while any ' +
  'render is queued or running, your next turn waits until the queue is empty (the model is unloaded, then ' +
  'reloaded with this conversation intact). So queue every render you can in one go before waiting on any, ' +
  'and after queueing call get_job once on their ids: it returns when they are done. Job results carry ' +
  '`notes` with the time left and, after a pause, what finished.';

function seconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

const recipeKey = (job: Job) => `${String(job.params.recipe)}/${String(job.params.mode ?? '')}`;
const isRender = (job: Job) => typeof job.params.recipe === 'string';
const elapsed = (job: Job) => (job.startedAt ? Date.now() - Date.parse(job.startedAt) : 0);

/** The notes for one result: a pause just past, then what is still ahead. */
export function agentNotes(gpu: GpuLanes, jobs: JobManager): (shown: Job[]) => string[] {
  return () => {
    if (!gpu.state().shared) return [];
    const notes: string[] = [];

    const pause = gpu.takePause();
    if (pause) {
      const done = jobs
        .list({ status: ['completed', 'failed', 'cancelled'], limit: 100 })
        .filter((job) => job.finishedAt && Date.parse(job.finishedAt) >= pause.from && Date.parse(job.finishedAt) <= pause.to);
      const failed = done.filter((job) => job.status !== 'completed').length;
      notes.push(
        `Your last turn waited ${seconds(pause.to - pause.from)} for renders` +
          (done.length ? ` (${done.length - failed} completed${failed ? `, ${failed} failed or cancelled` : ''}).` : '.'),
      );
    }

    const active = jobs.list({ status: ['queued', 'running'] }).filter(isRender);
    if (active.length) {
      // Time left from how long the same recipe and mode took before; a recipe never run gives no estimate.
      const took = new Map<string, number[]>();
      for (const job of jobs.list({ status: ['completed'], limit: 200 }).filter(isRender)) {
        if (!job.startedAt || !job.finishedAt) continue;
        const list = took.get(recipeKey(job)) ?? [];
        list.push(Date.parse(job.finishedAt) - Date.parse(job.startedAt));
        took.set(recipeKey(job), list);
      }
      let left = 0;
      let known = true;
      for (const job of active) {
        const past = took.get(recipeKey(job));
        if (!past) {
          known = false;
          continue;
        }
        const average = past.reduce((a, b) => a + b, 0) / past.length;
        left += Math.max(average - elapsed(job), 10_000);
      }
      const eta = left > 0 ? `, about ${seconds(left)} left${known ? '' : ' plus recipes not timed yet'}` : '';
      notes.push(
        `${active.length} render${active.length === 1 ? '' : 's'} queued or running${eta}. ` +
          'Your next turn waits until the queue is empty: queue anything else you need now.',
      );
    }
    return notes;
  };
}
