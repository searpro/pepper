#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["requests"]
# ///
"""Run Pepper on your own GPU machine over SSH, at the same fixed hostname as on RunPod, Vast.ai and Kaggle.

    uv run deploy/home/launch.py up --product pro          # pull the published image and start it (tier 16gb)
    uv run deploy/home/launch.py up --product pro --build  # build this checkout, uncommitted changes too, on the host
    uv run deploy/home/launch.py status                    # containers, GPU, RAM, disk, whether Pepper answers
    uv run deploy/home/launch.py logs --product pro        # follow the container's log
    uv run deploy/home/launch.py down --product pro        # remove the container; its data stays
    uv run deploy/home/launch.py down --product pro --delete-data   # and the data (asks first)

The host runs Docker with the NVIDIA Container Toolkit (deploy/home/README.md
has the one-time setup). Each product is a Compose stack in its own folder,
`/srv/pepper` or `/srv/pepper-pro`: `compose.yaml`, a `.env` holding the
tokens (mode 600), and `data/`, mounted as the container's /data. So the
container is disposable and the data is a plain folder, which `down` keeps
and `down --delete-data` removes. Portainer, or `docker compose` in that
folder, manages the same stack.

There is nothing to bill, so there is no idle shutdown: the container
restarts with Docker until `down`. It holds the tunnel's hostname all that
time, so `down` here before `up` on RunPod, Vast.ai or Kaggle.

Configuration comes from `deploy/home/.env` (git-ignored), falling back to
`deploy/runpod/.env`, `deploy/vastai/.env` and `deploy/kaggle/.env` for the
PEPPER_* values they share, and the process environment beats all of them:

    PEPPER_HOME_HOST=user@host    the SSH destination (or pass --host)
    PEPPER_API_TOKEN=...          required
    PEPPER_TUNNEL_TOKEN=...       with PEPPER_HOSTNAME: serve at a fixed hostname
    PEPPER_HOSTNAME=...

The tokens reach the host over SSH's stdin, never a command line, and
nothing is printed.
"""

from __future__ import annotations

import argparse
import os
import shlex
import subprocess
import sys
import threading
import time
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
ENV_FILES = [HERE / ".env", HERE.parent / "runpod" / ".env", HERE.parent / "vastai" / ".env", HERE.parent / "kaggle" / ".env"]
CATALOGUE_RAW = "https://raw.githubusercontent.com/searpro/pepper-catalogue/{branch}/pepper-catalogue.json"
SECRET_KEYS = ("PEPPER_API_TOKEN", "PEPPER_TUNNEL_TOKEN")
STACKS_DIR = "/srv"
PORT = 3000
# Per product: the published image, the Dockerfile `--build` uses, and the
# name of its stack folder, container and locally built image.
PRODUCTS = {
    "pepper": {"image": "ghcr.io/searpro/pepper:latest", "dockerfile": "Dockerfile", "name": "pepper"},
    "pro": {"image": "ghcr.io/searpro/pepper-pro:latest", "dockerfile": "Dockerfile.pro", "name": "pepper-pro"},
}
# What the Dockerfiles copy. `--build` sends these, as git sees them (tracked
# and untracked files, without ignored ones such as data/ and node_modules/).
BUILD_PATHS = ["package.json", "package-lock.json", "packages", "apps", "deploy/runpod/entrypoint.mjs"]
TIERS = ["16gb", "24gb-64ram", "32gb", "48gb", "96gb"]

# shm_size: torch and some node packs share tensors through /dev/shm, which
# Docker otherwise caps at 64 MB. It is a tmpfs limit, so it costs RAM only
# while used.
COMPOSE = """\
# Written by deploy/home/launch.py on every `up`; edits here are overwritten.
# The tokens are in .env beside this file; the data is ./data, mounted as /data.
services:
  {name}:
    image: {image}
    container_name: {name}
    restart: unless-stopped
    env_file: .env
    ports:
      - "{port}:3000"
    volumes:
      - ./data:/data
    shm_size: 8gb
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
"""


def load_env() -> dict[str, str]:
    """The first file to define a key wins, and the process environment beats them all."""
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
    for key in ("PEPPER_HOME_HOST", *SECRET_KEYS, "PEPPER_HOSTNAME"):
        if os.environ.get(key):
            values[key] = os.environ[key]
    return {k: v for k, v in values.items() if v}


class Host:
    """The GPU machine, reached with the user's own SSH setup (keys, ~/.ssh/config)."""

    def __init__(self, dest: str) -> None:
        self.dest = dest
        # For URLs: the machine's name without the user part.
        self.name = dest.rsplit("@", 1)[-1]

    def argv(self, script: str, tty: bool = False) -> list[str]:
        # Keepalives: a connection lost to a sleeping laptop or a dropped
        # network otherwise hangs a quiet command (a --quiet pull) forever;
        # with them it fails after about a minute.
        return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
                *(["-tt"] if tty else []), self.dest, script]

    def run(self, script: str, input: str | None = None, check: bool = True) -> str:
        """Run a shell snippet on the host and return its output."""
        done = subprocess.run(self.argv(script), input=input, text=True, capture_output=True)
        if check and done.returncode != 0:
            raise SystemExit(f"on {self.dest}: {script.splitlines()[0][:80]} failed ({done.returncode}):\n"
                             f"{(done.stderr or done.stdout).strip()[-1500:]}")
        return done.stdout

    def stream(self, script: str, stdin=None, tty: bool = False) -> int:
        """Run a snippet with its output going straight to the terminal (pulls, builds).
        `tty` gives the far end a terminal, so Docker draws its progress bars;
        never with piped stdin, which a terminal would mangle."""
        return subprocess.run(self.argv(script, tty=tty), stdin=stdin).returncode


def healthy(url: str | None) -> bool:
    if not url:
        return False
    try:
        return requests.get(f"{url}/health", timeout=8).ok
    except requests.RequestException:
        return False


def public_url(env: dict[str, str]) -> str | None:
    if env.get("PEPPER_HOSTNAME") and env.get("PEPPER_TUNNEL_TOKEN"):
        return f"https://{env['PEPPER_HOSTNAME']}"
    return None


def stack_dir(product: str) -> str:
    return f"{STACKS_DIR}/{PRODUCTS[product]['name']}"


def container_state(host: Host, name: str) -> str | None:
    """running, restarting, exited… or None when there is no such container."""
    out = host.run(f"docker inspect -f '{{{{.State.Status}}}}' {shlex.quote(name)} 2>/dev/null || true").strip()
    return out or None


def gpu_neighbours(host: Host, mine: str) -> list[str]:
    """Other running containers that asked Docker for a GPU."""
    out = host.run("docker ps -q | xargs -r docker inspect -f '{{.Name}} {{len .HostConfig.DeviceRequests}}'")
    names = []
    for line in out.splitlines():
        name, _, count = line.strip().lstrip("/").partition(" ")
        if count.strip() not in ("", "0") and name != mine:
            names.append(name)
    return names


def check_host(host: Host) -> None:
    runtimes = host.run("docker info --format '{{json .Runtimes}}'", check=False)
    if not runtimes:
        sys.exit(f"cannot run docker on {host.dest} (is it installed, and is the user in the docker group?); "
                 "see deploy/home/README.md")
    if "nvidia" not in runtimes:
        sys.exit(f"Docker on {host.dest} has no nvidia runtime; install the NVIDIA Container Toolkit "
                 "(deploy/home/README.md)")


def build_on_host(host: Host, product: str, build_args: list[str]) -> str:
    """Send this checkout to the host and build the product's image there.

    Like Kaggle's launcher this runs uncommitted changes, with no push and no
    wait for CI. The context is what git lists under BUILD_PATHS, so models
    and node_modules never leave this machine. `build_args` are the
    Dockerfile's ARGs as KEY=VALUE, e.g. a CUDA 13 TORCH_INDEX, which a
    Blackwell card needs for NVFP4 kernels and the published image lacks.
    """
    spec = PRODUCTS[product]
    listed = subprocess.run(["git", "ls-files", "-z", "-co", "--exclude-standard", "--", *BUILD_PATHS, spec["dockerfile"]],
                            cwd=REPO, capture_output=True, check=True).stdout.decode()
    # Deleted but still tracked files are listed too; tar would stop at them.
    files = [f for f in listed.split("\0") if f and (REPO / f).is_file()]
    size = sum((REPO / f).stat().st_size for f in files)
    tag = f"{spec['name']}:local"
    print(f"building {tag} on {host.dest} from this checkout ({len(files)} files, {size / 1e6:.0f} MB before "
          "compression); the first build installs torch and ComfyUI and takes a while", flush=True)
    # COPYFILE_DISABLE: macOS tar would otherwise add AppleDouble `._` files.
    tar = subprocess.Popen(["tar", "-czf", "-", "--null", "-T", "-"], cwd=REPO, stdin=subprocess.PIPE,
                           stdout=subprocess.PIPE, env={**os.environ, "COPYFILE_DISABLE": "1"})
    assert tar.stdin and tar.stdout
    tar.stdin.write("\0".join(files).encode())
    tar.stdin.close()
    args = "".join(f" --build-arg {shlex.quote(arg)}" for arg in build_args)
    code = host.stream(f"docker build --progress=plain{args} -f {shlex.quote(spec['dockerfile'])} -t {tag} -", stdin=tar.stdout)
    tar.wait()
    if code != 0 or tar.returncode != 0:
        sys.exit(f"the build failed (docker build {code}, tar {tar.returncode}); see above")
    return tag


def follow_logs(host: Host, name: str, since: int, stop: threading.Event) -> subprocess.Popen:
    proc = subprocess.Popen(host.argv(f"docker logs -f --since {since} {shlex.quote(name)} 2>&1"),
                            stdout=subprocess.PIPE, text=True)

    def pump() -> None:
        assert proc.stdout
        for line in proc.stdout:
            if stop.is_set():
                break
            print(f"[home] {line.rstrip()}", flush=True)

    threading.Thread(target=pump, daemon=True).start()
    return proc


# --- Commands -------------------------------------------------------------------


def cmd_up(host: Host, env: dict, a) -> None:
    if not env.get("PEPPER_API_TOKEN"):
        sys.exit("no PEPPER_API_TOKEN in deploy/home/.env, the other launchers' .env files or the environment")
    if bool(env.get("PEPPER_TUNNEL_TOKEN")) != bool(env.get("PEPPER_HOSTNAME")):
        sys.exit("set both PEPPER_TUNNEL_TOKEN and PEPPER_HOSTNAME, or neither")
    if a.build_arg and not a.build:
        sys.exit("--build-arg only applies with --build")
    spec = PRODUCTS[a.product]
    name, directory = spec["name"], stack_dir(a.product)
    check_host(host)

    # Both products serve port 3000 and the one hostname.
    other = next(p for p in PRODUCTS if p != a.product)
    if container_state(host, PRODUCTS[other]["name"]) in ("running", "restarting"):
        sys.exit(f"{PRODUCTS[other]['name']} is running on {host.name}; `down --product {other}` first")
    # One instance per hostname: two connectors on one tunnel split traffic
    # between them at random, whatever platform each runs on. Our own running
    # container is the exception: `up` then updates it in place.
    mine_running = container_state(host, name) == "running"
    url = public_url(env)
    if url and healthy(url) and not mine_running and not a.force:
        sys.exit(f"{url} is already serving (RunPod, Vast.ai, Kaggle, or another machine). Stop it first, or pass --force.")

    neighbours = gpu_neighbours(host, name)
    if neighbours:
        used = host.run("nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader", check=False).strip()
        used = " of ".join(part.strip() for part in used.split(","))
        print(f"note: {', '.join(neighbours)} {'is' if len(neighbours) == 1 else 'are'} using the GPU ({used} taken), "
              f"so {name} may run out of VRAM. If a job fails for memory, stop "
              f"{'it' if len(neighbours) == 1 else 'them'} in Portainer or with `docker compose stop` in "
              f"{STACKS_DIR}/<name>.", flush=True)

    image = a.image or (build_on_host(host, a.product, a.build_arg) if a.build else spec["image"])
    settings = {
        **{key: env[key] for key in SECRET_KEYS if env.get(key)},
        **({"PEPPER_HOSTNAME": env["PEPPER_HOSTNAME"]} if url else {}),
        **({"PEPPER_TIER": a.tier} if a.product == "pro" else {}),
        **({"CATALOGUE_URL": CATALOGUE_RAW.format(branch=a.catalogue_branch)} if a.catalogue_branch else {}),
    }
    q = shlex.quote(directory)
    # umask 077: the .env is created readable by its owner only.
    host.run(f"umask 077 && mkdir -p {q}/data && cat > {q}/.env",
             input="".join(f"{k}={v}\n" for k, v in settings.items()))
    host.run(f"cat > {q}/compose.yaml", input=COMPOSE.format(name=name, image=image, port=PORT))

    local = image.endswith(":local")
    if not local:
        print(f"pulling {image} (the first pull of Pepper Pro is many GB)", flush=True)
        # Progress bars in a terminal; without one, Compose's line-per-update
        # output would run to thousands of lines, so stay quiet instead.
        interactive = sys.stdout.isatty()
        if host.stream(f"cd {q} && docker compose pull{'' if interactive else ' --quiet'}", tty=interactive) != 0:
            sys.exit("the pull failed; see above")
    since = int(host.run("date +%s").strip())
    host.run(f"cd {q} && docker compose up -d --remove-orphans{' --pull never' if local else ''} 2>&1")
    print(f"{'updated' if mine_running else 'started'} {name} on {host.name}: {image}, data in {directory}/data", flush=True)

    target = url or f"http://{host.name}:{PORT}"
    stop = threading.Event()
    logs = follow_logs(host, name, since, stop)
    deadline = time.time() + a.wait * 60
    down_since: float | None = None
    try:
        while time.time() < deadline:
            if healthy(target):
                break
            state = container_state(host, name)
            # The entrypoint exits when Pepper does and Docker restarts it, so a
            # crash shows as `restarting`; one that lasts is not a slow boot.
            if state != "running":
                down_since = down_since or time.time()
                if time.time() - down_since > 120:
                    sys.exit(f"{name} is {state}; see the log above (`logs` to keep watching, `down` to remove it)")
            else:
                down_since = None
            time.sleep(5)
        else:
            sys.exit(f"Pepper did not answer at {target} within {a.wait} min; the container is still running "
                     "(`logs` to watch it, `down` to remove it)")
    except KeyboardInterrupt:
        print(f"\nleft {name} running; `down` to remove it")
        return
    finally:
        stop.set()
        logs.terminate()
    banner = f"  Pepper is up: {target}  (MCP: {target}/mcp)"
    print("\n" + "=" * (len(banner) + 2) + f"\n{banner}\n" + "=" * (len(banner) + 2) + "\n", flush=True)
    if url:
        print(f"on your network it also answers at http://{host.name}:{PORT}")


def cmd_status(host: Host, env: dict, a) -> None:
    script = (
        "nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw "
        "--format=csv,noheader 2>/dev/null || echo 'no GPU visible'; "
        "free -g | awk '/^Mem:/ {print $3\" of \"$2\" GB RAM used\"}'; "
        f"df -h --output=avail {STACKS_DIR} | tail -1 | awk '{{print $1\" free on the disk\"}}'"
    )
    gpu, ram, disk = (host.run(script).strip().splitlines() + ["", "", ""])[:3]
    print(f"{host.name}: {gpu.strip()}\n  {ram}, {disk}")
    for product, spec in PRODUCTS.items():
        directory = stack_dir(product)
        if not host.run(f"test -f {shlex.quote(directory)}/compose.yaml && echo yes || true").strip():
            continue
        info = host.run(f"docker inspect -f '{{{{.State.Status}}}} since {{{{.State.StartedAt}}}}, {{{{.Config.Image}}}}' "
                        f"{spec['name']} 2>/dev/null || echo 'no container (down)'").strip()
        # du walks every file; a model folder takes a moment, so it is bounded.
        used = host.run(f"timeout 30 du -sh {shlex.quote(directory)}/data 2>/dev/null | cut -f1 || true").strip() or "?"
        print(f"{spec['name']} (--product {product}): {info}\n  data: {directory}/data, {used}")
    neighbours = gpu_neighbours(host, "")
    if neighbours:
        print(f"containers using the GPU: {', '.join(neighbours)}")
    for target in filter(None, [public_url(env), f"http://{host.name}:{PORT}"]):
        print(f"{target}: {'up' if healthy(target) else 'not answering'}")


def cmd_logs(host: Host, env: dict, a) -> None:
    name = PRODUCTS[a.product]["name"]
    # A terminal on the far end, so Ctrl-C stops `docker logs` there too.
    try:
        subprocess.run(host.argv(f"docker logs -f --tail {a.tail} {name}", tty=True))
    except KeyboardInterrupt:
        pass


def cmd_down(host: Host, env: dict, a) -> None:
    spec = PRODUCTS[a.product]
    q = shlex.quote(stack_dir(a.product))
    if not host.run(f"test -d {q} && echo yes || true").strip():
        sys.exit(f"no {spec['name']} stack on {host.name}")
    if a.delete_data:
        used = host.run(f"timeout 30 du -sh {q}/data 2>/dev/null | cut -f1 || true").strip() or "?"
        if not a.yes:
            answer = input(f"this deletes {stack_dir(a.product)}/data ({used}: models, database, outputs). "
                           f"Type {spec['name']} to confirm: ")
            if answer.strip() != spec["name"]:
                sys.exit("not deleted")
    host.run(f"cd {q} && test -f compose.yaml && docker compose down{' --rmi all' if a.delete_image else ''} 2>&1 || true")
    print(f"removed the {spec['name']} container" + (" and its image" if a.delete_image else ""))
    if a.delete_data:
        # The container writes as root, so its files are root's; a throwaway
        # container removes them without needing sudo on the host.
        host.run(f"docker run --rm -v {q}:/stack alpine:3 rm -rf /stack/data && rm -rf {q}")
        print(f"deleted {stack_dir(a.product)} and everything in it")
    else:
        print(f"its data is still in {stack_dir(a.product)}/data; the next `up` uses it again "
              "(`down --delete-data` removes it)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", help="SSH destination, e.g. user@gpu-box (default: PEPPER_HOME_HOST)")
    sub = ap.add_subparsers(dest="command", required=True)

    def product(p: argparse.ArgumentParser) -> None:
        p.add_argument("--product", default="pepper", choices=list(PRODUCTS), help="pro: Pepper Pro")

    u = sub.add_parser("up", help="start the product (or update it in place) and wait until Pepper answers")
    product(u)
    u.add_argument("--tier", default="16gb", choices=TIERS, help="Pepper Pro's hardware tier (default 16gb)")
    src = u.add_mutually_exclusive_group()
    src.add_argument("--image", help="image to run; default the product's published image")
    src.add_argument("--build", action="store_true", help="build this checkout on the host and run that")
    u.add_argument("--build-arg", action="append", default=[], metavar="KEY=VALUE",
                   help="with --build: a Dockerfile ARG (repeatable), e.g. "
                        "TORCH_INDEX=https://download.pytorch.org/whl/cu130")
    u.add_argument("--catalogue-branch", metavar="BRANCH", help="serve the catalogue from this pepper-catalogue branch")
    u.add_argument("--wait", type=int, default=20, help="minutes to wait for Pepper to answer once started")
    u.add_argument("--force", action="store_true", help="start even if the hostname already answers")

    sub.add_parser("status", help="containers, GPU, RAM, disk, and whether Pepper answers")
    lg = sub.add_parser("logs", help="follow the container's log")
    product(lg)
    lg.add_argument("--tail", type=int, default=200)
    d = sub.add_parser("down", help="remove the container; its data stays for the next `up`")
    product(d)
    d.add_argument("--delete-data", action="store_true", help="also delete the stack folder and its data (asks first)")
    d.add_argument("--delete-image", action="store_true", help="also remove the image from the host")
    d.add_argument("--yes", action="store_true", help="with --delete-data: do not ask")

    a = ap.parse_args()
    env = load_env()
    dest = a.host or env.get("PEPPER_HOME_HOST")
    if not dest:
        sys.exit("no host: pass --host user@machine, or set PEPPER_HOME_HOST in deploy/home/.env")
    {"up": cmd_up, "status": cmd_status, "logs": cmd_logs, "down": cmd_down}[a.command](Host(dest), env, a)


if __name__ == "__main__":
    main()
