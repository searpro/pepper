# Pepper on Kaggle

Runs Pepper on a free Kaggle GPU for up to 12 hours, reachable from anywhere
through a Cloudflare tunnel — at a fixed hostname of your own when a named
tunnel is configured, otherwise at a random quick-tunnel URL. Everything is
driven from the command line on your own machine; the Kaggle website is only
needed to stop a run early.

- `launch.py` — run on your machine. Pushes the kernel, streams its log back,
  prints the public URL.
- `kernel.py` — what runs on Kaggle. Not run by hand; `launch.py` fills in its
  config and pushes it.

## Prerequisites

- **`uv`** — `launch.py` is a `uv` script and installs its own dependency.
- **`cloudflared`** on `PATH` (`brew install cloudflared`). The launcher opens
  a second quick tunnel back to your machine so the kernel can send its log and
  URL while it runs; a batch kernel's own log is only readable once it ends.
- **A Kaggle API token** at `~/.kaggle/kaggle.json`: kaggle.com/settings → API →
  Create New Token. It is never printed or sent to the kernel.
- **Secrets in `deploy/kaggle/.env`** (git-ignored; see
  [Fixed URL and API token](#fixed-url-and-api-token)). At minimum
  `PEPPER_API_TOKEN`: the launcher refuses to serve without one unless you pass
  `--no-auth`.
- **Your commit pushed to `origin`.** The kernel fetches the exact commit
  checked out locally, so it must exist on GitHub. Uncommitted changes to
  tracked files are sent along as a patch; **untracked files are not** — the
  launcher lists any it skips.

## Starting a run

1. **Stop any run still going.** Every launch pushes a new version of the same
   private kernel (`pepper-server`), so let the old one finish first:
   kaggle.com/code → Your Work → **pepper-server** → cancel the running version.

2. **Launch** from the repository root:

   ```bash
   uv run deploy/kaggle/launch.py
   ```

   | Option | Default | Meaning |
   | --- | --- | --- |
   | `--hours N` | `6` | How long the server stays up (capped just under Kaggle's 12). |
   | `--accel t4x2\|t4\|p100` | `t4x2` | Which GPU to run on. |
   | `--no-patch` | off | Build the pushed commit only, ignoring local changes. |
   | `--packs a,b` | none | Mount saved model packs (see [Model packs](#model-packs)). |
   | `--catalogue-branch B` | none | Serve the catalogue from branch `B` of searpro/pepper-catalogue, to test a catalogue PR before merging. |
   | `--quick-tunnel` | off | Use a random `trycloudflare.com` URL even when a named tunnel is configured. |
   | `--no-auth` | off | Serve without an API token. Anyone who finds the URL can use the GPU. |

3. **Wait for the URL.** The terminal shows `pushed …`, the kernel's status,
   then its setup log (Node, cloudflared, `npm ci`, the build) — a few minutes.
   When Pepper is healthy it prints:

   ```
     Pepper is up: https://pepper.example.com  (MCP: https://pepper.example.com/mcp)
   ```

   The URL is also written to `deploy/kaggle/.last-url` (git-ignored).

4. **Check it's live.** Open the URL, sign in with the API token (once per
   browser; the cookie lasts 30 days) → **Logs**: the header should read
   **live** and lines should keep arriving. Download and generation progress
   should tick smoothly.

## While it runs

- **Ctrl-C only detaches.** It stops the local log stream; the kernel keeps
  running until its hours are up or you cancel it on Kaggle.
- **If the tunnel drops**, the kernel reopens it. A named tunnel comes back at
  the same hostname; a quick tunnel comes back with a **new URL**. It is
  posted to the launcher if it is still attached; otherwise find it in the
  kernel's log on Kaggle after the run.
- **Storage is scratch, and smaller than it looks.** Models, outputs and the
  database live under `/tmp` and are gone when the run ends; expect to
  re-download models each run. `df` reports ~1.2 TB free there, but Kaggle
  only lets a session write about 60 GB and kills the kernel (status `ERROR`,
  empty log) when it goes over. Keep the installed models under ~50 GB —
  delete one video model before installing the next. Models mounted from
  [packs](#model-packs) are read, not written, so they do not count.

## Fixed URL and API token

`deploy/kaggle/.env` (git-ignored, never printed; the process environment
overrides it):

```bash
PEPPER_API_TOKEN=...      # openssl rand -base64 32; keep a copy in your password manager
PEPPER_TUNNEL_TOKEN=...   # from `cloudflared tunnel token pepper`
PEPPER_HOSTNAME=pepper.example.com
```

- **The API token** guards everything except `/health` and the web app's
  sign-in page. See `docs/ARCHITECTURE.md` → "One token, three ways to present it".
- **The named tunnel** gives every run the same address, so bookmarks, the
  claude.ai connector and Claude Code's MCP config never change. One-time
  setup, on a machine logged in to Cloudflare with a domain on it:

  ```bash
  cloudflared tunnel login                       # pick the domain in the browser
  cloudflared tunnel create pepper
  cloudflared tunnel route dns pepper pepper     # CNAME pepper.<domain>
  cloudflared tunnel token pepper                # -> PEPPER_TUNNEL_TOKEN
  ```

  The ingress is given on the command line (`--url http://127.0.0.1:3000`), so
  no config file or dashboard route is needed. Until a run is up, the hostname
  answers 502/530.
- **Only one run per tunnel.** Two kernels connected with the same token
  split traffic between them at random. Cancel the old run first.
- **How the secrets reach Kaggle.** They are not written into the kernel:
  Kaggle stores the pushed source, `CONFIG` included. The kernel fetches them
  at startup from the launcher's receiver (`GET /secrets`, authenticated by
  the per-launch secret), so the launcher must be running when a kernel
  starts. A kernel promised a token that cannot fetch one stops instead of
  serving an open Pepper.

## Using Pepper from Claude

Pepper serves a Model Context Protocol endpoint at `/mcp` with tools to
generate images, video, speech, music and text, upscale images and videos,
follow jobs, read logs, and search, install and delete catalogue models.

- **Claude Code** in this repo: `.mcp.json` starts `.claude/pepper-mcp.mjs`, a
  small stdio bridge that forwards to `https://<PEPPER_HOSTNAME>/mcp` with
  `PEPPER_API_TOKEN`, both read from the `.env` files above (this folder's or
  `deploy/runpod`'s). Nothing needs exporting in a shell profile, which the
  desktop app would not read anyway; approve the server on first use. With
  neither file it talks to `http://localhost:3000`, and `PEPPER_URL` in the
  environment overrides both. It connects when a session starts, so with no
  instance running it shows as failed: reconnect it from `/mcp` once one is up.
  Elsewhere:
  `claude mcp add --transport http pepper https://pepper.example.com/mcp --header "Authorization: Bearer $PEPPER_API_TOKEN"`.
- After deploying a version that adds or changes tools, reconnect the
  connector (claude.ai: Settings → Connectors → Pepper → reconnect): clients
  keep the tool list they fetched when they connected.
- **claude.ai** (Settings → Connectors → Add custom connector): if the dialog
  offers request headers, use `https://pepper.example.com/mcp` with the
  `Authorization` header above. Otherwise use
  `https://pepper.example.com/mcp/<API token>` with no auth — the URL is then
  the secret, so treat it like one and rotate the token if it leaks.
- Links in tool results (videos, audio) open in the browser you signed the
  web app in with; images are also returned inline.

## Model packs

A pack is a set of models downloaded once and kept on Kaggle, so a run starts
with them installed instead of fetching 10–20 GB first. It is a CPU-only kernel
(`pepper-pack-<name>`, no GPU quota used) whose saved output is Pepper's
`models/` folder; runs mount it read-only.

```bash
uv run deploy/kaggle/launch.py --build-pack starter      # once, ~20–30 min
uv run deploy/kaggle/launch.py --packs starter
```

| Pack | Contents | Size |
| --- | --- | --- |
| `starter` | Z-Image Turbo (Q8_0), whose Qwen3-4B-Instruct text encoder is also offered as a text model; Qwen3-TTS VoiceDesign, Chatterbox (voice cloning), Parakeet (speech recognition) | ~17 GB |
| `qwen-image` | Qwen-Image 2.1 with the Q4_0 and uncensored Q5_K_M checkpoints, Qwen3-VL-8B encoder (also a text model) and vision projector, Viggle 6-step and Pruna 8-step LoRAs | ~17 GB |

Packs are defined in `packs/<name>.json` as catalogue installs by file URL, so
adding one is writing a JSON file; rebuild a pack to change it. Limits and
behaviour worth knowing:

- **20 GB per pack.** Kaggle caps a kernel's saved output there, so keep a pack
  under ~19 GB and split larger sets. Several packs can be mounted at once.
- **Pepper sees ordinary bundles.** Each pack's files are symlinked into
  `/tmp/pepper-data/models` at startup, and `model.json` is copied, so
  deleting or editing a model in a run only changes that run.
- **First load is warm.** After Pepper starts, up to 16 GB of pack files are
  read once in the background (~190 MB/s from Kaggle's mount), so the first
  generation reads them from memory. Log line: `warmed … GB of pack files`.
- **Backends still install per run** (~1 min from GitHub releases): each
  bundles its own CUDA runtime, which would take ~3.5 GB of a pack.

## Stopping a run

kaggle.com/code → **pepper-server** → cancel the running version. The run also
ends on its own after `--hours`.

## Why the UI streams over WebSocket

Quick tunnels (not named ones) do not pass Server-Sent Events through at all
([Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)),
so the log, job and download streams also answer a WebSocket upgrade on the
same URL and the web app connects that way first (see `server/src/util/sse.ts`
and `useEventStream` in `web/src/lib/api.ts`). If live views stop updating on
Kaggle but work locally, check that the browser's WebSocket to `/v1/.../stream`
is connecting. Quick tunnels also cap in-flight requests at 200.
