import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errors } from './errors.js';

/**
 * API token authentication.
 *
 * Pepper has one user, so there are no accounts: a single shared secret
 * (`PEPPER_API_TOKEN`) guards everything that can spend GPU time, download
 * weights or read outputs. It is accepted three ways, because the three kinds
 * of client can each only do one of them:
 *
 * - `Authorization: Bearer <token>` — Claude Code, scripts, curl.
 * - A session cookie — the web app. `<img>`, `<video>`, EventSource and
 *   WebSocket requests cannot carry a header, but the browser attaches a
 *   same-origin cookie to all of them.
 * - `/mcp/<token>` — a claude.ai custom connector, which (at the time of
 *   writing) cannot always be configured with a request header. The path
 *   is censored from logs by `redactTokenPath`.
 *
 * A fourth form covers one narrow case: a signed, expiring link to a single
 * output file (`signMediaUrl`). The media view Claude renders in a chat runs
 * in a sandboxed iframe on the host's origin, which can send neither a header
 * nor our cookie, yet has to load the image, video or audio it shows.
 *
 * There is deliberately no bypass for requests from localhost: cloudflared
 * connects to Pepper from 127.0.0.1, so a loopback exemption would exempt all
 * tunnel traffic, i.e. the whole internet.
 */

export const SESSION_COOKIE = 'pepper_session';
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

/**
 * `/mcp/<token>`. The token is everything after `/mcp/`, slashes included:
 * a base64 token can contain `/`, and a connector URL pasted with the token
 * unencoded splits it into several path segments.
 */
const MCP_TOKEN_PATH = /^\/mcp\/([^?#]+)/;

/**
 * The cookie holds a value derived from the token rather than the token
 * itself, so a cookie lifted from a browser cannot be replayed as a Bearer
 * token against the MCP endpoint or a script. Rotating the token still
 * invalidates every session, since the derivation depends on it.
 */
export function sessionValue(token: string): string {
  return createHmac('sha256', token).update('pepper-session-v1').digest('base64url');
}

/**
 * Constant-time comparison. Both sides are hashed first so that
 * `timingSafeEqual` sees equal-length inputs and the token's length does not
 * leak through an early return.
 */
export function secretsMatch(expected: string, candidate: string | undefined): boolean {
  if (!candidate) return false;
  const a = createHmac('sha256', 'pepper-compare').update(expected).digest();
  const b = createHmac('sha256', 'pepper-compare').update(candidate).digest();
  return timingSafeEqual(a, b);
}

/** Parse one cookie out of a Cookie header, without pulling in @fastify/cookie for it. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Which requests need a token. Everything that is not the API is the SPA's
 * shell and its static assets, which must load without a token so the
 * sign-in screen can render; they contain no data.
 */
export function requiresAuth(url: string): boolean {
  const path = url.split('?')[0];
  if (path === '/v1/session') return false;
  return (
    path.startsWith('/v1/') ||
    path === '/v1' ||
    path === '/mcp' ||
    path.startsWith('/mcp/') ||
    path === '/docs' ||
    path.startsWith('/docs/')
  );
}

export function isAuthenticated(request: FastifyRequest, token: string): boolean {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ') && secretsMatch(token, header.slice(7).trim())) return true;

  const cookie = readCookie(request.headers.cookie, SESSION_COOKIE);
  if (cookie && secretsMatch(sessionValue(token), cookie)) return true;

  const mcp = MCP_TOKEN_PATH.exec(request.url);
  if (mcp && secretsMatch(token, safeDecode(mcp[1]))) return true;

  return isSignedMediaRequest(request.method, request.url, token);
}

/** A malformed escape is simply not the token. */
function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** One output file, nothing beneath it: not `/info`, not the listing. */
const OUTPUT_PATH = /^\/v1\/outputs\/([^/?#]+)$/;
/** Long enough to reopen a conversation later; outputs rarely outlive their pod anyway. */
export const MEDIA_LINK_TTL_S = 7 * 24 * 60 * 60;

function mediaSignature(token: string, name: string, expires: number): string {
  return createHmac('sha256', token).update(`pepper-media-v1\n${name}\n${expires}`).digest('base64url');
}

/**
 * A link to one output that carries its own proof: `?exp=<unix seconds>&sig=…`.
 * The signature covers the file name and the expiry, so it opens that file
 * until then and nothing else, and rotating the token revokes every link.
 * Without a token the server is open and the plain path is returned.
 */
export function signMediaUrl(
  token: string | undefined,
  name: string,
  now: number = Date.now(),
  ttlSeconds: number = MEDIA_LINK_TTL_S,
): string {
  const path = `/v1/outputs/${encodeURIComponent(name)}`;
  if (!token) return path;
  const expires = Math.floor(now / 1000) + ttlSeconds;
  return `${path}?exp=${expires}&sig=${mediaSignature(token, name, expires)}`;
}

/** Whether `url` is a read of one output with a valid, unexpired signature. */
export function isSignedMediaRequest(method: string, url: string, token: string, now: number = Date.now()): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const [path, search = ''] = url.split('?');
  const match = OUTPUT_PATH.exec(path);
  if (!match) return false;
  const params = new URLSearchParams(search);
  const expires = Number(params.get('exp'));
  const signature = params.get('sig');
  if (!signature || !Number.isInteger(expires) || expires * 1000 < now) return false;
  let name: string;
  try {
    name = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  return secretsMatch(mediaSignature(token, name, expires), signature);
}

/** Log-safe form of a URL: the `/mcp/<token>` segment is replaced. */
export function redactTokenPath(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(MCP_TOKEN_PATH, '/mcp/[redacted]') : value;
}

/** Whether the browser reached us over HTTPS, directly or through the tunnel. */
function isHttps(request: FastifyRequest): boolean {
  const forwarded = request.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return request.protocol === 'https' || proto?.split(',')[0].trim() === 'https';
}

function sessionCookie(request: FastifyRequest, value: string, maxAge: number): string {
  // Secure only over HTTPS: a Secure cookie set on http://localhost would be
  // silently dropped and leave local development unable to sign in.
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    ...(isHttps(request) ? ['Secure'] : []),
  ].join('; ');
}

/**
 * Install the auth hook. A no-op when no token is configured, so an open
 * server behaves exactly as it did before auth existed. Must be called on the
 * root instance before any plugin or route is registered: a hook only applies
 * to routes added after it, and `/docs` comes from a plugin.
 */
export function registerAuthHook(app: FastifyInstance, token: string | undefined): void {
  if (!token) return;
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requiresAuth(request.url) || isAuthenticated(request, token)) return;
    // Sent directly rather than thrown: the reply should not depend on which
    // route, or which plugin's error handler, would have matched.
    const error = errors.unauthorized();
    return reply.code(error.statusCode).send(error.toResponse());
  });
}

/** Sign-in routes for the web app. */
export async function authRoutes(app: FastifyInstance, options: { apiToken?: string }): Promise<void> {
  const token = options.apiToken;

  app.get(
    '/v1/session',
    {
      schema: {
        tags: ['system'],
        summary: 'Whether this server requires a token, and whether the caller has one',
      },
    },
    async (request) => ({
      required: Boolean(token),
      authenticated: !token || isAuthenticated(request, token),
    }),
  );

  app.post<{ Body: { token?: unknown } }>(
    '/v1/session',
    {
      schema: {
        tags: ['system'],
        summary: 'Sign the web app in: exchange the API token for a session cookie',
      },
    },
    async (request, reply) => {
      if (!token) return reply.code(204).send();
      const candidate = typeof request.body?.token === 'string' ? request.body.token.trim() : undefined;
      if (!secretsMatch(token, candidate)) throw errors.unauthorized();
      reply.header('Set-Cookie', sessionCookie(request, sessionValue(token), SESSION_MAX_AGE_S));
      return reply.code(204).send();
    },
  );

  app.delete(
    '/v1/session',
    { schema: { tags: ['system'], summary: 'Sign the web app out' } },
    async (request, reply) => {
      reply.header('Set-Cookie', sessionCookie(request, '', 0));
      return reply.code(204).send();
    },
  );
}
