import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerPepperTools } from '../mcp/tools.js';

/**
 * Model Context Protocol endpoint, so Claude (claude.ai connectors, Claude
 * Code, Claude Desktop) can drive Pepper directly.
 *
 * Stateless Streamable HTTP with plain JSON responses: every POST builds a
 * fresh server and transport, answers, and is done. There is no session to
 * lose when a Kaggle kernel restarts, nothing held open through the tunnel,
 * and no SSE — which also means no server-initiated messages, which none of
 * the tools need, since long work is submit-then-poll (see mcp/tools.ts).
 *
 * Mounted twice: `/mcp` for clients that send the token as a header, and
 * `/mcp/<token>` for a claude.ai connector that cannot. The token itself is
 * checked by the global auth hook (src/auth.ts), not here.
 */
export async function mcpRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify;

  async function handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const server = new McpServer({ name: 'pepper', version: app.appVersion });
    registerPepperTools(server, { app, baseUrl: baseUrl(request) });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    // The transport writes the raw response itself.
    reply.hijack();
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  }

  /** Stateless servers have no stream to open or session to end. */
  async function notAllowed(_request: FastifyRequest, reply: FastifyReply) {
    return reply
      .code(405)
      .header('Allow', 'POST')
      .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  }

  const schema = {
    tags: ['mcp'],
    summary: 'Model Context Protocol endpoint (Streamable HTTP, stateless)',
  };

  for (const url of ['/mcp', '/mcp/:token']) {
    app.post(url, { schema }, handle);
    app.get(url, { schema: { ...schema, hide: true } }, notAllowed);
    app.delete(url, { schema: { ...schema, hide: true } }, notAllowed);
  }
}

/** The origin the caller used, so links in tool results open from wherever Claude is. */
function baseUrl(request: FastifyRequest): string {
  const header = (name: string) => {
    const value = request.headers[name];
    return (Array.isArray(value) ? value[0] : value)?.split(',')[0].trim();
  };
  const proto = header('x-forwarded-proto') ?? request.protocol;
  const host = header('x-forwarded-host') ?? header('host') ?? `localhost:${request.server.config.port}`;
  return `${proto}://${host}`;
}
