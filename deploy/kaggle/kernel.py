"""Pepper on a Kaggle GPU — the script the Kaggle kernel runs.

Not run by hand: `launch.py` fills in CONFIG and pushes this as a private
script kernel. On Kaggle it

  1. installs Node 22 and cloudflared under /tmp,
  2. checks out the exact commit that was launched (plus the launcher's
     uncommitted diff, so what runs is what is on the laptop),
  3. builds the web app and the server,
  4. starts Pepper with DATA_DIR on /tmp — binaries, models, uploads and the
     database all download there (~60 GB writable, though df reports far more; /kaggle/working is the
     saved notebook output and capped at 20 GB),
  5. opens a Cloudflare quick tunnel to it, and
  6. stays up for CONFIG["hours"], then exits.

Two optional modes around that, both for keeping models between runs (Kaggle
only persists a kernel's /kaggle/working output, up to 20 GB, which other
kernels can mount read-only):

  - CONFIG["pack"]: build a model pack instead of serving. Pepper runs with
    DATA_DIR under /kaggle/working, installs the pack's models through its own
    API (so every model.json is exactly what Pepper writes), and the kernel
    exits keeping only models/ as its saved output.
  - CONFIG["packs"]: packs to mount. Before Pepper starts, each pack's bundles
    are rebuilt under DATA_DIR as real directories whose weight files are
    symlinks into /kaggle/input — Pepper lists bundle and slot directories
    without following symlinks, but reads files through them — and model.json
    is copied so it stays editable. The files are then read once in the
    background so the first generation is not a cold read over NFS.

A batch kernel's log is only readable once it has finished, so everything it
prints is also posted back to the launcher (through the launcher's own quick
tunnel, authenticated by a per-launch secret). That is how the tunnel URL
reaches the laptop while the server is still running. When the launcher is
gone those posts fail quietly and the kernel carries on.
"""

from __future__ import annotations

import base64
import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import urllib.request

CONFIG: dict = {}  # replaced by launch.py

TMP = "/tmp"
SRC = f"{TMP}/pepper"
DATA = f"{TMP}/pepper-data"
TOOLS = f"{TMP}/tools"
PACK_DATA = "/kaggle/working/pepper-data"
PORT = 3000
START = time.time()

# --- Reporting back to the launcher ------------------------------------------

_outbox: queue.Queue = queue.Queue()


def _post(payload: dict) -> None:
    receiver = CONFIG.get("receiver")
    if not receiver:
        return
    req = urllib.request.Request(
        receiver,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "X-Pepper-Secret": CONFIG["secret"]},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=10).read()
    except Exception:
        pass  # the launcher may be gone; the kernel's own log still has everything


def _drain(first: list[str]) -> list[str]:
    lines = first
    while not _outbox.empty() and len(lines) < 500:
        lines.append(_outbox.get())
    return lines


def _pump() -> None:
    while True:
        first = _outbox.get()
        time.sleep(1)
        _post({"lines": _drain([first])})


def finish(**payload) -> None:
    """The last post: whatever is still queued, then `done`, in one request so
    the launcher never sees the end before the lines that explain it."""
    time.sleep(1.5)
    _post({"lines": _drain([]), "done": True, **payload})


threading.Thread(target=_pump, daemon=True).start()


def log(line: str) -> None:
    line = f"[{time.time() - START:7.1f}s] {line.rstrip()}"
    print(line, flush=True)
    _outbox.put(line)


def sh(cmd: str, cwd: str | None = None, env: dict | None = None) -> None:
    log(f"$ {cmd}")
    proc = subprocess.Popen(cmd, shell=True, cwd=cwd, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert proc.stdout
    for line in proc.stdout:
        log(f"  {line}")
    if proc.wait():
        raise SystemExit(f"failed ({proc.returncode}): {cmd}")


# --- Setup --------------------------------------------------------------------


def install_tools() -> None:
    os.makedirs(TOOLS, exist_ok=True)
    # Kaggle ships Node 20; Pepper is built and run on 22 everywhere else.
    shasums = urllib.request.urlopen("https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt").read().decode()
    tarball = re.search(r"(node-v22[\d.]+-linux-x64\.tar\.xz)", shasums).group(1)
    sh(f"curl -fsSL https://nodejs.org/dist/latest-v22.x/{tarball} | tar -xJ -C {TOOLS} "
       f"&& ln -sfn {TOOLS}/{tarball.removesuffix('.tar.xz')} {TOOLS}/node")
    sh(f"curl -fsSL -o {TOOLS}/cloudflared "
       "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 "
       f"&& chmod +x {TOOLS}/cloudflared")
    sh("command -v ffmpeg git || (apt-get update -qq && apt-get install -y -qq ffmpeg git)")


def checkout() -> None:
    sha, repo = CONFIG["commit"], CONFIG["repo"]
    sh(f"git init -q {SRC} && git -C {SRC} fetch -q --depth 1 {repo} {sha} && git -C {SRC} checkout -q FETCH_HEAD")
    if CONFIG.get("patch"):
        with open(f"{TMP}/local.patch", "wb") as f:
            f.write(base64.b64decode(CONFIG["patch"]))
        sh(f"git -C {SRC} apply --whitespace=nowarn {TMP}/local.patch")


def build(env: dict) -> None:
    sh("node --version && npm --version", env=env)
    sh("npm ci --no-audit --no-fund", cwd=SRC, env=env)
    sh("npm run build", cwd=SRC, env=env)


# --- Run ----------------------------------------------------------------------


def forward(proc: subprocess.Popen, prefix: str, on_line=None) -> None:
    assert proc.stdout
    for line in proc.stdout:
        log(f"{prefix} {line}")
        if on_line:
            on_line(line)


def wait_healthy(server: subprocess.Popen) -> None:
    for _ in range(300):
        if server.poll() is not None:
            raise SystemExit(f"pepper exited during startup ({server.returncode})")
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2).read()
            return
        except Exception:
            time.sleep(2)
    raise SystemExit("pepper did not become healthy")


def api(method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as res:
        raw = res.read()
    return json.loads(raw) if raw else None


# --- Model packs --------------------------------------------------------------


def build_pack(server: subprocess.Popen) -> None:
    """Install CONFIG["pack"] into PACK_DATA, then keep only its models."""
    pack = CONFIG["pack"]
    for item in pack.get("catalogue", []):
        installed = api("POST", f"/v1/catalogue/{item['id']}/install",
                        {"selections": item["selections"], **({"bundle": item["bundle"]} if item.get("bundle") else {})})
        log(f"queued {item['id']} ({len(item['selections'])} files)")
        if item.get("manifest"):
            # Merged into the model.json the catalogue wrote, for entries whose
            # catalogue metadata is wrong for the backend.
            api("PUT", f"/v1/models/{installed['kind']}/{installed['bundle']}/manifest", item["manifest"])
            log(f"  manifest: {item['manifest']}")
    for item in pack.get("components", []):
        api("POST", f"/v1/models/{item['kind']}/{item['bundle']}/components",
            {"slot": item["slot"], "url": item["url"]})
        log(f"queued {item['kind']}/{item['bundle']} {item['slot']}")

    last = ""
    while True:
        if server.poll() is not None:
            raise SystemExit(f"pepper exited while downloading ({server.returncode})")
        tasks = api("GET", "/v1/downloads")["downloads"]
        pending = [t for t in tasks if t["status"] in ("queued", "downloading")]
        failed = [t for t in tasks if t["status"] in ("failed", "cancelled")]
        got = sum(t["received"] for t in tasks) / 1e9
        summary = f"{len(tasks) - len(pending)}/{len(tasks)} files, {got:.1f} GB"
        if summary != last:
            log(f"downloads: {summary}")
            last = summary
        if not pending:
            break
        time.sleep(20)
    if failed:
        raise SystemExit("downloads failed: " + ", ".join(f"{t['name']} ({t.get('error')})" for t in failed))

    server.terminate()
    server.wait(60)
    # Only models/ is the pack: the database, cache and logs are this run's.
    for entry in os.listdir(PACK_DATA):
        path = os.path.join(PACK_DATA, entry)
        if entry != "models":
            shutil.rmtree(path) if os.path.isdir(path) else os.remove(path)
    files = []
    for dirpath, _, names in os.walk(f"{PACK_DATA}/models"):
        for name in names:
            path = os.path.join(dirpath, name)
            if name.endswith((".part", ".part.json")):
                os.remove(path)
                continue
            files.append({"path": os.path.relpath(path, PACK_DATA), "size": os.path.getsize(path)})
    total = sum(f["size"] for f in files)
    with open(f"{PACK_DATA}/PACK.json", "w") as f:
        json.dump({"commit": CONFIG["commit"], "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   "bytes": total, "files": files}, f, indent=2)
    for item in files:
        log(f"  {item['size'] / 1e9:6.2f} GB  {item['path']}")
    log(f"pack complete: {len(files)} files, {total / 1e9:.1f} GB")


def pack_root(slug: str) -> str | None:
    user = CONFIG.get("user", "")
    direct = f"/kaggle/input/notebooks/{user}/{slug}/pepper-data/models"
    if os.path.isdir(direct):
        return direct
    for dirpath, dirs, _ in os.walk("/kaggle/input"):
        if os.path.basename(dirpath) == slug and "pepper-data" in dirs:
            return os.path.join(dirpath, "pepper-data", "models")
    return None


def link_packs() -> list[str]:
    """Rebuild each mounted pack's bundles under DATA as real directories of
    symlinked files. Returns the linked files, in pack order."""
    linked: list[str] = []
    for slug in CONFIG.get("packs", []):
        root = pack_root(slug)
        if not root:
            log(f"pack {slug}: not mounted (build it with --build-pack first); skipping")
            continue
        count = size = 0
        for dirpath, _, names in os.walk(root):
            target = os.path.join(DATA, "models", os.path.relpath(dirpath, root))
            os.makedirs(target, exist_ok=True)
            for name in names:
                src, dst = os.path.join(dirpath, name), os.path.join(target, name)
                if os.path.lexists(dst):
                    continue
                if name.endswith(".json"):
                    shutil.copyfile(src, dst)  # model.json stays editable
                else:
                    os.symlink(src, dst)
                    linked.append(src)
                    count += 1
                    size += os.path.getsize(src)
        log(f"pack {slug}: linked {count} files, {size / 1e9:.1f} GB")
    return linked


def warm(files: list[str], budget: float = 16e9) -> None:
    """Read pack files once so they sit in the page cache (31 GB of RAM on a
    Kaggle GPU box), turning the first load of each model from a ~190 MB/s
    NFS read into a memory copy."""
    started, done = time.time(), 0
    for path in files:
        size = os.path.getsize(path)
        if done + size > budget:
            break
        with open(path, "rb", buffering=0) as f:
            while f.read(16 << 20):
                pass
        done += size
    log(f"warmed {done / 1e9:.1f} GB of pack files in {time.time() - started:.0f}s")


def open_tunnel(env: dict) -> tuple[subprocess.Popen, str]:
    found: dict = {}
    ready = threading.Event()

    def on_line(line: str) -> None:
        match = re.search(r"https://[\w-]+\.trycloudflare\.com", line)
        if match and not found:
            found["url"] = match.group(0)
            ready.set()

    tunnel = subprocess.Popen(
        [f"{TOOLS}/cloudflared", "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{PORT}"],
        env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    threading.Thread(target=forward, args=(tunnel, "[tunnel]", on_line), daemon=True).start()
    if not ready.wait(120):
        raise SystemExit("cloudflared printed no URL")
    return tunnel, found["url"]


def main() -> None:
    log(f"GPU: {subprocess.run('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader', shell=True, capture_output=True, text=True).stdout.strip()}")
    log(f"/tmp free: {shutil.disk_usage(TMP).free / 1e9:.0f} GB")

    env = {
        **os.environ,
        "PATH": f"{TOOLS}/node/bin:{TOOLS}:{os.environ['PATH']}",
        "NODE_ENV": "production",
        "HOST": "127.0.0.1",
        "PORT": str(PORT),
        "ACCEL": "cuda",
        "AUTO_INSTALL_BACKENDS": "true",
        # Everything Pepper downloads lives under /tmp.
        "DATA_DIR": DATA,
        "OUTPUT_DIR": f"{TMP}/pepper-outputs",
        "HF_HOME": f"{TMP}/hf",
        "XDG_CACHE_HOME": f"{TMP}/cache",
        "npm_config_cache": f"{TMP}/npm-cache",
        "PIP_CACHE_DIR": f"{TMP}/pip-cache",
    }

    building_pack = bool(CONFIG.get("pack"))
    if building_pack:
        # Downloads land straight in the saved output; no binaries are needed
        # to download models.
        env.update({"DATA_DIR": PACK_DATA, "AUTO_INSTALL_BACKENDS": "false"})

    install_tools()
    checkout()

    # The build needs dev dependencies; production mode is for the server only.
    build({**env, "NODE_ENV": "development"})

    linked = [] if building_pack else link_packs()

    server = subprocess.Popen(["node", "dist/index.js"], cwd=f"{SRC}/server", env=env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    threading.Thread(target=forward, args=(server, "[pepper]"), daemon=True).start()
    wait_healthy(server)
    log("pepper is healthy")

    if building_pack:
        build_pack(server)
        finish()
        return
    if linked:
        threading.Thread(target=warm, args=(linked,), daemon=True).start()

    tunnel, url = open_tunnel(env)
    # Give the quick tunnel's DNS a moment so the URL works when it is shown.
    time.sleep(10)
    log(f"PEPPER URL: {url}")
    _post({"url": url})

    deadline = START + float(CONFIG.get("hours", 6)) * 3600
    while time.time() < deadline:
        if server.poll() is not None:
            raise SystemExit(f"pepper exited ({server.returncode})")
        if tunnel.poll() is not None:
            log("tunnel exited; reopening")
            tunnel, url = open_tunnel(env)
            log(f"PEPPER URL: {url}")
            _post({"url": url})
        time.sleep(15)
    log("time is up; shutting down")
    finish()


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exc:
        log(f"FATAL: {exc}")
        finish(error=str(exc))
        raise
