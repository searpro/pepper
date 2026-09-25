import { randomBytes } from 'node:crypto';
import { copyFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { BackendManager } from '../backends/manager.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { characters, type CharacterRow } from '../db/schema.js';
import { AppError, errors } from '../errors.js';
import type { Job, JobManager } from '../jobs/manager.js';
import type { ModelManager } from '../models/manager.js';
import { safeResolve, type Paths } from '../paths.js';
import { uniqueOutputName } from '../util/files.js';
import type { TextService } from './text-gen.js';

/**
 * Character Studio: a cast of reusable characters, each with a reference
 * sheet, portraits, a fixed visual description and a voice.
 *
 * A character is made from a minimal prompt ("a grumpy dwarf blacksmith") in
 * two steps. An installed LLM expands the brief — under `DESIGNER_PROMPT`
 * below — into a precise visual description, a style and a voice direction.
 * That description is then dropped into `SHEET_TEMPLATE`, which fixes the
 * layout every sheet shares (face close-ups and full-body views, front and side, in a generic outfit) so the
 * result is a usable model sheet whatever the image model's own habits. With
 * no LLM installed the brief goes into the template as written.
 *
 * Sheet and portrait generations are ordinary image jobs tagged with
 * `character_id` / `character_role`; when one completes its output is copied
 * into uploads and attached, so the studio works the same whether or not the
 * browser that asked for it is still open.
 */

export type CharacterImageRole = 'sheet' | 'portrait' | 'reference';

export interface CharacterImage {
  /** Upload name. */
  name: string;
  role: CharacterImageRole;
  addedAt: string;
  /** The prompt that produced it, when generated. */
  prompt?: string;
}

export interface CharacterVoice {
  /** Audio bundle id. */
  model?: string;
  /** Voice direction for voice-design models. */
  instructions?: string;
  /** A built-in speaker or configured preset. */
  voice?: string;
  /** Upload/voice-ref name of a reference clip, for cloning models. */
  voice_ref?: string;
  /** Upload name of the last preview clip. */
  sample?: string;
  sample_text?: string;
}

export interface PendingGeneration {
  jobId: string;
  role: CharacterImageRole | 'voice_sample';
}

export interface Character {
  id: string;
  name: string;
  brief: string;
  style: string;
  appearance: string;
  personality: string;
  images: CharacterImage[];
  thumbnail: string | null;
  voice: CharacterVoice | null;
  pending: PendingGeneration[];
  createdAt: string;
  updatedAt: string;
}

export interface CharacterDesign {
  name: string;
  style: string;
  appearance: string;
  personality: string;
  voice: string;
  /** `llm` when a model expanded the brief, `template` when it went in as written. */
  source: 'llm' | 'template';
  model?: string;
}

/**
 * The system prompt behind "generate a character from a minimal prompt". Its
 * job is the part a brief never contains: concrete, drawable specifics that
 * stay the same every time the character is rendered.
 */
export const DESIGNER_PROMPT = `You are a senior character designer writing the brief for a character reference sheet.

The user gives a short idea for a character. Invent the concrete visual design an artist needs to draw that character identically across many images, and a voice direction for a text-to-speech voice designer.

Rules:
- "appearance": 50-90 words of purely physical, drawable facts in comma-separated descriptive phrases, present tense. Cover: apparent age, gender presentation, ethnicity or species, height and build, face shape and distinctive facial features, skin tone, eye colour, hair colour, length and style, facial hair, and one or two physical signature details (a scar, freckles, a birthmark) that make the character instantly recognisable. No clothing, accessories or props — the sheet dresses every character in the same plain generic outfit. No personality, backstory, poses, camera or lighting words. Never mention other characters.
- "style": the art style in 3-8 words. Keep the user's style if they gave one; otherwise choose the one that suits the idea (for example "photorealistic, cinematic", "anime cel-shaded", "stylised 3D animated film", "painterly fantasy illustration").
- "name": the character's name. Keep the user's if given; otherwise invent a fitting one.
- "personality": one sentence.
- "voice": 20-40 words directing a voice actor: gender, age, pitch, timbre, pace, accent, and emotional colour. No quotes or sample lines.
- Be specific (for example "short copper-red hair shaved at the sides", not "red hair"). Keep every detail consistent with the idea.

Reply with only a JSON object with the keys "name", "style", "appearance", "personality" and "voice".`;

/** Fixed sheet layout; `{name}`, `{appearance}` and `{style}` are filled per character. */
export const SHEET_TEMPLATE =
  'Character reference sheet for {name}. {appearance}. ' +
  'Wearing a plain generic outfit: a fitted plain grey crew-neck t-shirt, plain grey trousers and simple grey shoes, no accessories. ' +
  'Exactly four views of the same character side by side in one row, nothing else: a front close-up of the face, ' +
  'a side-profile close-up of the face, a full-body front view and a full-body side-profile view, ' +
  'standing straight with a neutral expression, head to feet fully visible in the full-body views. ' +
  'The face, hairstyle, body proportions and colours are exactly consistent in every view. ' +
  'No text, labels, callouts, colour swatches, props or extra poses. ' +
  'Plain light-grey studio background, soft even lighting, crisp clean detail, {style}.';

/** A single figure: what a start frame or an edit reference wants, unlike the sheet. */
const PORTRAIT_FRAMING =
  'A single figure only, facing the camera with a relaxed natural expression, centred, framed from the thighs up. ' +
  'Plain softly lit background. No extra heads or poses, no colour swatches, no text, labels or callouts. Sharp focus, {style}.';

export const PORTRAIT_TEMPLATE = 'Portrait of {name}: {appearance}. ' + PORTRAIT_FRAMING;

const PORTRAIT_FROM_SHEET =
  'Portrait of the character from the reference sheet in image 1 ({name}), with exactly the same face, hair, build, outfit and colours: {appearance}. ' +
  PORTRAIT_FRAMING;

function fill(template: string, character: Pick<Character, 'name' | 'appearance' | 'style' | 'brief'>) {
  const appearance = (character.appearance || character.brief).trim().replace(/\.+$/, '');
  return template
    .replaceAll('{name}', character.name.trim() || 'the character')
    .replaceAll('{appearance}', appearance)
    .replaceAll('{style}', character.style.trim() || 'highly detailed digital illustration');
}

export class CharacterService {
  constructor(
    private readonly db: Db,
    private readonly paths: Paths,
    private readonly jobs: JobManager,
    private readonly models: ModelManager,
    private readonly text: TextService,
    private readonly backends: BackendManager,
    private readonly config: Config,
    private readonly log: FastifyBaseLogger,
  ) {
    // Attach finished sheet/portrait/voice jobs to their character.
    jobs.on('completed', (job: Job) => void this.onJobSettled(job));
    jobs.on('failed', (job: Job) => void this.onJobSettled(job));
    this.reconcilePending();
  }

  list(): Character[] {
    return this.db
      .select()
      .from(characters)
      .orderBy(desc(characters.updatedAt))
      .all()
      .map(toCharacter);
  }

  get(id: string): Character {
    const row = this.db.select().from(characters).where(eq(characters.id, id)).get();
    if (!row) throw new AppError('CHARACTER_NOT_FOUND', `Character not found: ${id}`, 404);
    return toCharacter(row);
  }

  create(input: Partial<Pick<Character, 'name' | 'brief' | 'style' | 'appearance' | 'personality' | 'voice'>>): Character {
    const now = Date.now();
    const id = `chr_${randomBytes(6).toString('hex')}`;
    this.db
      .insert(characters)
      .values({
        id,
        name: input.name?.trim() || 'Untitled character',
        brief: input.brief ?? '',
        style: input.style ?? '',
        appearance: input.appearance ?? '',
        personality: input.personality ?? '',
        images: [],
        thumbnail: null,
        voice: input.voice ?? null,
        pending: [],
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.get(id);
  }

  update(
    id: string,
    patch: Partial<Pick<Character, 'name' | 'brief' | 'style' | 'appearance' | 'personality' | 'voice' | 'thumbnail'>>,
  ): Character {
    const current = this.get(id);
    if (patch.thumbnail && !current.images.some((image) => image.name === patch.thumbnail)) {
      throw errors.validation('The thumbnail must be one of the character’s images');
    }
    this.db
      .update(characters)
      .set({ ...definedOnly(patch), updatedAt: Date.now() })
      .where(eq(characters.id, id))
      .run();
    return this.get(id);
  }

  remove(id: string): void {
    this.get(id);
    this.db.delete(characters).where(eq(characters.id, id)).run();
  }

  // --- Prompts -----------------------------------------------------------------

  sheetPrompt(character: Character): string {
    return fill(SHEET_TEMPLATE, character);
  }

  portraitPrompt(character: Character, fromSheet: boolean): string {
    return fill(fromSheet ? PORTRAIT_FROM_SHEET : PORTRAIT_TEMPLATE, character);
  }

  /** Expand a minimal prompt into a full design with the LLM, or the template when none is usable. */
  async design(input: { brief: string; name?: string; style?: string; model?: string }): Promise<CharacterDesign> {
    const brief = input.brief.trim();
    if (!brief) throw errors.validation('Describe the character first');

    const fallback: CharacterDesign = {
      name: input.name?.trim() || '',
      style: input.style?.trim() || '',
      appearance: brief,
      personality: '',
      voice: '',
      source: 'template',
    };

    const model = input.model === 'none' ? null : await this.pickLlm(input.model);
    if (!model) return fallback;

    const user = [
      `Idea: ${brief}`,
      input.name?.trim() ? `Name: ${input.name.trim()}` : null,
      input.style?.trim() ? `Style: ${input.style.trim()}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const result = await this.text.generate({
        params: {
          model,
          messages: [
            { role: 'system', content: DESIGNER_PROMPT },
            { role: 'user', content: user },
          ],
          temperature: 0.8,
          max_tokens: 900,
          response_format: { type: 'json_object' },
          // Qwen3-family models think by default; a design brief does not need it
          // and the thinking would eat the token budget.
          chat_template_kwargs: { enable_thinking: false },
        },
      });
      const parsed = parseJsonObject(result.text);
      if (!parsed || typeof parsed.appearance !== 'string' || !parsed.appearance.trim()) {
        this.log.warn({ model, text: result.text.slice(0, 400) }, 'character design: unusable LLM reply');
        return fallback;
      }
      return {
        name: input.name?.trim() || String(parsed.name ?? '').trim(),
        style: input.style?.trim() || String(parsed.style ?? '').trim(),
        appearance: String(parsed.appearance).trim(),
        personality: String(parsed.personality ?? '').trim(),
        voice: String(parsed.voice ?? '').trim(),
        source: 'llm',
        model,
      };
    } catch (err) {
      this.log.warn({ err, model }, 'character design: LLM unavailable, using the template');
      return fallback;
    } finally {
      this.releaseLlm();
    }
  }

  /**
   * The next thing the studio does after a design is draw the sheet, and on a
   * unified-memory Mac the LLM left resident beside sd-cli pushes it into swap:
   * on the 24 GB M4 this was built on, a 1280×720 sheet went from ~5 minutes
   * to past sd-cli's 10-minute timeout. So with exclusive memory on, the LLM is
   * stopped once the design is in; it restarts on its next request.
   */
  private releaseLlm(): void {
    if (!this.config.pythonExclusiveMemory) return;
    const llm = this.backends.get('llamacpp');
    if (!llm || llm.status === 'stopped' || llm.status === 'failed') return;
    void llm.stop().catch((err) => this.log.warn({ err }, 'could not stop llamacpp after a design'));
  }

  private async pickLlm(requested?: string): Promise<string | null> {
    const ready = (await this.models.list('llm')).filter((bundle) => bundle.ready);
    if (requested) return ready.some((bundle) => bundle.id === requested) ? requested : null;
    return ready[0]?.id ?? null;
  }

  // --- Generation --------------------------------------------------------------

  /** Queue a sheet or portrait for a character. */
  generateImage(
    id: string,
    options: {
      role: 'sheet' | 'portrait';
      model: string;
      prompt?: string;
      width?: number;
      height?: number;
      steps?: number;
      cfg_scale?: number;
      seed?: number;
      /** Portraits only: condition on the character's sheet (edit models). */
      fromSheet?: boolean;
    },
  ): Job {
    const character = this.get(id);
    const sheet = character.images.find((image) => image.role === 'sheet');
    const fromSheet = options.role === 'portrait' && Boolean(options.fromSheet && sheet);
    const prompt =
      options.prompt?.trim() ||
      (options.role === 'sheet' ? this.sheetPrompt(character) : this.portraitPrompt(character, fromSheet));

    const params: Record<string, unknown> = definedOnly({
      prompt,
      model: options.model,
      // ~0.9 MP: a wide sheet has room for the turnaround, and stays inside
      // sd-cli's timeout on a laptop GPU (1024² already takes minutes on an M4).
      width: options.width ?? (options.role === 'sheet' ? 1280 : 768),
      height: options.height ?? (options.role === 'sheet' ? 720 : 960),
      steps: options.steps,
      cfg_scale: options.cfg_scale,
      seed: options.seed,
      ref_images: fromSheet ? [sheet!.name] : undefined,
      character_id: id,
      character_role: options.role,
    });
    const job = this.jobs.create('image', params);
    this.addPending(id, { jobId: job.id, role: options.role });
    return job;
  }

  /** Queue a voice preview in the character's voice. */
  previewVoice(id: string, text?: string): Job {
    const character = this.get(id);
    const voice = character.voice;
    if (!voice?.model) throw errors.validation('Pick a speech model for this character’s voice first');
    const input =
      text?.trim() ||
      `Hello, I'm ${character.name}. It's good to finally meet you — let me tell you a little about myself.`;
    const job = this.jobs.create('audio', {
      ...speechParams(voice),
      input,
      character_id: id,
      character_role: 'voice_sample',
    });
    this.addPending(id, { jobId: job.id, role: 'voice_sample' });
    this.update(id, { voice: { ...voice, sample_text: input } });
    return job;
  }

  /** Attach an existing output or upload to a character. */
  async addImage(
    id: string,
    input: { name: string; source: 'output' | 'upload'; role: CharacterImageRole; prompt?: string },
  ): Promise<Character> {
    const character = this.get(id);
    const upload = input.source === 'output' ? await this.copyOutput(input.name) : input.name;
    if (input.source === 'upload') {
      await stat(safeResolve(this.paths.uploadsDir, upload)).catch(() => {
        throw errors.inputNotFound(upload);
      });
    }
    const images = [
      ...character.images.filter((image) => image.name !== upload),
      { name: upload, role: input.role, addedAt: new Date().toISOString(), prompt: input.prompt },
    ];
    // The first portrait replaces a sheet as the thumbnail: a single face reads
    // at avatar size, a six-view sheet does not.
    const sheetThumb = character.images.find((image) => image.name === character.thumbnail)?.role === 'sheet';
    const firstPortrait =
      input.role === 'portrait' && !character.images.some((image) => image.role === 'portrait');
    const thumbnail = firstPortrait && sheetThumb ? upload : pickThumbnail(images, character.thumbnail);
    this.db
      .update(characters)
      .set({ images, thumbnail, updatedAt: Date.now() })
      .where(eq(characters.id, id))
      .run();
    return this.get(id);
  }

  removeImage(id: string, name: string): Character {
    const character = this.get(id);
    const images = character.images.filter((image) => image.name !== name);
    this.db
      .update(characters)
      .set({
        images,
        thumbnail: pickThumbnail(images, character.thumbnail === name ? null : character.thumbnail),
        updatedAt: Date.now(),
      })
      .where(eq(characters.id, id))
      .run();
    return this.get(id);
  }

  private async copyOutput(name: string): Promise<string> {
    const from = safeResolve(this.paths.outputDir, name);
    await stat(from).catch(() => {
      throw errors.outputNotFound(name);
    });
    const upload = uniqueOutputName((extname(name) || '.png').replace(/^\./, ''), 'character');
    await copyFile(from, safeResolve(this.paths.uploadsDir, upload));
    return upload;
  }

  private addPending(id: string, pending: PendingGeneration): void {
    const character = this.get(id);
    this.db
      .update(characters)
      .set({ pending: [...character.pending, pending], updatedAt: Date.now() })
      .where(eq(characters.id, id))
      .run();
  }

  private dropPending(id: string, jobId: string): void {
    const row = this.db.select().from(characters).where(eq(characters.id, id)).get();
    if (!row) return;
    const pending = (row.pending as PendingGeneration[]).filter((entry) => entry.jobId !== jobId);
    this.db.update(characters).set({ pending }).where(eq(characters.id, id)).run();
  }

  private async onJobSettled(job: Job): Promise<void> {
    const id = job.params.character_id as string | undefined;
    const role = job.params.character_role as PendingGeneration['role'] | undefined;
    if (!id || !role) return;
    try {
      const exists = this.db.select().from(characters).where(eq(characters.id, id)).get();
      if (!exists) return;
      this.dropPending(id, job.id);
      if (job.status !== 'completed') return;

      if (role === 'voice_sample') {
        const url = job.result?.audio_url as string | undefined;
        if (!url) return;
        const upload = await this.copyOutput(decodeURIComponent(url.split('/').pop()!));
        const character = this.get(id);
        this.update(id, { voice: { ...(character.voice ?? {}), sample: upload } });
        return;
      }

      const url = job.result?.image_url as string | undefined;
      if (!url) return;
      await this.addImage(id, {
        name: decodeURIComponent(url.split('/').pop()!),
        source: 'output',
        role,
        prompt: job.params.prompt as string | undefined,
      });
    } catch (err) {
      this.log.warn({ err, jobId: job.id, character: id }, 'could not attach a generation to its character');
    }
  }

  /** Jobs that settled while the server was down still get attached (or dropped). */
  private reconcilePending(): void {
    for (const row of this.db.select().from(characters).all()) {
      for (const entry of row.pending as PendingGeneration[]) {
        const job = this.jobs.get(entry.jobId);
        if (!job) this.dropPending(row.id, entry.jobId);
        else if (job.status !== 'queued' && job.status !== 'running') void this.onJobSettled(job);
      }
    }
  }
}

/** The fields of an audio job that a character's voice decides. */
export function speechParams(voice: CharacterVoice): Record<string, unknown> {
  return definedOnly({
    model: voice.model,
    voice: voice.voice || undefined,
    voice_ref: voice.voice_ref || undefined,
    instructions: voice.instructions?.trim() || undefined,
  });
}

function pickThumbnail(images: CharacterImage[], current: string | null): string | null {
  if (current && images.some((image) => image.name === current)) return current;
  return (
    images.find((image) => image.role === 'portrait')?.name ??
    images.find((image) => image.role === 'sheet')?.name ??
    images[0]?.name ??
    null
  );
}

function toCharacter(row: CharacterRow): Character {
  return {
    id: row.id,
    name: row.name,
    brief: row.brief,
    style: row.style,
    appearance: row.appearance,
    personality: row.personality,
    images: (row.images as CharacterImage[]) ?? [],
    thumbnail: row.thumbnail ?? null,
    voice: (row.voice as CharacterVoice | null) ?? null,
    pending: (row.pending as PendingGeneration[]) ?? [],
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/** The first JSON object in a model reply, tolerating code fences and stray thinking. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(cleaned.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function definedOnly<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
