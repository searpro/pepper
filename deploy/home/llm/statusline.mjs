#!/usr/bin/env node
// Claude Code status line for a session on the box's model (claude-box.sh installs it for that session only):
// who holds the GPU, so a turn that sits behind renders reads as waiting rather than hung.
//   PEPPER_URL, PEPPER_API_TOKEN   from claude-box.sh
const base = process.env.PEPPER_URL;
const since = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
try {
  const response = await fetch(`${base}/v1/llm/gpu`, {
    headers: { authorization: `Bearer ${process.env.PEPPER_API_TOKEN ?? ''}`, 'user-agent': 'pepper-statusline/1.0' },
    signal: AbortSignal.timeout(3000),
  });
  const gpu = await response.json();
  const job = gpu.holders.find((h) => h.lane === 'job');
  const queued = gpu.waiting.filter((w) => w.lane === 'job').length;
  const turn = gpu.waiting.find((w) => w.lane === 'llm');
  if (job) {
    let line = `GPU: rendering ${job.label} (${since(job.since)})`;
    if (queued) line += `, ${queued} more queued`;
    if (turn) line += ` · your turn waits ${since(turn.since)}`;
    console.log(line);
  } else if (gpu.holders.some((h) => h.lane === 'llm')) {
    console.log(`GPU: model${queued ? ` · ${queued} render${queued === 1 ? '' : 's'} next` : ''}`);
  } else {
    console.log(`GPU: idle · llama.cpp ${gpu.llamacpp}`);
  }
} catch {
  console.log('GPU: Pepper Pro unreachable');
}
