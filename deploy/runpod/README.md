# Pepper on RunPod

Runs Pepper on a RunPod GPU pod, billed per second, at the same fixed hostname
and with the same API token as the [Kaggle setup](../kaggle/README.md). Models
live on a network volume, so they download once rather than every run.

- `launch.py` — run on your machine: creates the volume, starts and stops pods,
  streams their logs.
- `entrypoint.mjs` — runs in the container: Pepper, the named tunnel, and the
  idle shutdown.
- The image is the repo's default `Dockerfile`: Ubuntu 22.04, Node, ffmpeg,
  cloudflared and the Python runner environment (torch, for SeedVR2 upscaling
  and the Python video runners) baked in. The .cpp backends download onto the
  volume on first boot. Published to `ghcr.io/searpro/pepper` by
  `.github/workflows/image.yml` on every push to `main` that touches the app.

## Kaggle vs RunPod

| | Kaggle | RunPod |
| --- | --- | --- |
| Cost | Free, weekly GPU quota | Per second (RTX 4090 ≈ $0.4–0.7/h) + volume storage |
| GPU | T4/P100, 16 GB | Your choice; default preference 24 GB (RTX 4090, A5000, L4) |
| Models | Re-download, or read-only packs | Network volume, kept between pods |
| Code that runs | Your checkout + uncommitted changes | The published image: **push, and wait for the image workflow** |
| Session | Up to 12 h | Until `down`, or idle for `--idle-minutes` |

## One-time setup

1. **API key**: runpod.io → Settings → API Keys → create one with read/write
   access. Put it in `deploy/runpod/.env` (git-ignored):

   ```bash
   RUNPOD_API_KEY=...
   ```

   `PEPPER_API_TOKEN`, `PEPPER_TUNNEL_TOKEN` and `PEPPER_HOSTNAME` are read from
   `deploy/kaggle/.env` unless you set them here too. The launcher copies the two
   tokens into RunPod secrets (`pepper_api_token`, `pepper_tunnel_token`) on
   every `up`, and the pod references them as `{{ RUNPOD_SECRET_… }}`, so the
   values never appear in the pod's settings or logs.

2. **Make the image public, once.** After the first image workflow run:
   github.com/searpro → Packages → `pepper` → Package settings → Change
   visibility → Public. RunPod pulls it anonymously.

3. **Create the network volume:**

   ```bash
   uv run deploy/runpod/launch.py gpus               # optional: see what's available where
   uv run deploy/runpod/launch.py volume --size 100
   ```

   A volume pins every future pod to its data center, so without
   `--datacenter` it goes where the preferred GPUs are most available. It is
   billed monthly until deleted (runpod.io → Storage).

## Starting and stopping

```bash
uv run deploy/runpod/launch.py up
```

The launcher refuses to start if your hostname already answers (a Kaggle run,
or another pod): two instances on one tunnel split traffic at random. It then
tries each GPU in order until one is free in the volume's data center, streams
the pod's log, and prints `Pepper is up: https://…` once `/health` answers.
The first pod on a new volume downloads the backends (a few minutes); later
pods start in about a minute plus the image pull.

| Option | Default | Meaning |
| --- | --- | --- |
| `--gpu ID` | 4090, A5000, L4, A6000 | GPU types in order of preference (repeatable; ids from `gpus`). |
| `--idle-minutes N` | `30` | Terminate the pod after N minutes idle; `0` never. |
| `--catalogue-branch B` | none | Serve the catalogue from a pepper-catalogue branch, to test a PR. |
| `--image REF` | `ghcr.io/searpro/pepper:latest` | e.g. `…:sha-abc1234` to pin a build. |
| `--cloud` | `SECURE` | `COMMUNITY` is cheaper and less reliable. |
| `--min-ram GB` | any | Only hosts with at least this much system RAM. |
| `--force` | off | Start even if the hostname already answers. |

```bash
uv run deploy/runpod/launch.py status   # cost/h and whether Pepper answers
uv run deploy/runpod/launch.py logs     # follow the container log
uv run deploy/runpod/launch.py down     # terminate; the volume and its models stay
```

Ctrl-C during `up` only detaches; the pod keeps running (and billing).

## Memory and storage, measured on a 4090 pod

- **System RAM is the real limit, not VRAM.** A 24 GB 4090 pod usually has
  **46 GB of RAM**, and the video models run with `--offload-to-cpu`: every
  component's weights sit in RAM and move to the GPU only while that component
  runs. A model set larger than about 40 GB aborts at load. The catalogue's
  recommended files are sized for this; `--min-ram 64` asks RunPod for a bigger
  host when you want the larger quantizations. Pepper's header shows the
  container's limit, not the host's.
- **Volume size.** The recommended sets are roughly: Z-Image 17 GB, Qwen-Image
  2.1 25 GB, LTX-2.5 37 GB, Wan 2.2 I2V 31 GB, MiniMax-H3 35 GB, HunyuanVideo
  1.5 28 GB each, SeedVR2 9 GB, music 7-11 GB each. Everything at once is
  about 250 GB; 100 GB holds the two image models, one video model, SeedVR2
  and a music model.
- **A full volume.** The volume is a quota the filesystem does not report, so
  the launcher tells Pepper its size (`DATA_VOLUME_GB`) and a download that
  would not fit is refused up front, with the numbers. `pepper_status` and
  `/v1/system/status` show `storage` (used / total). If the volume fills
  anyway, Pepper starts with a temporary in-memory database and says so in the
  log; delete a model and restart the pod. To grow a volume: runpod.io →
  Storage → edit (it can grow, never shrink).
- **Downloads can stall.** HuggingFace transfers sometimes drop to a crawl
  after the first few GB; cancel and retry the download (Models → Downloads),
  which resumes from the partial file on a fresh connection.

## Idle shutdown

A pod bills whether or not anyone uses it, so the entrypoint terminates it
after `--idle-minutes`. **Idle** means: no job queued or running, no download
in progress, and no successful non-GET request (a generation, an install, an
MCP tool call) in that time. Reads don't count, so a forgotten browser tab
polling status does not keep it alive; nor does MCP housekeeping (a client
connecting, listing tools or pinging), which an open claude.ai chat with the
connector enabled does on its own. Only `tools/call` counts. The pod log says when termination is
five minutes away. Pods with a network volume can only be terminated, not
stopped, which loses nothing: everything worth keeping is on the volume.

## Without the named tunnel

With no `PEPPER_TUNNEL_TOKEN`, Pepper is reachable through RunPod's own proxy at
`https://<pod-id>-3000.proxy.runpod.net`, a new address per pod. The API token
still applies. RunPod's proxy, like Cloudflare's, cuts requests off at 100 s,
which the MCP tools already work within.
