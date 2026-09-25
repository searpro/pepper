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

    install_tools()
    checkout()

    # The build needs dev dependencies; production mode is for the server only.
    build({**env, "NODE_ENV": "development"})

    server = subprocess.Popen(["node", "dist/index.js"], cwd=f"{SRC}/server", env=env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    threading.Thread(target=forward, args=(server, "[pepper]"), daemon=True).start()
    wait_healthy(server)
    log("pepper is healthy")

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
