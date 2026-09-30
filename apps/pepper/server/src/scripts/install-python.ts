/**
 * Build-time install of the Python runner environment, for the Docker image:
 *
 *     PYTHON_DIR=/opt/pepper-python node server/dist/scripts/install-python.js
 *
 * Runs the same installer the server uses at first use — the standalone
 * interpreter, the venv, `python/requirements.txt` and the SeedVR2 checkout —
 * so the receipts it leaves are the ones the server looks for, and a pod
 * finds everything already in place. Doing this at first use instead meant
 * twenty-plus minutes of pip writing to a network volume on RunPod.
 */
import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import { PythonInstaller } from '../backends/python.js';
import { SEEDVR2_PACKAGE } from '../backends/python-packages.js';

const dir = process.env.PYTHON_DIR?.trim();
if (!dir) {
  console.error('PYTHON_DIR is required');
  process.exit(1);
}

const log = pino({ level: 'info' }) as unknown as FastifyBaseLogger;
const installer = new PythonInstaller(dir, log);
const runtime = (await installer.installed()) ?? (await installer.installRuntime());
await installer.ensureRunnerEnvironment(runtime);
await installer.installPackage(runtime, { source: SEEDVR2_PACKAGE }, undefined, { requirements: false });
log.info({ dir, python: runtime.pythonPath }, 'Python runner environment installed');
