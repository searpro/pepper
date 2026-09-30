import { z } from 'zod';
import { JOB_KINDS } from './jobs/manager.js';

/** Wire shapes shared by every product's API. */

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export const jobKindSchema = z.enum(JOB_KINDS);
export const jobStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);

export const jobSchema = z.object({
  id: z.string(),
  kind: jobKindSchema,
  status: jobStatusSchema,
  progress: z.number(),
  step: z.number().optional(),
  totalSteps: z.number().optional(),
  params: z.record(z.unknown()),
  result: z.record(z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  attempts: z.number(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});
