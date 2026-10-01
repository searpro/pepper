#!/usr/bin/env node
/**
 * stdio bridge to a Pepper instance's /mcp endpoint, for Claude Code.
 *
 * `.mcp.json` used to point straight at `${PEPPER_URL}/mcp` with the token in a
 * header. That only works where both variables are in the environment Claude
 * Code was started from, which the desktop app's is not (it does not read
 * `~/.zshrc`). This bridge reads the same git-ignored `.env` files the
 * launchers use instead, so there is one place the hostname and token live and
 * neither is committed.
 *
 *   URL    PEPPER_URL, else https://<PEPPER_HOSTNAME>, else http://localhost:3000
 *   Token  PEPPER_API_TOKEN (none is fine for an open local server)
 *
 * Each is taken from the process environment first, then `deploy/runpod/.env`,
 * `deploy/vastai/.env`, then `deploy/kaggle/.env` (of this checkout, then of the main one). Set PEPPER_URL=http://localhost:3000 to reach a
 * local `npm run dev` when the .env files name a hostname.
 *
 * Pepper's endpoint is stateless with plain JSON responses (one POST per
 * message, no sessions, no SSE), so the bridge is a loop: a line in, a POST,
 * a line out. Plain Node with no dependencies.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The .env files are git-ignored, so a worktree of this repo (the desktop app
 * makes one per session) has this script but not them. Fall back to the main
 * checkout, which is where the launchers are run from.
 */
function roots() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const main = dirname(common);
    return main === ROOT ? [ROOT] : [ROOT, main];
  } catch {
    return [ROOT];
  }
}
const ENV_FILES = ['deploy/runpod/.env', 'deploy/vastai/.env', 'deploy/kaggle/.env'];
// Tools wait at most 50 s; anything slower than this is a dead connection.
const TIMEOUT_MS = 90_000;

/** Same rules as the launchers: the first file to define a key wins, the environment beats both. */
function loadEnv() {
  const values = {};
  for (const file of roots().flatMap((root) => ENV_FILES.map((name) => join(root, name)))) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const at = line.indexOf('=');
      const key = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '');
      if (value && !(key in values)) values[key] = value;
    }
  }
  for (const key of ['PEPPER_URL', 'PEPPER_HOSTNAME', 'PEPPER_API_TOKEN']) {
    if (process.env[key]?.trim()) values[key] = process.env[key].trim();
  }
  return values;
}

const env = loadEnv();
const base = (
  env.PEPPER_URL || (env.PEPPER_HOSTNAME ? `https://${env.PEPPER_HOSTNAME}` : 'http://localhost:3000')
).replace(/\/+$/, '');
const token = env.PEPPER_API_TOKEN;

function explain(status) {
  if (status === 401) return `Pepper at ${base} rejected the API token (PEPPER_API_TOKEN).`;
  // Cloudflare answers for the hostname while no instance holds the tunnel.
  if (status === 502 || status === 530) return `No Pepper instance is running at ${base} (HTTP ${status}). Start one with deploy/runpod/launch.py up (or deploy/vastai/launch.py up).`;
  return `Pepper at ${base} answered HTTP ${status}.`;
}

async function forward(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // not JSON-RPC; nothing to answer
  }
  // Notifications (no id) get no reply, whatever happens to them.
  const expectsReply = !Array.isArray(message) && message.id !== undefined && message.method !== undefined;
  const fail = (text) => {
    if (expectsReply) send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: text } });
  };
  try {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        // Cloudflare's browser integrity check turns away clients with no user agent.
        'user-agent': 'pepper-mcp-bridge/1.0',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: line,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.text();
    if (!body) return response.ok ? undefined : fail(explain(response.status));
    let reply;
    try {
      reply = JSON.parse(body);
    } catch {
      return fail(explain(response.status));
    }
    // Pepper's own errors (401, 404) are JSON but not JSON-RPC.
    if (!Array.isArray(reply) && reply.jsonrpc !== '2.0') return fail(explain(response.status));
    send(reply);
  } catch (err) {
    fail(`Cannot reach Pepper at ${base}: ${err.cause?.code ?? err.message}. Is an instance running?`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const pending = new Set();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const task = forward(line).finally(() => pending.delete(task));
  pending.add(task);
});
lines.on('close', async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});
