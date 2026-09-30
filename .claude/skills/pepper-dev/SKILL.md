---
name: pepper-dev
description: Develop and verify a Pepper feature end to end — change the code, check it locally, then run it on a GPU (a RunPod pod, or a free Kaggle kernel) and exercise it through the Pepper MCP tools. Use when implementing or debugging anything in Pepper that needs real generation (sd-cli, llama.cpp, audio.cpp, Python runners) to prove it works.
---

# Pepper development loop

Real generation needs a GPU and the backend binaries, which a Mac usually
lacks. So a change is proven in two stages: locally (types, tests, UI), then
on a GPU through the `pepper` MCP server. Don't claim a generation change
works until stage 2 has run.

## Before anything: read what is already known

Check the memory notes (`MEMORY.md` index) and the **Gotchas** in
`docs/ARCHITECTURE.md` for the model or backend involved *before* diagnosing a
failure. Several hours have gone into re-deriving findings that were already
written down (the Wan 2.2 two-expert LoRA crash, system RAM being the limit
rather than VRAM).

## Stage 1 — local

1. Read the relevant part of `docs/ARCHITECTURE.md` (Gotchas, Conventions)
   and the area's `CLAUDE.md` before editing.
2. Make the change. Add or extend tests in the matching
   `describe('<area>')` block of `server/test/unit.test.ts`.
3. `npm run typecheck`, then the affected test block
   (`cd server && npx vitest run -t "<area>"`), then `npm test`.
4. UI changes: verify with the `web` preview (`.claude/launch.json`), which
   proxies to an API on :3004.
5. A change to an MCP tool (`server/src/mcp/tools.ts`) changes what every
   connected client sees: keep descriptions short, and tell the user to
   reconnect the claude.ai connector once it is deployed, or it keeps the old
   tool list.

## Stage 2 — on a GPU

Both targets serve the same hostname through one named tunnel, so **only one
instance can run at a time**; the launchers refuse to start a second. Check
first: `pepper_status` (MCP), or `uv run deploy/runpod/launch.py status`.
Ask the user before launching either — one spends money, the other quota.

| | RunPod (the default target) | Kaggle |
| --- | --- | --- |
| Hardware | 24 GB (RTX 4090), 31–46 GB system RAM | 16 GB T4/P100 |
| Runs | The **published image** | Your checkout **plus uncommitted changes** |
| Models | Kept on the `pepper-data` volume | Re-downloaded, or read-only packs |
| Cost | Per second, until `down` or idle | Free weekly quota |

### RunPod

The pod runs `ghcr.io/searpro/pepper`, built by `.github/workflows/image.yml`
on every push to `main` that touches the app (`:latest`), and on demand for
any branch (tagged with the branch name). So the change has to be pushed and
the workflow finished before it can be tested — which needs the user's
go-ahead to commit and push:

```bash
git push -u origin <branch>
gh workflow run image.yml --ref <branch>        # not needed on main
gh run watch "$(gh run list --workflow image.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
uv run deploy/runpod/launch.py up --image ghcr.io/searpro/pepper:<branch>
uv run deploy/runpod/launch.py up               # main: the :latest image
```

Run `up` in the background and watch for `Pepper is up:`. Useful options:
`--min-ram 64` for model sets above ~40 GB, `--idle-minutes 0` to stop a
long test session terminating itself (default 30). Then `launch.py logs`
for the container log, and **`launch.py down` when finished** — a forgotten
pod bills until it idles out. Anything that adds Python dependencies must be
baked into the image (`Dockerfile`, `server/src/scripts/install-python.ts`):
installing onto the network volume at run time takes 20+ minutes.

### Kaggle

```bash
uv run deploy/kaggle/launch.py --hours 2 --packs starter
```

Builds the commit you have checked out plus uncommitted changes to tracked
files; untracked files are not sent, so commit new files or `git add -N`
them. The commit itself must be on `origin`. Setup takes several minutes
(Node, npm ci, build, backend installs). Add `--catalogue-branch <branch>`
when testing a catalogue change. The user cancels old runs on kaggle.com.
16 GB is too little for the catalogue's recommended image and video files,
so use it for server logic, not for judging quality.

### Exercising the change

Through the `pepper` MCP tools (`.mcp.json` runs a stdio bridge that reads
the hostname and token from the launchers' `.env` files; if its tools are
missing, the instance was down when the session started — reconnect it from
`/mcp`):

- `pepper_status` → backends, installed models, memory, idle time.
- Generate with the smallest settings that still exercise the change (few
  steps, small size). `generate_image` waits for the result; pass
  `hires: {enabled: false}` unless the second pass is what is being tested.
  `generate_video`, `generate_music` and video `upscale_image` return a job
  id: poll `get_job` with `wait_seconds: 50`.
- On failure, `get_logs` with `source` set to the backend (`sdcpp`,
  `llamacpp`, `audiocpp`, `python`) and `min_level: warn`.
- Every tool call resets the pod's idle timer; reads through the web app or
  `launch.py status` do not.

Fix, and redeploy only if a server change is needed: on RunPod that is a
push, an image build (~10 min) and a new pod; on Kaggle a full rebuild.

## Reporting

Say what was verified where: "typecheck + tests + UI locally; generated N
images on a RunPod 4090 in X s" — or state plainly which part was not run
and why. Record measured timings and surprises in a memory note.
