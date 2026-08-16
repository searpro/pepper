import { Readable } from 'node:stream';
import { stat, unlink, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errors } from '../errors.js';
import { safeResolve } from '../paths.js';
import { listFiles, uniqueOutputName } from '../util/files.js';
import { proxyToBackend, type ProxyBody } from '../services/proxy.js';

/**
 * Audio generation, voice design and transcription (requirement 2).
 *
 * Speech and transcription are proxied to audio.cpp the same way text
 * generation is proxied to llama.cpp. Voice references — the WAV a
 * voice-cloning or voice-design model conditions on — are stored by this app,
 * since audio.cpp takes a path and has no upload surface of its own.
 */
export async function audioRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/v1/audio/speech',
    {
      schema: {
        tags: ['audio'],
        summary: 'Generate speech (OpenAI-compatible)',
        description:
          'Set `voice_ref` to the name of an uploaded reference clip for voice cloning or ' +
          'voice design; it is resolved to an absolute path before being forwarded.',
        body: z
          .object({
            model: z.string().min(1),
            input: z.string().min(1),
            voice: z.string().optional(),
            voice_ref: z.string().optional(),
          })
          .passthrough(),
      },
    },
    async (req, reply) => {
      const body = { ...(req.body as Record<string, unknown>) };

      // A reference name is a user-supplied path segment, so it is validated
      // and resolved here rather than forwarded verbatim — audio.cpp would
      // happily open whatever path it is handed.
      if (typeof body.voice_ref === 'string') {
        const path = safeResolve(app.paths.uploadsDir, body.voice_ref);
        try {
          await stat(path);
        } catch {
          throw errors.audioVoiceRefNotFound(body.voice_ref);
        }
        body.voice_ref = path;
      }

      return proxyToBackend(app.backends, req, reply, {
        backend: 'audiocpp',
        upstreamPath: '/v1/audio/speech',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: app.config.audiocppTimeoutMs,
      });
    },
  );

  /**
   * Transcription uploads are forwarded raw.
   *
   * `@fastify/multipart` is registered globally for `/v1/inputs`, but
   * content-type parsers are cloned per encapsulated plugin context, so this
   * scope can swap in a no-op parser for `multipart/form-data` without
   * affecting anything else. The clone already contains the inherited parser
   * at this point, which is why it must be removed before a new one is added.
   * With the no-op in place `req.raw` is still an unconsumed stream and can be
   * piped straight upstream, letting audio.cpp's own parser see the exact
   * bytes the client sent — boundary and all — instead of us decoding and
   * re-encoding a form we have no reason to inspect.
   */
  app.removeContentTypeParser('multipart/form-data');
  app.addContentTypeParser('multipart/form-data', (_req, _payload, done) => done(null, undefined));

  app.post(
    '/v1/audio/transcriptions',
    {
      schema: {
        tags: ['audio'],
        summary: 'Transcribe audio (OpenAI-compatible, multipart upload)',
        consumes: ['multipart/form-data'],
      },
    },
    async (req, reply) =>
      proxyToBackend(app.backends, req, reply, {
        backend: 'audiocpp',
        upstreamPath: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Content-Type': req.headers['content-type'] ?? 'multipart/form-data',
          // audio.cpp's multipart parser needs a declared length: without this
          // undici sends the upload chunked and the parser sees no `file`
          // field at all, failing with "requires a non-empty 'file' field".
          ...(req.headers['content-length']
            ? { 'Content-Length': req.headers['content-length'] }
            : {}),
        },
        body: Readable.toWeb(req.raw) as unknown as ProxyBody,
        timeoutMs: app.config.audiocppTimeoutMs,
      }),
  );

  app.get(
    '/v1/audio/voices',
    { schema: { tags: ['audio'], summary: 'Voices the loaded models provide' } },
    async (req, reply) =>
      proxyToBackend(app.backends, req, reply, {
        backend: 'audiocpp',
        upstreamPath: '/v1/audio/voices',
        method: 'GET',
        timeoutMs: 30_000,
      }),
  );

  app.get(
    '/v1/audio/models',
    { schema: { tags: ['audio'], summary: 'Models audio.cpp has registered' } },
    async (req, reply) =>
      proxyToBackend(app.backends, req, reply, {
        backend: 'audiocpp',
        upstreamPath: '/v1/audio/models',
        method: 'GET',
        timeoutMs: 30_000,
      }),
  );

  // --- Voice references -----------------------------------------------------

  app.get(
    '/v1/audio/voice-refs',
    {
      schema: {
        tags: ['audio'],
        summary: 'List uploaded voice reference clips',
        response: { 200: z.object({ voiceRefs: z.array(z.unknown()) }) },
      },
    },
    async () => {
      const files = await listFiles(app.paths.uploadsDir);
      return {
        voiceRefs: files
          .filter((file) => ['.wav', '.mp3', '.flac', '.ogg'].includes(extname(file.name).toLowerCase()))
          .map((file) => ({
            name: file.name,
            size: file.size,
            modified: new Date(file.modified).toISOString(),
            url: `/v1/audio/voice-refs/${encodeURIComponent(file.name)}`,
          })),
      };
    },
  );

  app.post(
    '/v1/audio/voice-refs',
    {
      schema: {
        tags: ['audio'],
        summary: 'Upload a voice reference clip',
        consumes: ['multipart/form-data'],
        response: { 201: z.unknown() },
      },
    },
    async (req, reply) => {
      // The no-op parser above means this scope has to read the stream itself.
      const chunks: Buffer[] = [];
      for await (const chunk of req.raw) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      if (body.length === 0) throw errors.validation('Expected an audio file body');

      const name = uniqueOutputName('wav', 'voice');
      await writeFile(safeResolve(app.paths.uploadsDir, name), body);

      return reply.code(201).send({
        name,
        size: body.length,
        url: `/v1/audio/voice-refs/${encodeURIComponent(name)}`,
      });
    },
  );

  app.get(
    '/v1/audio/voice-refs/:name',
    {
      schema: {
        tags: ['audio'],
        summary: 'Fetch a voice reference clip',
        params: z.object({ name: z.string() }),
      },
    },
    async (req, reply) => {
      const path = safeResolve(app.paths.uploadsDir, req.params.name);
      try {
        await stat(path);
      } catch {
        throw errors.audioVoiceRefNotFound(req.params.name);
      }
      return reply.header('Content-Type', 'audio/wav').send(createReadStream(path));
    },
  );

  app.delete(
    '/v1/audio/voice-refs/:name',
    {
      schema: {
        tags: ['audio'],
        summary: 'Delete a voice reference clip',
        params: z.object({ name: z.string() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await unlink(safeResolve(app.paths.uploadsDir, req.params.name)).catch(() => {});
      return reply.code(204).send(null);
    },
  );
}
