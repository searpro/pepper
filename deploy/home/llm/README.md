# Claude Code on the home box's own model

`claude-box.sh` starts Claude Code on the agent model that Pepper Pro serves
on the home box (Qwen3.6-35B-A3B Q4_K_M with vision, 96k context), instead
of Anthropic's models. The renders and the model share the one 16 GB card,
taking turns; `docs/PEPPER-PRO.md` §14 has the design and the measurements.

## Once: the box

Pepper Pro must be up with an agent model set. Put these in
`deploy/home/.env` (or export them), so every `up` writes them into the
stack's `.env`:

```
LLM_AGENT_MODEL=Qwen3.6-35B-A3B-UD-Q4_K_M.gguf
LLM_AGENT_ARGS=--temp 0.6 --top-k 20 --top-p 0.95
```

The model file and `mmproj-Qwen3.6-35B-A3B.gguf` sit in Pro's `models/llm`.
Then `uv run deploy/home/launch.py up --product pro`. The script checks
`/v1/llm/gpu` before starting and says so if the box is not answering.

## Starting a session

From the folder you want to work in (for a video, the project folder, or
this checkout to use its skills and agents):

```bash
sh ~/projects/pepper/deploy/home/llm/claude-box.sh
```

Arguments after it go to `claude` (`-p`, `--resume`, …). It reads the
hostname and token from the launchers' `.env` files, gives the session the
`pepper` MCP bridge and the box's SearXNG for web search (WebSearch is an
Anthropic tool), and passes the address and token with `--settings`, which
outranks any project's `.claude/settings*.json`. Claude Code with
Anthropic's models, started the usual way, is untouched.

## What is different from Claude Code on Anthropic's models

- **Turns wait for renders.** Renders go first: while any render is queued
  or running, your next turn waits (the status line says for what and how
  long), then the model reloads (~12 s) and reads the conversation again
  (~1,600 tokens/s; 40k tokens is about 25 s). A turn with no render in
  between answers in seconds.
- **So queue in batches.** Ask for every still, voice line or take of a
  step in one turn, then let them run: each turn spent polling between
  renders costs a reload. Job results tell the model the same (a note on
  how long its last turn waited and how much of the queue is left).
- **One request at a time.** The model has one slot; parallel subagents
  queue behind each other rather than run together.
- **No claude.ai connectors.** Notion, Gmail and the other connectors come
  with a claude.ai sign-in, which this session does not use. Only the MCP
  servers in `--mcp-config` (pepper, searxng) and the project's
  `.mcp.json` are there.
- **A smaller model.** It follows the skills, but judge its creative calls
  (script, looks, directions) more closely than Opus's.

## Making an explainer video

The `presenter-explainer` skill runs as it does on Anthropic's models,
with these changes:

1. **Start in this checkout** so the skill and its agents load, and say
   which project folder the video lives in (`~/projects/<topic>-explainer`).
   Its agents ask for Sonnet; every model name maps to the box's model.
2. **Research (steps 0–1).** `explainer-researcher` has no MCP tools and
   WebSearch is off, so tell it to search through SearXNG with `curl`:
   `curl -s "http://lk-gpu-server:8888/search?q=<query>&format=json"`.
   WebFetch works (it fetches from the laptop).
3. **Script and storyboard (1–2).** Ask for all start frames in one turn;
   they render while you wait for the next answer. `take-reviewer` reads
   contact sheets with the model's vision.
4. **Voice, takes, masters (3–5).** Queue the whole set of lines, then the
   whole set of H3 takes, then the masters, each in one turn. H3 takes are
   minutes each, so a batch is a good time to step away.
5. **Finish and compose (6–6c)** run on the laptop (ffmpeg) and need no GPU
   turns; they go quickly.
6. **Publishing kit (7).** Notion is not reachable from this session.
   Have it write `publish-kit.md` in the project folder, and post the kit
   to Notion from a regular Claude Code session (`publishing-kit-writer`).

## Files

| File | What |
| --- | --- |
| `claude-box.sh` | The launcher |
| `statusline.mjs` | The status line: who holds the GPU, and how long a turn would wait |
| `searxng_mcp.mjs` | Web search through the box's SearXNG |
