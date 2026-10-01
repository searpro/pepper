#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["requests"]
# ///
"""Run Pepper on a Vast.ai GPU instance, at the same fixed hostname as on RunPod and Kaggle.

    uv run deploy/vastai/launch.py gpus                 # offers right now: GPU, $/h, RAM, where
    uv run deploy/vastai/launch.py up                   # rent one (or restart the stopped one); streams its log
    uv run deploy/vastai/launch.py status
    uv run deploy/vastai/launch.py logs                 # follow the instance's log
    uv run deploy/vastai/launch.py down                 # stop it: no GPU billing, the disk and its models stay
    uv run deploy/vastai/launch.py down --destroy       # delete it, models and all
    uv run deploy/vastai/launch.py up --product pro --tier 32gb   # Pepper Pro (ComfyUI recipes)

Like the RunPod launcher, an instance runs the published image
(ghcr.io/searpro/pepper, or pepper-pro for `--product pro`, built by CI from
main): push first, and wait for the image workflow.

Vast's volumes live on one machine, just like an instance's own disk, so
there is no separate volume here: models download onto the instance's disk
(`--disk`), and a stopped instance keeps them. Stopping (by `down`, or by the
container itself after `--idle-minutes`) ends GPU billing and leaves only the
disk's storage charge; `up` starts the same instance again, on the same
machine, once its GPU is free. `up --fresh` rents a new machine instead.

Configuration comes from `deploy/vastai/.env` (git-ignored), falling back to
`deploy/runpod/.env` and `deploy/kaggle/.env` for the PEPPER_* values they
share, and the process environment beats all three:

    VAST_API_KEY=...          cloud.vast.ai → Account → Keys (or VAST_AI_API_KEY, or the CLI's ~/.config/vastai/vast_api_key)
    PEPPER_API_TOKEN=...      required
    PEPPER_TUNNEL_TOKEN=...   with PEPPER_HOSTNAME: serve at a fixed hostname
    PEPPER_HOSTNAME=...

Vast has no secret store, so the two tokens are passed as the instance's
environment, which only your account can see. Nothing is printed.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import threading
import time
from pathlib import Path

import requests

API = "https://console.vast.ai/api/v0"
# Listing instances moved to v1 (v0 answers 410); everything else is still v0.
API_V1 = "https://console.vast.ai/api/v1"
HERE = Path(__file__).resolve().parent
ENV_FILES = [HERE / ".env", HERE.parent / "runpod" / ".env", HERE.parent / "kaggle" / ".env"]
KEY_FILES = [Path.home() / ".config" / "vastai" / "vast_api_key", Path.home() / ".vast_api_key"]
IMAGE = "ghcr.io/searpro/pepper:latest"
PRO_IMAGE = "ghcr.io/searpro/pepper-pro:latest"
LABEL = "pepper"
CATALOGUE_RAW = "https://raw.githubusercontent.com/searpro/pepper-catalogue/{branch}/pepper-catalogue.json"
# Vast's GPU names, first choice first; the RunPod launcher has the reasons.
DEFAULT_GPUS = ["RTX 4090", "RTX A5000", "RTX 3090", "L4", "RTX A6000"]
# Pepper Pro's hardware tiers (apps/pepper-pro/server/src/config.ts): the GPUs
# to ask for, the least VRAM that counts (some 4090s on Vast are 48 GB
# rebuilds, which is fine), and the host RAM a tier's recipes assume.
PRO_TIERS = {
    "24gb-64ram": (["RTX 4090", "RTX A5000", "RTX 3090"], 23, 62),
    "32gb": (["RTX 5090", "RTX PRO 4500", "RTX 5000Ada"], 31, 62),
    "48gb": (["L40S", "RTX 6000Ada", "RTX A6000", "RTX PRO 5000", "L40"], 44, 90),
    "96gb": (["RTX PRO 6000 S", "RTX PRO 6000 WS", "RTX PRO 6000 Max-Q", "H100 NVL", "H100 SXM"], 79, 120),
}
# The backend releases bundle CUDA 12 runtimes, which need a 12.x driver.
MIN_CUDA = 12.4
SECRET_KEYS = ("PEPPER_API_TOKEN", "PEPPER_TUNNEL_TOKEN")
# The image's CMD. Vast's "args" launch mode keeps the image's ENTRYPOINT
# (tini) and runs these as its arguments; the ssh and jupyter modes would
# replace the entrypoint with their own.
ARGS = ["node", "deploy/runpod/entrypoint.mjs"]


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
    for key in ("VAST_API_KEY", *SECRET_KEYS, "PEPPER_HOSTNAME"):
        if os.environ.get(key):
            values[key] = os.environ[key]
    # Both spellings are in use; VAST_API_KEY is the one Vast's own docs give.
    if not values.get("VAST_API_KEY"):
        values["VAST_API_KEY"] = os.environ.get("VAST_AI_API_KEY") or values.get("VAST_AI_API_KEY", "")
    if not values.get("VAST_API_KEY"):
        for path in KEY_FILES:
            if path.exists() and path.read_text().strip():
                values["VAST_API_KEY"] = path.read_text().strip()
                break
    return {k: v for k, v in values.items() if v}


class Vast:
    def __init__(self, key: str | None) -> None:
        self.session = requests.Session()
        if key:
            self.session.headers["Authorization"] = f"Bearer {key}"

    def call(self, method: str, path: str, base: str = API, **kwargs):
        r = self.session.request(method, f"{base}{path}", timeout=60, **kwargs)
        if r.status_code >= 400:
            raise RuntimeError(f"{method} {path} → {r.status_code}: {r.text[:500]}")
        body = r.json() if r.content else None
        if isinstance(body, dict) and body.get("success") is False:
            raise RuntimeError(f"{method} {path}: {body.get('msg') or body.get('error') or body}")
        return body

    def instances(self) -> list[dict]:
        listed = self.call("GET", "/instances/", base=API_V1)
        return [i for i in listed.get("instances", []) if i.get("label") == LABEL]

    def instance(self, instance_id: int) -> dict | None:
        return next((i for i in self.instances() if i["id"] == instance_id), None)

    def offers(self, gpus: list[str] | None, min_vram: int, min_ram: int | None, disk: int,
               verified: bool, direct_port: bool, limit: int = 200) -> list[dict]:
        """On-demand single-GPU offers, cheapest first, priced with `disk` GB of storage."""
        query = {
            "rentable": {"eq": True},
            "num_gpus": {"eq": 1},
            "gpu_ram": {"gte": min_vram * 1000},
            "cuda_max_good": {"gte": MIN_CUDA},
            "disk_space": {"gte": disk},
            # Model sets are tens of GB; a slow link makes the first boot take hours.
            "inet_down": {"gte": 200},
            "reliability": {"gte": 0.97},
            "allocated_storage": disk,
            "order": [["dph_total", "asc"]],
            "type": "ondemand",
            "limit": limit,
        }
        if gpus:
            query["gpu_name"] = {"in": gpus}
        if min_ram:
            query["cpu_ram"] = {"gte": min_ram * 1000}
        if verified:
            query["verified"] = {"eq": True}
        if direct_port:
            query["direct_port_count"] = {"gte": 1}
        listed = self.call("POST", "/bundles/", json=query)
        return listed.get("offers", []) if isinstance(listed, dict) else listed


# Vast's status message follows the image pull layer by layer; only the
# "Pulling from" and "Status:" lines say anything.
PULL_NOISE = re.compile(r"^[0-9a-f]{12}: (Pulling fs layer|Waiting|Downloading|Verifying Checksum|"
                        r"Download complete|Extracting|Pull complete|Already exists)")


def healthy(url: str | None) -> bool:
    if not url:
        return False
    try:
        return requests.get(f"{url}/health", timeout=8).ok
    except requests.RequestException:
        return False


def public_url(env: dict[str, str], inst: dict | None = None) -> str | None:
    if env.get("PEPPER_HOSTNAME") and env.get("PEPPER_TUNNEL_TOKEN"):
        return f"https://{env['PEPPER_HOSTNAME']}"
    # Without the tunnel, Pepper is reached through the port Vast mapped to 3000.
    ports = ((inst or {}).get("ports") or {}).get("3000/tcp") or []
    if inst and inst.get("public_ipaddr") and ports:
        return f"http://{inst['public_ipaddr'].strip()}:{ports[0]['HostPort']}"
    return None


def describe(inst: dict) -> str:
    ram = inst.get("cpu_ram")
    return (f"{inst['id']}: {inst.get('actual_status') or 'starting'} (wants {inst.get('intended_status')}), "
            f"{inst.get('gpu_name')} {round((inst.get('gpu_ram') or 0) / 1000)} GB, "
            f"{round(ram / 1000) if ram else '?'} GB RAM, {inst.get('geolocation') or '?'}, "
            f"${inst.get('dph_total', 0):.3f}/h, {inst.get('disk_space', '?')} GB disk")


# --- Commands -------------------------------------------------------------------


def cmd_gpus(vast: Vast, env: dict, a) -> None:
    offers = vast.offers(None if a.all else a.gpu, a.min_vram, a.min_ram, a.disk, not a.unverified, False, limit=1000)
    by_gpu: dict[str, list[dict]] = {}
    for o in offers:
        by_gpu.setdefault(o["gpu_name"], []).append(o)
    print(f"{'GPU':22} {'VRAM':>5} {'offers':>6} {'from $/h':>8} {'RAM GB':>11}  where (cheapest first)")
    for name, rows in sorted(by_gpu.items(), key=lambda kv: (kv[1][0]["gpu_ram"], kv[1][0]["dph_total"])):
        rams = [round(o["cpu_ram"] / 1000) for o in rows]
        where = ", ".join(dict.fromkeys((o.get("geolocation") or "?").split(",")[-1].strip() for o in rows))
        print(f"{name:22} {round(rows[0]['gpu_ram'] / 1000):>4}G {len(rows):>6} {rows[0]['dph_total']:>8.3f} "
              f"{min(rams):>5}-{max(rams):<5}  {where[:60]}")
    if not by_gpu:
        print("no offers match; try --all, --unverified or a smaller --min-ram")
    print(f"\nprices include {a.disk} GB of disk; `up` takes the cheapest offer of the first GPU that has one")


def follow_logs(vast: Vast, instance_id: int, stop: threading.Event, tail: int = 200) -> None:
    """Print the instance's log until `stop` is set. Vast serves a log as a
    snapshot of its tail, so this polls and prints only the lines past the
    overlap with the previous snapshot."""
    previous: list[str] = []
    while not stop.is_set():
        try:
            ref = vast.call("PUT", f"/instances/request_logs/{instance_id}/", json={"tail": str(tail)})
            url = (ref or {}).get("result_url")
            lines: list[str] | None = None
            # The snapshot is written a moment after the request.
            for _ in range(20):
                if not url or stop.is_set():
                    break
                r = requests.get(url, timeout=30)
                if r.ok:
                    lines = r.text.splitlines()
                    # Docker's answer while the image is still being pulled, not a log.
                    if any("No such container" in line for line in lines[:2]):
                        lines = None
                    break
                time.sleep(1)
            if lines is not None:
                overlap = next((k for k in range(min(len(previous), len(lines)), 0, -1)
                                if lines[:k] == previous[-k:]), 0)
                for line in lines[overlap:]:
                    print(f"[instance] {line.rstrip()}", flush=True)
                previous = lines
        except (requests.RequestException, RuntimeError):
            pass
        stop.wait(10)


def pick_and_create(vast: Vast, a, inst_env: dict[str, str], direct_port: bool) -> int:
    offers = vast.offers(a.gpu, a.min_vram, a.min_ram, a.disk, not a.unverified, direct_port)
    # Preference order first, then price: the list is a ranking, not a set.
    rank = {g: i for i, g in enumerate(a.gpu)}
    offers.sort(key=lambda o: (rank.get(o["gpu_name"], len(rank)), o["dph_total"]))
    if a.max_price:
        offers = [o for o in offers if o["dph_total"] <= a.max_price]
    if not offers:
        sys.exit(f"no offer for {a.gpu} with ≥{a.min_ram or 0} GB RAM and {a.disk} GB disk; "
                 "try `gpus`, --gpu, --min-ram or --unverified")
    body = {
        "client_id": "me",
        "image": a.image,
        "label": LABEL,
        "disk": a.disk,
        "runtype": "args",
        "args": ARGS,
        "env": inst_env,
        "cancel_unavail": True,
    }
    for offer in offers[:5]:
        try:
            created = vast.call("PUT", f"/asks/{offer['id']}/", json=body)
        except RuntimeError as exc:
            print(f"offer {offer['id']} ({offer['gpu_name']}): not rented ({str(exc)[:160]})", flush=True)
            continue
        print(f"rented offer {offer['id']}: {offer['gpu_name']} in {offer.get('geolocation') or '?'}, "
              f"{round(offer['cpu_ram'] / 1000)} GB RAM, ${offer['dph_total']:.3f}/h", flush=True)
        return int(created["new_contract"])
    sys.exit("none of the five cheapest offers could be rented; try again, or widen --gpu")


def cmd_up(vast: Vast, env: dict, a) -> None:
    if not env.get("PEPPER_API_TOKEN"):
        sys.exit("no PEPPER_API_TOKEN in deploy/vastai/.env, deploy/runpod/.env, deploy/kaggle/.env or the environment")
    if bool(env.get("PEPPER_TUNNEL_TOKEN")) != bool(env.get("PEPPER_HOSTNAME")):
        sys.exit("set both PEPPER_TUNNEL_TOKEN and PEPPER_HOSTNAME, or neither")
    tunnel = bool(env.get("PEPPER_TUNNEL_TOKEN"))

    # One instance per hostname: two connectors on one tunnel split traffic
    # between them at random, whatever platform each runs on.
    url = public_url(env)
    if url and healthy(url) and not a.force:
        sys.exit(f"{url} is already serving (RunPod, Kaggle, or another instance). Stop it first, or pass --force.")

    existing = vast.instances()
    if existing and a.fresh:
        for inst in existing:
            vast.call("DELETE", f"/instances/{inst['id']}/")
            print(f"destroyed {inst['id']} (--fresh)", flush=True)
        existing = []
    if existing:
        inst = existing[0]
        if inst.get("intended_status") == "running" and not a.force:
            sys.exit(f"the '{LABEL}' instance is already running ({describe(inst)}); `down` first, or pass --force")
        # A stopped instance comes back on the same machine with its disk, so
        # its models are already there. Its GPU may be rented by someone else
        # meanwhile; Vast then holds it until the GPU frees up.
        vast.call("PUT", f"/instances/{inst['id']}/", json={"state": "running"})
        instance_id = inst["id"]
        print(f"starting the stopped instance {describe(inst)}", flush=True)
        print("its environment is the one it was created with; `up --fresh` to change image, tier or tokens", flush=True)
    else:
        inst_env = {
            **{key: env[key] for key in SECRET_KEYS if env.get(key)},
            "PEPPER_IDLE_MINUTES": str(a.idle_minutes),
            # The disk is a quota that the filesystem may not report, so Pepper
            # is told its size and refuses downloads that would overrun it.
            "DATA_VOLUME_GB": str(a.disk),
            **({"PEPPER_HOSTNAME": env["PEPPER_HOSTNAME"]} if tunnel else {}),
            **({"CATALOGUE_URL": CATALOGUE_RAW.format(branch=a.catalogue_branch)} if a.catalogue_branch else {}),
            **({"PEPPER_TIER": a.tier} if a.product == "pro" else {}),
            # Docker's port flag, the way Vast takes it: only needed without the tunnel.
            **({} if tunnel else {"-p 3000:3000": "1"}),
        }
        instance_id = pick_and_create(vast, a, inst_env, direct_port=not tunnel)
        print(f"instance {instance_id}, image {a.image}, {a.disk} GB disk", flush=True)
    if a.idle_minutes:
        print(f"it stops itself after {a.idle_minutes} idle minutes; `down` stops it sooner", flush=True)
    (HERE / ".instance").write_text(f"{instance_id}\n")

    stop = threading.Event()
    threading.Thread(target=follow_logs, args=(vast, instance_id, stop), daemon=True).start()
    deadline = time.time() + a.wait * 60
    last_msg = None
    try:
        while time.time() < deadline:
            inst = vast.instance(instance_id)
            if inst is None:
                stop.set()
                sys.exit("the instance is gone (destroyed, or the offer was withdrawn)")
            url = public_url(env, inst)
            if healthy(url):
                break
            msg = (inst.get("status_msg") or "").strip()
            if msg and msg != last_msg and not PULL_NOISE.match(msg):
                print(f"[vast] {inst.get('actual_status') or 'starting'}: {msg[:200]}", flush=True)
                last_msg = msg
            if inst.get("actual_status") == "exited" and inst.get("intended_status") == "running":
                stop.set()
                sys.exit("the container exited; see the log above (`down --destroy` to remove it)")
            time.sleep(10)
        else:
            stop.set()
            sys.exit(f"Pepper did not answer within {a.wait} min; the instance is still running "
                     "(`logs` to watch it, `down` to stop it)")
    except KeyboardInterrupt:
        stop.set()
        print(f"\nleft instance {instance_id} running; `down` to stop it")
        return
    stop.set()
    banner = f"  Pepper is up: {url}  (MCP: {url}/mcp)"
    print("\n" + "=" * (len(banner) + 2) + f"\n{banner}\n" + "=" * (len(banner) + 2) + "\n", flush=True)


def cmd_status(vast: Vast, env: dict, a) -> None:
    found = vast.instances()
    if not found:
        print(f"no '{LABEL}' instance")
    for inst in found:
        print(describe(inst))
        if inst.get("status_msg"):
            print(f"  {inst['status_msg'].strip()[:200]}")
        url = public_url(env, inst)
        if url:
            print(f"  {url}: {'up' if healthy(url) else 'not answering'}")


def cmd_logs(vast: Vast, env: dict, a) -> None:
    found = vast.instances()
    if not found:
        sys.exit(f"no '{LABEL}' instance")
    stop = threading.Event()
    try:
        follow_logs(vast, found[0]["id"], stop, tail=a.tail)
    except KeyboardInterrupt:
        stop.set()


def cmd_down(vast: Vast, env: dict, a) -> None:
    found = vast.instances()
    if not found:
        print(f"no '{LABEL}' instance")
    for inst in found:
        if a.destroy:
            vast.call("DELETE", f"/instances/{inst['id']}/")
            print(f"destroyed {inst['id']}, and its disk with the models on it")
        else:
            vast.call("PUT", f"/instances/{inst['id']}/", json={"state": "stopped"})
            print(f"stopped {inst['id']}: no GPU billing; its {inst.get('disk_space', '?')} GB disk is kept "
                  "(and billed) for the next `up`; `down --destroy` deletes it")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    def offer_filters(p: argparse.ArgumentParser) -> None:
        p.add_argument("--gpu", action="append", help="GPU name as Vast spells it, in order of preference (repeatable)")
        p.add_argument("--product", default="pepper", choices=["pepper", "pro"],
                       help="pro: Pepper Pro's image, GPUs and RAM for --tier")
        p.add_argument("--tier", default="24gb-64ram", choices=list(PRO_TIERS), help="Pepper Pro's hardware tier")
        p.add_argument("--min-ram", type=int, metavar="GB", help="only hosts giving at least this much system RAM")
        p.add_argument("--disk", type=int, default=150,
                       help="instance disk, GB: models, outputs and everything else live here")
        p.add_argument("--unverified", action="store_true", help="include hosts Vast has not verified")

    g = sub.add_parser("gpus", help="offers right now: GPU types, prices, RAM and where")
    offer_filters(g)
    g.add_argument("--all", action="store_true", help="every GPU with enough VRAM, not just the preferred ones")

    u = sub.add_parser("up", help="rent an instance (or restart the stopped one) and wait until Pepper answers")
    offer_filters(u)
    u.add_argument("--image", help=f"default: {IMAGE}, or {PRO_IMAGE} for --product pro")
    u.add_argument("--max-price", type=float, metavar="USD", help="most to pay per hour, disk included")
    u.add_argument("--idle-minutes", type=int, default=30, help="stop after this long idle; 0 = never")
    u.add_argument("--catalogue-branch", metavar="BRANCH", help="serve the catalogue from this pepper-catalogue branch")
    u.add_argument("--wait", type=int, default=30, help="minutes to wait for Pepper to answer")
    u.add_argument("--fresh", action="store_true", help="destroy the stopped instance and rent a new one")
    u.add_argument("--force", action="store_true", help="start even if Pepper is already answering")

    sub.add_parser("status", help="the pepper instance, its cost and whether Pepper answers")
    lg = sub.add_parser("logs", help="follow the instance's log")
    lg.add_argument("--tail", type=int, default=200)
    d = sub.add_parser("down", help="stop the pepper instance (keeps its disk)")
    d.add_argument("--destroy", action="store_true", help="delete the instance and its disk instead")

    a = ap.parse_args()
    if a.command in ("gpus", "up"):
        pro = a.product == "pro"
        gpus, vram, ram = PRO_TIERS[a.tier] if pro else (DEFAULT_GPUS, 20, None)
        a.gpu = a.gpu or gpus
        a.min_vram = vram
        if a.min_ram is None:
            a.min_ram = ram
        if a.command == "up":
            a.image = a.image or (PRO_IMAGE if pro else IMAGE)
    env = load_env()
    key = env.get("VAST_API_KEY")
    # Searching offers needs no account; everything else does.
    if not key and a.command != "gpus":
        sys.exit(f"no VAST_API_KEY in {ENV_FILES[0]}, the environment or {KEY_FILES[0]}")
    vast = Vast(key)
    {"gpus": cmd_gpus, "up": cmd_up, "status": cmd_status, "logs": cmd_logs, "down": cmd_down}[a.command](vast, env, a)


if __name__ == "__main__":
    main()
