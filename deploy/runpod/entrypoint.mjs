#!/usr/bin/env node
/**
 * Container entrypoint: runs Pepper, the named Cloudflare tunnel, and an
 * optional idle shutdown. Written for RunPod, but nothing here needs it
 * except the shutdown itself.
 *
 * Environment:
 *   PEPPER_API_TOKEN      required, unless PEPPER_ALLOW_OPEN=true
 *   PEPPER_TUNNEL_TOKEN   run `cloudflared tunnel run` with this token
 *   PEPPER_HOSTNAME       the tunnel's hostname, for the log line only
 *   PEPPER_IDLE_MINUTES   terminate the pod after this long idle (0/unset: never)
 *   RUNPOD_POD_ID, RUNPOD_API_KEY   set by RunPod itself; used to terminate
 *
 * Plain Node with no dependencies, so it runs from the image as copied.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PORT = process.env.PORT || '3000';
const log = (msg) => console.log(`[entrypoint] ${msg}`);

/**
 * A RunPod secret that does not exist is not an error at boot: the variable
 * simply keeps its literal `{{ RUNPOD_SECRET_name }}` text. Treat that as
 * unset, or Pepper would start with the template as its API token.
 */
function env(name) {
  const value = process.env[name]?.trim();
  if (!value || /\{\{\s*RUNPOD_SECRET_/.test(value)) return undefined;
  return value;
}

const apiToken = env('PEPPER_API_TOKEN');
const tunnelToken = env('PEPPER_TUNNEL_TOKEN');
const idleMinutes = Number(env('PEPPER_IDLE_MINUTES') ?? 0);

if (!apiToken && env('PEPPER_ALLOW_OPEN') !== 'true') {
  log('PEPPER_API_TOKEN is not set (or its RunPod secret does not exist). Refusing to serve an open');
  log('Pepper on a public address; set the token, or PEPPER_ALLOW_OPEN=true to override.');
  process.exit(1);
}

// The image carries its own Python environment (PYTHON_DIR). One installed
// onto the data volume by an earlier image is never used again, and at
// several GB it is worth reclaiming on a volume billed by the gigabyte.
const stalePython = join(process.env.DATA_DIR || '/data', 'bin', 'python');
if (env('PYTHON_DIR') && resolve(env('PYTHON_DIR')) !== resolve(stalePython) && existsSync(stalePython)) {
  // In the background: thousands of small files on a network volume take
  // minutes to delete, and nothing here depends on them being gone.
  log(`removing the unused Python environment at ${stalePython} (in the background)`);
  spawn('rm', ['-rf', stalePython], { stdio: 'ignore', detached: true }).unref();
}

const children = new Set();
let stopping = false;

function run(name, command, args, childEnv) {
  const child = spawn(command, args, { env: childEnv, stdio: 'inherit' });
  children.add(child);
  child.on('exit', () => children.delete(child));
  child.on('error', (err) => log(`${name} failed to start: ${err.message}`));
  return child;
}

// --- Pepper -------------------------------------------------------------------

// Pepper gets its own token but never the tunnel's.
const pepperEnv = { ...process.env, ...(apiToken ? { PEPPER_API_TOKEN: apiToken } : {}) };
delete pepperEnv.PEPPER_TUNNEL_TOKEN;
delete pepperEnv.RUNPOD_API_KEY;
if (!apiToken) delete pepperEnv.PEPPER_API_TOKEN;

const pepper = run('pepper', process.execPath, ['apps/pepper/server/dist/index.js'], pepperEnv);
pepper.on('exit', (code, signal) => {
  if (stopping) return;
  log(`pepper exited (${signal ?? code}); stopping the container`);
  shutdown(typeof code === 'number' ? code : 1);
});

// --- Tunnel -------------------------------------------------------------------

function startTunnel(attempt = 0) {
  // The token goes through the environment, not argv, so it stays out of
  // process listings and RunPod's logs.
  const tunnel = run(
    'cloudflared',
    'cloudflared',
    ['tunnel', '--no-autoupdate', 'run', '--url', `http://127.0.0.1:${PORT}`],
    { ...process.env, TUNNEL_TOKEN: tunnelToken, PEPPER_API_TOKEN: '', RUNPOD_API_KEY: '' },
  );
  const started = Date.now();
  tunnel.on('exit', (code) => {
    if (stopping) return;
    // Back off only when it keeps dying straight away (a bad token, no network).
    const next = Date.now() - started > 60_000 ? 0 : attempt + 1;
    const delay = Math.min(60, 2 ** next) * 1000;
    log(`cloudflared exited (${code}); restarting in ${delay / 1000}s`);
    setTimeout(() => startTunnel(next), delay);
  });
}

if (tunnelToken) {
  log(`starting the named tunnel${env('PEPPER_HOSTNAME') ? ` for https://${env('PEPPER_HOSTNAME')}` : ''}`);
  startTunnel();
} else {
  log('no PEPPER_TUNNEL_TOKEN; reachable only through the host (on RunPod, its HTTP proxy on port 3000)');
}

// --- Idle shutdown ------------------------------------------------------------

async function idleSeconds() {
  const response = await fetch(`http://127.0.0.1:${PORT}/v1/system/status`, {
    headers: apiToken ? { authorization: `Bearer ${apiToken}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const status = await response.json();
  return status.activity?.idleSeconds;
}

/**
 * Terminate, not stop: RunPod cannot stop a pod with a network volume
 * attached, and everything worth keeping is on that volume anyway. Tries the
 * v2 REST API, then the GraphQL API the pod-scoped key was made for.
 */
async function terminatePod() {
  const podId = env('RUNPOD_POD_ID');
  const key = env('RUNPOD_API_KEY');
  if (!podId || !key) {
    log('idle, but RUNPOD_POD_ID / RUNPOD_API_KEY are not set; cannot terminate this host');
    return false;
  }
  try {
    const rest = await fetch(`https://api.runpod.io/v2/pods/${podId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (rest.ok) return true;
    log(`REST terminate returned ${rest.status}; trying GraphQL`);
  } catch (err) {
    log(`REST terminate failed (${err.message}); trying GraphQL`);
  }
  try {
    const gql = await fetch(`https://api.runpod.io/graphql?api_key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `mutation { podTerminate(input: { podId: "${podId}" }) }` }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await gql.json().catch(() => ({}));
    if (gql.ok && !body.errors) return true;
    log(`GraphQL terminate failed: ${JSON.stringify(body.errors ?? gql.status)}`);
  } catch (err) {
    log(`GraphQL terminate failed (${err.message})`);
  }
  return false;
}

if (idleMinutes > 0) {
  log(`will terminate this pod after ${idleMinutes} idle minutes`);
  let warned = false;
  setInterval(async () => {
    let idle;
    try {
      idle = await idleSeconds();
    } catch {
      return; // still starting, or briefly busy; the next check decides
    }
    if (typeof idle !== 'number') return;
    const limit = idleMinutes * 60;
    if (idle >= limit - 300 && idle < limit && !warned) {
      log(`idle for ${Math.floor(idle / 60)} min; terminating in about ${Math.ceil((limit - idle) / 60)} min`);
      warned = true;
    }
    if (idle < limit - 300) warned = false;
    if (idle >= limit) {
      log(`idle for ${Math.floor(idle / 60)} min; terminating the pod`);
      if (await terminatePod()) shutdown(0);
    }
  }, 60_000).unref();
}

// --- Lifecycle ----------------------------------------------------------------

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 10_000).unref();
  const check = setInterval(() => {
    if (children.size === 0) {
      clearInterval(check);
      process.exit(code);
    }
  }, 200);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
