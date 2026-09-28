# Pepper on Kaggle

Runs Pepper on a free Kaggle GPU for up to 12 hours, reachable from anywhere
through a Cloudflare quick tunnel. Everything is driven from the command line
on your own machine; the Kaggle website is only needed to stop a run early.

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

3. **Wait for the URL.** The terminal shows `pushed …`, the kernel's status,
   then its setup log (Node, cloudflared, `npm ci`, the build) — a few minutes.
   When Pepper is healthy it prints:

   ```
     Pepper is up: https://<something>.trycloudflare.com
   ```

   The URL is also written to `deploy/kaggle/.last-url` (git-ignored).

4. **Check it's live.** Open the URL → **Logs**: the header should read
   **live** and lines should keep arriving. Download and generation progress
   should tick smoothly.

## While it runs

- **Ctrl-C only detaches.** It stops the local log stream; the kernel keeps
  running until its hours are up or you cancel it on Kaggle.
- **If the quick tunnel drops**, the kernel reopens it with a **new URL**. It is
  posted to the launcher if it is still attached; otherwise find it in the
  kernel's log on Kaggle after the run.
- **Storage is scratch, and smaller than it looks.** Models, outputs and the
  database live under `/tmp` and are gone when the run ends; expect to
  re-download models each run. `df` reports ~1.2 TB free there, but Kaggle
  only lets a session write about 60 GB and kills the kernel (status `ERROR`,
  empty log) when it goes over. Keep the installed models under ~50 GB —
  delete one video model before installing the next. Models mounted from
  [packs](#model-packs) are read, not written, so they do not count.

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

Quick tunnels do not pass Server-Sent Events through at all
([Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)),
so the log, job and download streams also answer a WebSocket upgrade on the
same URL and the web app connects that way first (see `server/src/util/sse.ts`
and `useEventStream` in `web/src/lib/api.ts`). If live views stop updating on
Kaggle but work locally, check that the browser's WebSocket to `/v1/.../stream`
is connecting. Quick tunnels also cap in-flight requests at 200.
