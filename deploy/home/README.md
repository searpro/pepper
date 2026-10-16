# Pepper on your own GPU machine

Runs Pepper or Pepper Pro on a Linux box with an NVIDIA card, over SSH, at
the same fixed hostname and with the same API token as
[RunPod](../runpod/README.md), [Vast.ai](../vastai/README.md) and
[Kaggle](../kaggle/README.md). It is the same image and the same container
entrypoint; only the launcher differs.

- `launch.py` runs on your machine: it writes a Compose stack onto the host,
  starts or updates it, follows its log, and removes it.
- Nothing is billed, so there is no idle shutdown. The container restarts
  with Docker (and after a reboot) until `down`.

## Cloud vs home

| | RunPod / Vast.ai | Home |
| --- | --- | --- |
| Cost | Per second | Electricity |
| GPU | Your choice per run | Yours; the first box is an RTX 5060 Ti, 16 GB |
| Models | Network volume / instance disk | A folder on the host, `/srv/<product>/data` |
| Code that runs | The published image: push, and wait for CI | The published image, or `--build`: this checkout, uncommitted changes too |
| `down` | Terminate / stop | Remove the container; the data folder stays |

## One-time host setup

On Ubuntu 26.04 (other releases: the same steps, from the same vendors):

1. **SSH key login** from your machine: `ssh-copy-id user@host`.
2. **NVIDIA driver.** Blackwell cards (RTX 50xx, RTX PRO) need the *open*
   kernel modules: `sudo ubuntu-drivers install` picks one, or
   `sudo apt install nvidia-driver-595-open`. Reboot, then `nvidia-smi`.
3. **Docker Engine** from Docker's own apt repository (docs.docker.com →
   Install → Ubuntu), then `sudo usermod -aG docker $USER` and log in again.
   Capping container logs in `/etc/docker/daemon.json`
   (`"log-opts": {"max-size": "50m", "max-file": "3"}`) keeps a busy
   container from filling the disk.
4. **NVIDIA Container Toolkit** from NVIDIA's apt repository
   (docs.nvidia.com → Container Toolkit → Installing), then
   `sudo nvidia-ctk runtime configure --runtime=docker` and
   `sudo systemctl restart docker`. Check it with
   `docker run --rm --gpus all nvidia/cuda:12.8.1-base-ubuntu22.04 nvidia-smi`.
5. **`/srv` writable by your user:** `sudo install -d -o $USER -g $USER /srv`.

Then, in `deploy/home/.env` (git-ignored):

```bash
PEPPER_HOME_HOST=user@host
```

`PEPPER_API_TOKEN`, `PEPPER_TUNNEL_TOKEN` and `PEPPER_HOSTNAME` are read
from `deploy/runpod/.env`, `deploy/vastai/.env` or `deploy/kaggle/.env`
unless you set them here too. They reach the host over SSH's stdin and are
written to `/srv/<product>/.env`, readable by your user only.

## Starting and stopping

```bash
uv run deploy/home/launch.py up --product pro            # Pepper Pro, tier 16gb, the published image
uv run deploy/home/launch.py up --product pro --build    # build this checkout on the host instead
uv run deploy/home/launch.py status                      # GPU, RAM, disk, stacks, whether Pepper answers
uv run deploy/home/launch.py logs --product pro          # follow the container log
uv run deploy/home/launch.py down --product pro          # remove the container; the data stays
```

`up` works like this:

- It refuses to start if your hostname already answers from somewhere else,
  because two instances on one tunnel split traffic at random. When the
  answer comes from this host's own container, `up` updates it in place:
  it pulls (or builds) the image and recreates the container, data intact.
- It refuses if the other product is running here: both use port 3000.
- It warns when another container holds the GPU (a `llama-server`, say),
  since a 16 GB card has little to share.
- It writes `/srv/pepper-pro/compose.yaml` and `.env`, pulls the image,
  starts the stack, follows the log, and prints `Pepper is up: https://…`
  once `/health` answers. On your network Pepper also answers at
  `http://<host>:3000`, the API token still required.

| Option | Default | Meaning |
| --- | --- | --- |
| `--product pro` | `pepper` | Pepper Pro instead of Pepper. |
| `--tier T` | `16gb` | Pepper Pro's tier: which file variants recipes install. |
| `--build` | off | Build `Dockerfile` / `Dockerfile.pro` on the host from this checkout (tracked and untracked files, not ignored ones). |
| `--build-arg K=V` | none | With `--build`, a Dockerfile ARG (repeatable). `TORCH_INDEX=https://download.pytorch.org/whl/cu130` gives a Blackwell card the CUDA 13 torch its NVFP4 kernels need; the published image is CUDA 12.8, where NVFP4 falls back to slow, memory-hungry code. |
| `--image REF` | the published image | For example `ghcr.io/searpro/pepper-pro:sha-abc1234`. |
| `--catalogue-branch B` | none | Serve the catalogue from a pepper-catalogue branch. |
| `--wait N` | `20` | Minutes to wait for `/health` after the container starts. |
| `--force` | off | Start even if the hostname already answers. |
| `--host user@host` | `PEPPER_HOME_HOST` | Another machine. |

Ctrl-C during `up` only stops following the log; the container keeps
running. The host's first pull of Pepper Pro is many GB, and a model set is
tens of GB more, so a slow home connection sets the pace of a first run.

## Data

Each product is one folder, which is the whole story of what it stores:

```
/srv/pepper-pro/
  compose.yaml   how the container runs (rewritten by every `up`)
  .env           the tokens, mode 600
  data/          /data in the container: models, database, outputs
```

| You want | Run |
| --- | --- |
| The container gone, data kept | `down --product pro` |
| The image gone too | `down --product pro --delete-image` |
| Everything gone | `down --product pro --delete-data` (asks you to type the name) |
| What uses space | `status`, or `du -sh /srv/*/data` on the host |

The container writes as root, so `down --delete-data` removes the folder
through a throwaway container rather than needing sudo. Portainer, or
`docker compose` run in the folder, manage the same stack; keep Portainer
off the public tunnel, since controlling Docker is root on the host.

## The 16gb tier

The first home box has an RTX 5060 Ti (16 GB) and 32 GB of RAM, below every
cloud tier. `16gb` installs, for each file, the variant written for the
next tier up (`24gb-64ram`, the smallest files), and no recipe lists it as
verified yet, so the Recipes screen flags each one until a golden run on
the card fills that in. As on a 24 GB pod, system RAM rather than VRAM is
what limits a model set: weights not on the GPU wait in RAM. Image, audio
and upscaling recipes (Z-Image, Flux2 Klein, Qwen Image Edit, Qwen3-TTS,
ACE-Step, SeedVR2) are the ones to try first; video recipes whose files
total 40 GB or more need a bigger host.
