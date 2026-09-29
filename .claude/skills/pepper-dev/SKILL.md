---
name: pepper-dev
description: Develop and verify a Pepper feature end to end — change the code, check it locally, then run it on a Kaggle GPU and exercise it through the Pepper MCP tools. Use when implementing or debugging anything in Pepper that needs real generation (sd-cli, llama.cpp, audio.cpp, Python runners) to prove it works.
---

# Pepper development loop

Real generation needs a GPU and the backend binaries, which a Mac usually
lacks. So a change is proven in two stages: locally (types, tests, UI), then
on Kaggle through the `pepper` MCP server. Don't claim a generation change
works until stage 2 has run.

## Stage 1 — local

1. Read the relevant part of `docs/ARCHITECTURE.md` (Gotchas, Conventions)
   and the area's `CLAUDE.md` before editing.
2. Make the change. Add or extend tests in the matching
   `describe('<area>')` block of `server/test/unit.test.ts`.
3. `npm run typecheck`, then the affected test block
   (`cd server && npx vitest run -t "<area>"`), then `npm test`.
4. UI changes: verify with the `web` preview (`.claude/launch.json`), which
   proxies to an API on :3004.

## Stage 2 — on a GPU (Kaggle, or RunPod)

Kaggle is free and runs your checkout including uncommitted changes. RunPod
(`deploy/runpod/README.md`) costs money but has bigger GPUs and keeps models
on a volume; it runs the *published image*, so a change must be pushed to
`main` and the `image` workflow finished (`gh run watch`) before
`uv run deploy/runpod/launch.py up`. Both serve the same hostname, so only
one can run at a time; the launchers refuse to start a second. The steps below
use Kaggle; on RunPod swap the launch command and run `launch.py down` when
done.

The launcher builds the commit you have checked out **plus uncommitted
changes to tracked files**; untracked files are not sent. So either commit
new files first or `git add -N` them. The commit itself must be on `origin`.

1. Check nothing is running already: `pepper_status` (MCP). If it answers, a
   run is live — reuse it only if it was launched from your current code.
   Two runs on the same named tunnel break both; the user cancels old runs on
   kaggle.com.
2. Ask the user before launching — it spends their weekly GPU quota. Then:
   ```bash
   uv run deploy/kaggle/launch.py --hours 2 --packs starter
   ```
   Run it in the background and watch for `Pepper is up:`. Setup takes
   several minutes (Node, npm ci, build, backend installs). Add
   `--catalogue-branch <branch>` when testing a catalogue change.
3. Exercise the change through MCP:
   - `pepper_status` → backends and installed models.
   - Generate with the smallest settings that still exercise the change
     (few steps, small size). Videos return a job id: poll `get_job` with
     `wait_seconds: 50`.
   - On failure, `get_logs` with `source` set to the backend (`sdcpp`,
     `llamacpp`, `audiocpp`, `python`) and `min_level: warn`.
4. Fix, and relaunch only if a server change is needed: every relaunch is a
   full rebuild.

## Reporting

Say what was verified where: "typecheck + tests + UI locally; generated N
images on Kaggle T4 in X s" — or state plainly which part was not run and why.
