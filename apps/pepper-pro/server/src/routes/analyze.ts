import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errors } from '@pepper/core/errors.js';
import type { JobManager } from '@pepper/core/jobs/manager.js';
import type { ProjectService } from '../projects/service.js';

export interface AnalyzeRoutesOptions {
  jobs: JobManager;
  projects: ProjectService;
}

export const analyzeSchema = z.object({
  task: z.enum(['beats', 'stems', 'check']),
  audio: z.string().optional().describe('beats/stems: an upload name'),
  asset_id: z.string().optional().describe('beats/stems: an asset with audio; results are stored on it'),
  take_id: z.string().optional().describe('check: the take to review'),
  model: z.string().optional().describe('check: a llama.cpp vision model, instead of CHECK_MODEL'),
});

/** Analysis jobs: beats and stems of a track, a vision model's check of a take (engines/analyze.ts). */
export async function analyzeRoutes(fastify: FastifyInstance, options: AnalyzeRoutesOptions): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { jobs, projects } = options;

  app.post(
    '/v1/analyze',
    {
      schema: {
        tags: ['projects'],
        summary: 'Queue an analysis: beats or stems of a track, or a check of a take',
        body: analyzeSchema,
      },
    },
    async (req, reply) => {
      const body = req.body;
      // Checked here so a bad reference is a 400 now, not a failed job later.
      if (body.task === 'check') {
        if (!body.take_id) throw errors.validation('`take_id` is required to check a take');
        projects.requireTake(body.take_id);
      } else if (body.asset_id) {
        projects.requireAsset(body.asset_id);
      } else if (!body.audio) {
        throw errors.validation('Give `audio` (an upload name) or `asset_id`');
      }
      return reply.code(202).send(jobs.create('analyze', body));
    },
  );
}
