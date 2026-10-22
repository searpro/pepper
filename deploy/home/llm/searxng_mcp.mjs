#!/usr/bin/env node
// A small stdio MCP server over the SearXNG instance on the box: `search` and `fetch_page`.
// Claude Code's own WebSearch is an Anthropic server tool, so a model behind llama.cpp can't use it;
// this gives it the same capability. Results are trimmed hard because a local model has 64-96k of context.
//
//   SEARXNG_URL=http://lk-gpu-server:8888 node searxng_mcp.mjs
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE = process.env.SEARXNG_URL ?? 'http://lk-gpu-server:8888';
const PAGE_CHARS = Number(process.env.FETCH_MAX_CHARS ?? 12000);

const TOOLS = [
  {
    name: 'search',
    description:
      'Web search (SearXNG: Google, Bing, Brave, Wikipedia and others). Returns up to `limit` results ' +
      'with title, url, date and snippet. Read a result in full with fetch_page.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms' },
        time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Only recent results' },
        category: { type: 'string', enum: ['general', 'news', 'images', 'science'], default: 'general' },
        limit: { type: 'integer', minimum: 1, maximum: 15, default: 8 },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_page',
    description: `A web page as plain text (scripts, styles and markup removed), at most ${PAGE_CHARS} characters from \`offset\`.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
      required: ['url'],
    },
  },
];

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
const fail = (message) => ({ ...text(message), isError: true });

async function search({ query, time_range, category = 'general', limit = 8 }) {
  const params = new URLSearchParams({ q: query, format: 'json', categories: category });
  if (time_range) params.set('time_range', time_range);
  const res = await fetch(`${BASE}/search?${params}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return fail(`SearXNG returned ${res.status}`);
  const data = await res.json();
  const results = (data.results ?? []).slice(0, limit).map((r) => ({
    title: r.title,
    url: r.url,
    date: r.publishedDate ?? undefined,
    snippet: (r.content ?? '').slice(0, 300),
    ...(category === 'images' ? { image: r.img_src } : {}),
  }));
  return text({ query, results });
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

async function fetchPage({ url, offset = 0 }) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 Safari/605.1.15' },
    signal: AbortSignal.timeout(30_000),
    redirect: 'follow',
  });
  if (!res.ok) return fail(`${url} returned ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!/text|html|json|xml/.test(type)) return fail(`${url} is ${type}, not a page`);
  const body = htmlToText(await res.text());
  const chunk = body.slice(offset, offset + PAGE_CHARS);
  const more = offset + PAGE_CHARS < body.length ? `\n\n[${body.length - offset - PAGE_CHARS} more characters: fetch_page with offset ${offset + PAGE_CHARS}]` : '';
  return text(`${url}\n\n${chunk}${more}`);
}

const server = new Server({ name: 'searxng', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === 'search') return await search(args);
    if (name === 'fetch_page') return await fetchPage(args);
    return fail(`Unknown tool ${name}`);
  } catch (err) {
    return fail(String(err?.message ?? err));
  }
});
await server.connect(new StdioServerTransport());
