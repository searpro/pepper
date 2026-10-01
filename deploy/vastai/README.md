# Pepper on Vast.ai

Runs Pepper or Pepper Pro on a rented Vast.ai GPU, billed per second, at the
same fixed hostname and with the same API token as [RunPod](../runpod/README.md)
and [Kaggle](../kaggle/README.md). It is the same image and the same container
entrypoint (`deploy/runpod/entrypoint.mjs`) as on RunPod; only the launcher
and the storage model differ.

- `launch.py` runs on your machine: it finds offers, rents or restarts the
  instance, streams its log, and stops it.
- On Vast the entrypoint stops the instance when idle, where on RunPod it
  terminates the pod.

## RunPod vs Vast.ai

| | RunPod | Vast.ai |
| --- | --- | --- |
| Hosts | Secure data centers | A marketplace: data centers and individual hosts, verified or not |
| Price | RTX 4090 ≈ $0.6–0.7/h | RTX 4090 ≈ $0.3–0.5/h, disk included; downloads are billed per TB (below) |
| Models | A network volume, kept between pods on any machine in its data center | The instance's own disk, kept while the instance is stopped, on that one machine |
| `down` / idle | Terminate (the volume stays) | Stop (the disk stays; only storage is billed) |
| Restart | Any free GPU in the volume's data center | The same machine, once its GPU is free; `up --fresh` rents another |

Vast does have volumes, but they are local to one machine, like an
instance's disk. So they would add nothing here: a stopped instance is the
volume.

## One-time setup

1. **API key**: cloud.vast.ai → Account → Keys. Put it in
   `deploy/vastai/.env` (git-ignored), or export `VAST_API_KEY` (or
   `VAST_AI_API_KEY`). A key saved
   by the `vastai` CLI (`~/.config/vastai/vast_api_key`) also works:

   ```bash
   VAST_API_KEY=...
   ```

   `PEPPER_API_TOKEN`, `PEPPER_TUNNEL_TOKEN` and `PEPPER_HOSTNAME` are read
   from `deploy/runpod/.env` or `deploy/kaggle/.env` unless you set them
   here. Vast has no secret store, so the two tokens become the instance's
   environment variables, which only your account can see. The launcher
   prints neither.
2. **Credit**: Vast is prepaid; add some under Billing.
3. The image must be public (see the RunPod README). It already is if RunPod
   pulls it.

## Starting and stopping

```bash
uv run deploy/vastai/launch.py gpus     # offers now, by GPU: count, cheapest $/h, RAM, countries (no key needed)
uv run deploy/vastai/launch.py up
```

`up` works like this:

- It refuses to start if your hostname already answers, because two instances
  on one tunnel split traffic at random.
- If a stopped `pepper` instance exists, `up` starts it again. Otherwise it
  rents the cheapest offer for the first GPU in `--gpu` that has one. It only
  considers offers that meet all of these:
  - verified hosts
  - one GPU
  - CUDA ≥ 12.4
  - reliability ≥ 97 %
  - ≥ 200 Mb/s download
  - the RAM and disk asked for
- It then streams the container log and prints `Pepper is up: https://…`
  once `/health` answers.

The first boot downloads the image (several GB for Pro) and then the
backends or models. A restart skips both. Measured for Pepper Pro on an
RTX 4090 in Romania, it took 8 minutes from renting to `Pepper is up`, most
of it pulling the image.

| Option | Default | Meaning |
| --- | --- | --- |
| `--gpu NAME` | RTX 4090, A5000, 3090, L4, A6000 | GPU names as Vast spells them (`gpus --all` lists them), in order of preference. |
| `--disk GB` | `150` | The instance's disk: models, outputs, everything. It is fixed once rented. |
| `--min-ram GB` | any (Pro: the tier's) | Only offers giving at least this much system RAM. |
| `--max-price USD` | none | Most to pay per hour, disk included. |
| `--idle-minutes N` | `30` | Stop the instance after N idle minutes; `0` never. |
| `--unverified` | off | Also consider hosts Vast has not verified. They are cheaper and less predictable. |
| `--fresh` | off | Destroy the stopped instance (and its models) and rent a new one. |
| `--image REF` | `ghcr.io/searpro/pepper:latest` | For example `…:sha-abc1234` to pin a build. |
| `--catalogue-branch B` | none | Serve the catalogue from a pepper-catalogue branch. |
| `--force` | off | Start even if the hostname already answers. |

```bash
uv run deploy/vastai/launch.py status          # state, GPU, RAM, $/h, and whether Pepper answers
uv run deploy/vastai/launch.py logs            # follow the container log
uv run deploy/vastai/launch.py down            # stop: no GPU billing, the disk and models stay
uv run deploy/vastai/launch.py down --destroy  # delete the instance and its disk
```

- Ctrl-C during `up` only detaches. The instance keeps running, and billing.
- A stopped instance keeps the environment it was created with. Changing
  the image, tier or tokens takes `up --fresh`.
- Restarting a stopped instance can wait: someone else may have rented its
  GPU in the meantime. Vast then holds the instance until the GPU frees up.
  If you don't want to wait, run `up --fresh`, which rents a new machine;
  the models download again.

## Pepper Pro

`up --product pro --tier <tier>` runs `ghcr.io/searpro/pepper-pro`, asks for
the tier's GPUs and host RAM, and tells the server its tier:

| `--tier` | GPUs tried, in order | Min VRAM | Min host RAM |
| --- | --- | --- | --- |
| `24gb-64ram` | RTX 4090, RTX A5000, RTX 3090 | 23 GB | 62 GB |
| `32gb` | RTX 5090, RTX PRO 4500, RTX 5000 Ada | 31 GB | 62 GB |
| `48gb` | L40S, RTX 6000 Ada, RTX A6000, RTX PRO 5000, L40 | 44 GB | 90 GB |
| `96gb` | RTX PRO 6000 (S, WS, Max-Q), H100 NVL, H100 SXM | 79 GB | 120 GB |

For example, `gpus --product pro --tier 32gb` shows what is on offer right
now. Give a Pro tier a larger `--disk`: H3, InfiniteTalk and Z-Image
together are about 95 GB.

## Costs besides the GPU

A host sets its own prices, and `status` shows the total per hour. For
the 4090 host used in the first test:

- **Disk:** $0.20 per GB per month. That is in the hourly price while the
  instance runs, and it is all you pay while it is stopped: 150 GB costs
  about $0.04/h, or $30 a month. `down --destroy` ends it.
- **Downloads:** $2.67 per TB. Installing Z-Image (21 GB) costs about
  $0.05, and H3 plus InfiniteTalk plus Z-Image (about 95 GB) about $0.25. A
  restart re-downloads nothing.

## Storage

The launcher tells Pepper the disk's size (`DATA_VOLUME_GB`), so a download
or a recipe install that would not fit is refused up front, just as on a
RunPod volume. If the disk fills anyway, the entrypoint deletes unfinished
downloads at the next boot.

## Idle shutdown

Idle means the same as on RunPod: no job, no download, and no successful
non-GET request or MCP `tools/call`. After `--idle-minutes`, the entrypoint
stops the instance. It does this through Vast's API, with the per-instance
key Vast puts in the container (`CONTAINER_API_KEY`), which is never passed
on to Pepper or cloudflared. The disk is kept, and the next `up` starts the
instance again.

## Without the named tunnel

With no `PEPPER_TUNNEL_TOKEN`:

- The launcher maps port 3000 and only rents hosts with an open port.
- Pepper is then at `http://<host ip>:<mapped port>`, which `status` prints.
- The connection is plain HTTP on a new address each time, so use the tunnel
  for anything but a quick test. The API token still applies.
