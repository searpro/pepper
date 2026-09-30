#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["requests"]
# ///
"""Run Pepper on a RunPod GPU pod, at the same fixed hostname as on Kaggle.

    uv run deploy/runpod/launch.py gpus                 # what's available, and where
    uv run deploy/runpod/launch.py volume --size 100    # once: persistent model storage
    uv run deploy/runpod/launch.py up                   # start a pod; streams its log until Pepper answers
    uv run deploy/runpod/launch.py status
    uv run deploy/runpod/launch.py logs                 # follow the pod's log
    uv run deploy/runpod/launch.py down                 # terminate it (the volume stays)

A pod runs the published image (ghcr.io/searpro/pepper, built by CI from
main), so unlike the Kaggle launcher it does not send local changes: push
first, and wait for the image workflow.

Configuration comes from `deploy/runpod/.env` (git-ignored), falling back to
`deploy/kaggle/.env` for the PEPPER_* values the two share:

    RUNPOD_API_KEY=...        runpod.io → Settings → API Keys (read/write)
    PEPPER_API_TOKEN=...      required
    PEPPER_TUNNEL_TOKEN=...   with PEPPER_HOSTNAME: serve at a fixed hostname
    PEPPER_HOSTNAME=...

The two tokens are stored as RunPod secrets and the pod references them as
`{{ RUNPOD_SECRET_… }}`, so their values never appear in the pod's settings.
Nothing is printed. The API key stays on this machine.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
from pathlib import Path

import requests

API = "https://api.runpod.io/v2"
HERE = Path(__file__).resolve().parent
ENV_FILES = [HERE / ".env", HERE.parent / "kaggle" / ".env"]
IMAGE = "ghcr.io/searpro/pepper:latest"
POD_NAME = "pepper"
VOLUME_NAME = "pepper-data"
CATALOGUE_RAW = "https://raw.githubusercontent.com/searpro/pepper-catalogue/{branch}/pepper-catalogue.json"
# First choice first. 24 GB is the useful step up from Kaggle's 16 GB; the
# 4090 is the cheapest fast one and usually in stock.
DEFAULT_GPUS = ["NVIDIA GeForce RTX 4090", "NVIDIA RTX A5000", "NVIDIA L4", "NVIDIA RTX A6000"]
# The backend releases bundle CUDA 12 runtimes, which need a 12.x driver.
MIN_CUDA = "12.4"
SECRETS = {"PEPPER_API_TOKEN": "pepper_api_token", "PEPPER_TUNNEL_TOKEN": "pepper_tunnel_token"}


def load_env() -> dict[str, str]:
    """The first file to define a key wins, and the process environment beats both."""
    values: dict[str, str] = {}
    for path in ENV_FILES:
        if not path.exists():
            continue
        for raw in path.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values.setdefault(key.strip(), value.strip().strip("'\""))
    for key in ("RUNPOD_API_KEY", *SECRETS, "PEPPER_HOSTNAME"):
        if os.environ.get(key):
            values[key] = os.environ[key]
    return {k: v for k, v in values.items() if v}


class RunPod:
    def __init__(self, key: str) -> None:
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {key}"

    def call(self, method: str, path: str, **kwargs):
        r = self.session.request(method, f"{API}{path}", timeout=60, **kwargs)
        if r.status_code >= 400:
            raise RuntimeError(f"{method} {path} → {r.status_code}: {r.text[:500]}")
        return r.json() if r.content else None

    def pods(self) -> list[dict]:
        return [p for p in self.call("GET", "/pods")["pods"] if p.get("name") == POD_NAME
                and p.get("status") not in ("TERMINATED",)]

    def volume(self, name: str) -> dict | None:
        return next((v for v in self.call("GET", "/network-volumes")["networkVolumes"] if v["name"] == name), None)

    def gpus(self) -> list[dict]:
        return self.call("GET", "/catalog/gpus", params={
            "include": "AVAILABILITY", "product": "POD", "minCudaVersion": MIN_CUDA})["gpus"]


def healthy(url: str) -> bool:
    try:
        return requests.get(f"{url}/health", timeout=8).ok
    except requests.RequestException:
        return False


def public_url(env: dict[str, str], pod_id: str | None = None) -> str | None:
    if env.get("PEPPER_HOSTNAME") and env.get("PEPPER_TUNNEL_TOKEN"):
        return f"https://{env['PEPPER_HOSTNAME']}"
    return f"https://{pod_id}-3000.proxy.runpod.net" if pod_id else None


# --- Commands -------------------------------------------------------------------


def cmd_gpus(rp: RunPod, env: dict, a) -> None:
    rows = sorted(rp.gpus(), key=lambda g: (g.get("memory", 0), g["id"]))
    print(f"{'GPU':32} {'VRAM':>5} {'$/h':>6}  availability (data centers)")
    for g in rows:
        if g.get("availability") in (None, "NONE") and not a.all:
            continue
        dcs = ", ".join(f"{d['id']}:{d['availability'][0]}" for d in g.get("dataCenters", [])
                        if d.get("availability") != "NONE")
        price = (g.get("price") or {}).get("secure")
        print(f"{g['id']:32} {g.get('memory', '?'):>4}G {price if price is not None else '-':>6}  "
              f"{g.get('availability', '?')}  {dcs}")


def cmd_volume(rp: RunPod, env: dict, a) -> None:
    existing = rp.volume(a.name)
    if existing:
        print(f"{a.name}: {existing['size']} GB in {existing['dataCenter']} (id {existing['id']})")
        return
    dc = a.datacenter
    if not dc:
        # A network volume pins every future pod to its data center, so put it
        # where the preferred GPUs are most available right now.
        rank = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}
        by_id = {g["id"]: g for g in rp.gpus()}
        scores: dict[str, int] = {}
        for weight, gpu in zip(range(len(a.gpu), 0, -1), a.gpu):
            for d in by_id.get(gpu, {}).get("dataCenters", []):
                scores[d["id"]] = scores.get(d["id"], 0) + weight * rank.get(d.get("availability"), 0)
        if not scores or max(scores.values()) == 0:
            sys.exit(f"none of {a.gpu} is available anywhere right now; pass --datacenter")
        dc = max(scores, key=scores.get)
    if not a.yes:
        answer = input(f"create a {a.size} GB network volume '{a.name}' in {dc}? It is billed until deleted. [y/N] ")
        if answer.strip().lower() != "y":
            sys.exit("cancelled")
    volume = rp.call("POST", "/network-volumes", json={"name": a.name, "size": a.size, "dataCenter": dc})
    print(f"created {a.name}: {volume['size']} GB in {volume['dataCenter']} (id {volume['id']})")


def sync_secrets(rp: RunPod, env: dict) -> set[str]:
    """Create or update the RunPod secrets the pod references. Returns the env
    keys that have a secret behind them."""
    listed = rp.call("GET", "/account/secrets")
    existing = {s["name"]: s["id"] for s in (listed.get("secrets", []) if isinstance(listed, dict) else listed)}
    synced = set()
    for key, name in SECRETS.items():
        value = env.get(key)
        if not value:
            continue
        if name in existing:
            rp.call("PATCH", f"/account/secrets/{existing[name]}", json={"value": value})
        else:
            rp.call("POST", "/account/secrets", json={"name": name, "value": value,
                                                      "description": f"Pepper {key} (deploy/runpod/launch.py)"})
        synced.add(key)
    return synced


PULL_NOISE = re.compile(r"^[0-9a-f]{12} (Pulling fs layer|Waiting|Downloading|Verifying Checksum|"
                        r"Download complete|Extracting|Already exists)$")


def follow_logs(rp: RunPod, pod_id: str, stop: threading.Event, tail: int = 200) -> None:
    """Print the pod's log (SSE) until `stop` is set; reconnects from the last event.
    Per-layer image pull progress is dropped: hundreds of lines saying nothing
    beyond the "Pull complete" and "Status:" lines that are kept."""
    last_id = None
    while not stop.is_set():
        headers = {"Last-Event-ID": last_id} if last_id else {}
        try:
            with rp.session.get(f"{API}/pods/{pod_id}/logs", params={"tail": tail}, headers=headers,
                                stream=True, timeout=(10, 90)) as r:
                if r.status_code >= 400:
                    time.sleep(5)
                    continue
                for raw in r.iter_lines(decode_unicode=True):
                    if stop.is_set():
                        return
                    if raw.startswith("id:"):
                        last_id = raw[3:].strip()
                    elif raw.startswith("data:"):
                        try:
                            event = json.loads(raw[5:])
                            if PULL_NOISE.match(event.get("line", "").strip()):
                                continue
                            print(f"[{event.get('source', 'pod')}] {event.get('line', '').rstrip()}", flush=True)
                        except ValueError:
                            pass
        except requests.RequestException:
            pass
        stop.wait(3)


def cmd_up(rp: RunPod, env: dict, a) -> None:
    if not env.get("PEPPER_API_TOKEN"):
        sys.exit("no PEPPER_API_TOKEN in deploy/runpod/.env, deploy/kaggle/.env or the environment")
    if bool(env.get("PEPPER_TUNNEL_TOKEN")) != bool(env.get("PEPPER_HOSTNAME")):
        sys.exit("set both PEPPER_TUNNEL_TOKEN and PEPPER_HOSTNAME, or neither")

    # One instance per hostname: two connectors on one tunnel split traffic
    # between them at random, whatever platform each runs on.
    url = public_url(env)
    if url and healthy(url) and not a.force:
        sys.exit(f"{url} is already serving (Kaggle, or another pod). Stop it first, or pass --force.")
    running = rp.pods()
    if running and not a.force:
        sys.exit(f"a '{POD_NAME}' pod already exists ({running[0]['id']}, {running[0]['status']}); "
                 "run `down` first, or pass --force")

    volume = rp.volume(a.volume)
    if not volume:
        sys.exit(f"no network volume '{a.volume}'; create one with `volume --size 100`")
    synced = sync_secrets(rp, env)

    pod_env = {
        **{key: f"{{{{ RUNPOD_SECRET_{SECRETS[key]} }}}}" for key in synced},
        "PEPPER_IDLE_MINUTES": str(a.idle_minutes),
        **({"PEPPER_HOSTNAME": env["PEPPER_HOSTNAME"]} if "PEPPER_TUNNEL_TOKEN" in synced else {}),
        **({"CATALOGUE_URL": CATALOGUE_RAW.format(branch=a.catalogue_branch)} if a.catalogue_branch else {}),
    }
    pod = None
    for gpu in a.gpu:
        body = {
            "name": POD_NAME,
            "image": a.image,
            "gpu": {"id": gpu, "count": 1, "minCudaVersion": MIN_CUDA,
                    **({"minRamPerGpu": a.min_ram} if a.min_ram else {})},
            "cloud": a.cloud,
            "dataCenterIds": [volume["dataCenter"]],
            "disk": a.disk,
            "mounts": {"network": [{"volumeId": volume["id"], "path": "/data"}]},
            "env": pod_env,
            "ports": ["3000/http"],
        }
        try:
            pod = rp.call("POST", "/pods", json=body)
            break
        except RuntimeError as exc:
            print(f"{gpu}: not available in {volume['dataCenter']} ({str(exc)[:160]})", flush=True)
    if not pod:
        sys.exit(f"no GPU from {a.gpu} could be allocated in {volume['dataCenter']}; try `gpus` and --gpu")

    print(f"pod {pod['id']}: {pod.get('gpu', {}).get('id')} in {pod.get('dataCenterId')}, "
          f"{pod.get('gpu', {}).get('memory', '?')} GB RAM, ${pod.get('cost', '?')}/h, image {a.image}", flush=True)
    if a.idle_minutes:
        print(f"it terminates itself after {a.idle_minutes} idle minutes; `down` stops it sooner", flush=True)
    (HERE / ".pod").write_text(pod["id"] + "\n")

    url = public_url(env, pod["id"])
    stop = threading.Event()
    threading.Thread(target=follow_logs, args=(rp, pod["id"], stop), daemon=True).start()
    deadline = time.time() + a.wait * 60
    try:
        while time.time() < deadline:
            if healthy(url):
                break
            status = next((p["status"] for p in rp.pods() if p["id"] == pod["id"]), "TERMINATED")
            if status in ("EXITED", "ERROR", "TERMINATED"):
                stop.set()
                sys.exit(f"pod {status.lower()}; see the log above")
            time.sleep(10)
        else:
            stop.set()
            sys.exit(f"Pepper did not answer at {url} within {a.wait} min; the pod is still running "
                     "(`logs` to watch it, `down` to stop it)")
    except KeyboardInterrupt:
        stop.set()
        print(f"\nleft pod {pod['id']} running; `down` to stop it")
        return
    stop.set()
    banner = f"  Pepper is up: {url}  (MCP: {url}/mcp)"
    print("\n" + "=" * (len(banner) + 2) + f"\n{banner}\n" + "=" * (len(banner) + 2) + "\n", flush=True)


def cmd_status(rp: RunPod, env: dict, a) -> None:
    pods = rp.pods()
    if not pods:
        print("no pepper pod")
    for p in pods:
        print(f"{p['id']}: {p['status']}, {p.get('gpu', {}).get('id')} in {p.get('dataCenterId')}, "
              f"${p.get('cost', '?')}/h, started {p.get('startedAt') or '-'}")
        url = public_url(env, p["id"])
        print(f"  {url}: {'up' if healthy(url) else 'not answering'}")


def cmd_logs(rp: RunPod, env: dict, a) -> None:
    pods = rp.pods()
    if not pods:
        sys.exit("no pepper pod")
    stop = threading.Event()
    try:
        follow_logs(rp, pods[0]["id"], stop, tail=a.tail)
    except KeyboardInterrupt:
        stop.set()


def cmd_down(rp: RunPod, env: dict, a) -> None:
    pods = rp.pods()
    if not pods:
        print("no pepper pod")
    for p in pods:
        rp.call("DELETE", f"/pods/{p['id']}")
        print(f"terminated {p['id']} (the network volume and its models are kept)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    g = sub.add_parser("gpus", help="GPU types, prices and where they are available")
    g.add_argument("--all", action="store_true", help="include types with no availability")

    v = sub.add_parser("volume", help="create (or show) the network volume models live on")
    v.add_argument("--name", default=VOLUME_NAME)
    v.add_argument("--size", type=int, default=100, help="GB (billed monthly until deleted)")
    v.add_argument("--datacenter", help="default: where the preferred GPUs are most available")
    v.add_argument("--gpu", action="append", help="preferred GPU (repeatable); default: " + ", ".join(DEFAULT_GPUS))
    v.add_argument("--yes", action="store_true", help="do not ask for confirmation")

    u = sub.add_parser("up", help="start a pod and wait until Pepper answers")
    u.add_argument("--gpu", action="append", help="GPU type, in order of preference (repeatable)")
    u.add_argument("--image", default=IMAGE)
    u.add_argument("--volume", default=VOLUME_NAME)
    u.add_argument("--cloud", default="SECURE", choices=["SECURE", "COMMUNITY"])
    u.add_argument("--disk", type=int, default=30, help="container disk, GB (outputs live here)")
    u.add_argument("--min-ram", type=int, metavar="GB",
                   help="only hosts with at least this much system RAM per GPU (4090 pods are often 46 GB; "
                        "with CPU offload a model's whole weight set lives there)")
    u.add_argument("--idle-minutes", type=int, default=30, help="terminate after this long idle; 0 = never")
    u.add_argument("--catalogue-branch", metavar="BRANCH", help="serve the catalogue from this pepper-catalogue branch")
    u.add_argument("--wait", type=int, default=25, help="minutes to wait for Pepper to answer")
    u.add_argument("--force", action="store_true", help="start even if Pepper is already answering")

    sub.add_parser("status", help="the pepper pod, its cost and whether Pepper answers")
    lg = sub.add_parser("logs", help="follow the pod's log")
    lg.add_argument("--tail", type=int, default=200)
    sub.add_parser("down", help="terminate the pepper pod (keeps the volume)")

    a = ap.parse_args()
    if getattr(a, "gpu", None) is None and a.command in ("up", "volume"):
        a.gpu = DEFAULT_GPUS
    env = load_env()
    if not env.get("RUNPOD_API_KEY"):
        sys.exit(f"no RUNPOD_API_KEY in {ENV_FILES[0]} or the environment")
    rp = RunPod(env["RUNPOD_API_KEY"])
    {"gpus": cmd_gpus, "volume": cmd_volume, "up": cmd_up, "status": cmd_status,
     "logs": cmd_logs, "down": cmd_down}[a.command](rp, env, a)


if __name__ == "__main__":
    main()
