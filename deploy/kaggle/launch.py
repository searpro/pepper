#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["requests"]
# ///
"""Run Pepper on a Kaggle GPU behind a Cloudflare quick tunnel.

    uv run deploy/kaggle/launch.py                 # 2x T4, up for 6 hours
    uv run deploy/kaggle/launch.py --hours 11 --accel p100

Pushes `kernel.py` as a private Kaggle script kernel that builds and serves
the commit checked out here (plus any uncommitted changes), then streams its
log and prints the public URL once Pepper is up.

A batch kernel's log is only readable after it has finished, so this opens a
second quick tunnel, to a small receiver on this machine, and the kernel
posts its log and URL there. Stopping this script (Ctrl-C) leaves the kernel
running; cancel it from the Kaggle page to stop it early.

Needs `cloudflared` on PATH and the Kaggle API token in ~/.kaggle/kaggle.json
(kaggle.com/settings → API → Create New Token). The token is never printed.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import requests

API = "https://www.kaggle.com/api/v1"
CREDS = Path.home() / ".kaggle" / "kaggle.json"
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
REPO = "https://github.com/searpro/pepper.git"
SLUG = "pepper-server"

ACCELERATORS = {"t4": "nvidiaTeslaT4", "t4x2": "nvidiaTeslaT4x2", "p100": "nvidiaTeslaP100"}
DONE = {"complete", "error", "cancelled", "cancelAcknowledged"}


def auth() -> tuple[str, dict[str, str]]:
    if not CREDS.exists():
        sys.exit(f"no Kaggle token at {CREDS} — create one at kaggle.com/settings")
    c = json.loads(CREDS.read_text())
    token = base64.b64encode(f"{c['username']}:{c['key']}".encode()).decode()
    return c["username"], {"Authorization": f"Basic {token}"}


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(ROOT), *args], check=True, capture_output=True, text=True).stdout


def source() -> tuple[str, str]:
    """The commit to build and the uncommitted diff on top of it."""
    sha = git("rev-parse", "HEAD").strip()
    git("fetch", "-q", "origin")
    if not git("branch", "-r", "--contains", sha).strip():
        sys.exit(f"{sha[:7]} is not on origin — push it first so Kaggle can fetch it")
    untracked = git("ls-files", "--others", "--exclude-standard").split()
    if untracked:
        print(f"note: untracked files are not sent: {', '.join(untracked)}")
    return sha, git("diff", "--binary", "HEAD")


class Receiver(BaseHTTPRequestHandler):
    secret = ""
    url: str | None = None
    error: str | None = None
    done = threading.Event()
    got_url = threading.Event()

    def do_POST(self) -> None:
        if self.headers.get("X-Pepper-Secret") != self.secret:
            self.send_response(403)
            self.end_headers()
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        self.send_response(204)
        self.end_headers()
        for line in body.get("lines", []):
            print(line, flush=True)
        if body.get("url"):
            Receiver.url = body["url"]
            Receiver.got_url.set()
            banner = f"  Pepper is up: {body['url']}"
            print("\n" + "=" * (len(banner) + 2) + f"\n{banner}\n" + "=" * (len(banner) + 2) + "\n", flush=True)
            (HERE / ".last-url").write_text(body["url"] + "\n")
        if body.get("done"):
            Receiver.error = body.get("error")
            Receiver.done.set()

    def log_message(self, *_: object) -> None:
        pass


def open_receiver() -> tuple[ThreadingHTTPServer, subprocess.Popen, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tunnel = subprocess.Popen(
        ["cloudflared", "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{server.server_port}"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert tunnel.stdout
    for line in tunnel.stdout:
        match = re.search(r"https://[\w-]+\.trycloudflare\.com", line)
        if match:
            url = match.group(0)
            break
    else:
        sys.exit("cloudflared printed no URL for the receiver")
    threading.Thread(target=lambda: [None for _ in tunnel.stdout], daemon=True).start()
    # A fresh quick tunnel takes a few seconds to appear in DNS. Wait for it on
    # public DNS rather than by requesting it: a lookup made too early leaves a
    # cached NXDOMAIN on this machine that outlives the tunnel's arrival.
    host = url.removeprefix("https://")
    for _ in range(60):
        try:
            answer = requests.get("https://cloudflare-dns.com/dns-query", params={"name": host, "type": "A"},
                                  headers={"Accept": "application/dns-json"}, timeout=5).json()
            if answer.get("Answer"):
                return server, tunnel, url
        except (requests.RequestException, ValueError):
            pass
        time.sleep(2)
    sys.exit("receiver tunnel never became reachable")


def push(user: str, headers: dict[str, str], text: str, accel: str) -> None:
    body = {
        "slug": f"{user}/{SLUG}",
        "newTitle": SLUG,
        "text": text,
        "language": "python",
        "kernelType": "script",
        "isPrivate": True,
        "enableGpu": True,
        "enableInternet": True,
        "acceleratorType": ACCELERATORS[accel],
        "datasetDataSources": [],
        "competitionDataSources": [],
        "kernelDataSources": [],
        "modelDataSources": [],
        "categoryIds": [],
    }
    r = requests.post(f"{API}/kernels/push", headers=headers, json=body, timeout=60)
    r.raise_for_status()
    out = r.json()
    if out.get("error"):
        sys.exit(f"push rejected: {out['error']}")
    print(f"pushed {out.get('url')} (version {out.get('versionNumber')})", flush=True)


def status(user: str, headers: dict[str, str]) -> dict:
    r = requests.get(f"{API}/kernels/status", headers=headers,
                     params={"userName": user, "kernelSlug": SLUG}, timeout=30)
    return r.json() if r.ok else {}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hours", type=float, default=6, help="how long the server stays up (Kaggle caps a run at 12)")
    ap.add_argument("--accel", default="t4x2", choices=sorted(ACCELERATORS))
    ap.add_argument("--no-patch", action="store_true", help="build the commit only, without local changes")
    a = ap.parse_args()

    user, headers = auth()
    sha, diff = source()
    print(f"building {sha[:7]}" + (" + local changes" if diff and not a.no_patch else ""), flush=True)

    Receiver.secret = secrets.token_urlsafe(32)
    _, receiver_tunnel, receiver_url = open_receiver()

    config = {
        "repo": REPO,
        "commit": sha,
        "patch": "" if a.no_patch else base64.b64encode(diff.encode()).decode(),
        "hours": min(a.hours, 11.9),
        "receiver": receiver_url,
        "secret": Receiver.secret,
    }
    text = (HERE / "kernel.py").read_text().replace("CONFIG: dict = {}", f"CONFIG: dict = {json.dumps(config)}", 1)
    push(user, headers, text, a.accel)

    last = None
    try:
        while not Receiver.done.is_set():
            s = status(user, headers).get("status")
            if s and s != last:
                print(f"[kaggle] {s}", flush=True)
                last = s
            if s in DONE:
                break
            Receiver.done.wait(30)
    except KeyboardInterrupt:
        print(f"\nleft the kernel running{f' at {Receiver.url}' if Receiver.url else ''}; "
              f"stop it at https://www.kaggle.com/code/{user}/{SLUG}")
    finally:
        receiver_tunnel.terminate()
    if Receiver.error or last in {"error", "cancelled", "cancelAcknowledged"}:
        sys.exit(f"kernel failed: {Receiver.error or last}")


if __name__ == "__main__":
    main()
