import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { safeResolve, type Paths } from '../paths.js';
import type { ModelManager } from '../models/manager.js';

/**
 * Generates audio.cpp's model registry (requirement 2).
 *
 * This is the one place the audio backend genuinely differs from llama.cpp:
 * llama-server discovers GGUF files from `--models-dir`, while audiocpp_server
 * has no directory-scan mode at all and loads an explicit JSON registry via
 * `--config`. So the registry is generated from the installed bundles before
 * every spawn, which means a freshly downloaded model becomes servable through
 * the same restart the download already triggers.
 *
 * A bundle is registered only if its manifest declares `family` and `task` —
 * audio.cpp needs both to know which spec to load, and neither is derivable
 * from the files on disk. An undeclared bundle is skipped with a warning
 * rather than failing the whole registry, since one hand-copied directory
 * should not take the audio backend down.
 */

export interface AudioServerConfig {
  models: AudioModelEntry[];
}

interface AudioModelEntry {
  id: string;
  family: string;
  task: string;
  mode?: string;
  /** Absolute path to the weights file. */
  path: string;
  /** Absolute paths to auxiliary files (vocoder, tokenizer, speaker embeddings). */
  aux?: string[];
  /**
   * Named voice presets, which `GET /v1/audio/voices` lists and a request
   * selects with `"voice": "<name>"`. Each value is a preset object audio.cpp
   * understands — `{ "voice_id": "alba" }` for a packaged speaker, or
   * `{ "voice_ref": "/abs/path.wav" }` for a stored reference clip.
   */
  voice_presets?: Record<string, Record<string, unknown>>;
  /** Preset applied when a request names no voice. */
  default_voice_preset?: string;
}

export interface WriteConfigResult {
  path: string;
  modelIds: string[];
}

export const AUDIO_CONFIG_FILE = 'audio-server-config.generated.json';

export async function writeAudioServerConfig(
  paths: Paths,
  models: ModelManager,
  log: FastifyBaseLogger,
): Promise<WriteConfigResult> {
  const bundles = await models.list('audio');
  const entries: AudioModelEntry[] = [];

  for (const bundle of bundles) {
    const { manifest } = bundle;
    if (!manifest?.family || !manifest?.task) {
      log.warn(
        { bundle: bundle.id },
        'audio bundle skipped: model.json must declare "family" and "task"',
      );
      continue;
    }

    const weights = bundle.components.filter((c) => c.slot === 'weights');
    if (weights.length === 0) {
      log.warn({ bundle: bundle.id }, 'audio bundle skipped: no weights file');
      continue;
    }

    // The largest weights file is the model; smaller ones alongside it are
    // companions the family may or may not use, and are passed as aux.
    const primary = [...weights].sort((a, b) => b.size - a.size)[0];
    const bundlePath = join(paths.modelsDir, 'audio', bundle.id);

    // A preset's `voice_ref` names an uploaded clip, the same way a request
    // does. audio.cpp opens whatever path it is given, so the name is resolved
    // against the uploads directory here rather than forwarded verbatim.
    const presets = manifest.voicePresets
      ? Object.fromEntries(
          Object.entries(manifest.voicePresets).map(([name, preset]) => [
            name,
            typeof preset.voice_ref === 'string'
              ? { ...preset, voice_ref: safeResolve(paths.uploadsDir, preset.voice_ref) }
              : preset,
          ]),
        )
      : undefined;

    if (manifest.defaultVoicePreset && !presets?.[manifest.defaultVoicePreset]) {
      log.warn(
        { bundle: bundle.id, preset: manifest.defaultVoicePreset },
        'defaultVoicePreset names a preset the bundle does not define',
      );
    }

    entries.push({
      id: bundle.id,
      family: manifest.family,
      task: manifest.task,
      mode: manifest.audio_mode,
      path: join(bundlePath, 'weights', primary.name),
      ...(presets ? { voice_presets: presets } : {}),
      ...(manifest.defaultVoicePreset && presets?.[manifest.defaultVoicePreset]
        ? { default_voice_preset: manifest.defaultVoicePreset }
        : {}),
      aux: [
        ...weights.filter((w) => w.name !== primary.name).map((w) => join(bundlePath, 'weights', w.name)),
        ...bundle.components.filter((c) => c.slot === 'aux').map((c) => join(bundlePath, 'aux', c.name)),
      ],
    });
  }

  const path = join(paths.cacheDir, AUDIO_CONFIG_FILE);
  await writeFile(path, JSON.stringify({ models: entries }, null, 2), 'utf8');

  return { path, modelIds: entries.map((entry) => entry.id) };
}
