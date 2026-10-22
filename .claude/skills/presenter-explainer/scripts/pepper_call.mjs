// Call one Pepper MCP tool through the repo's stdio bridge, for when the session's
// `pepper` MCP server failed to connect at start (it doesn't retry) but the
// instance is up. The bridge reads the URL and token from the .env files itself,
// so neither appears on the command line.
//   node pepper_call.mjs TOOL '{"arg": 1}'   -> prints the result's text parts (images dropped)
//   node pepper_call.mjs --list              -> the tools and their input schemas
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const [tool, args = '{}'] = process.argv.slice(2);
const p = spawn('node', ['.claude/pepper-mcp.mjs'], { cwd: repo, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id !== 2) continue;
    if (m.error) {
      console.error(JSON.stringify(m.error));
      process.exitCode = 1;
    } else if (tool === '--list') {
      for (const t of m.result.tools) console.log(JSON.stringify({ name: t.name, input: t.inputSchema.properties }));
    } else {
      for (const c of m.result?.content ?? []) if (c.type === 'text') console.log(c.text);
      if (m.result?.isError) process.exitCode = 1;
    }
    p.stdin.end();
  }
});
const send = (o) => p.stdin.write(`${JSON.stringify(o)}\n`);
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pepper_call', version: '1' } } });
send(tool === '--list'
  ? { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
  : { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: JSON.parse(args) } });
