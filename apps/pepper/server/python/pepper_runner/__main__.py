"""``python -m pepper_runner <job.json>`` — run one generation job and exit.

Exit status 0 means the output file was written and a ``result`` line was
emitted; anything else is a failure whose ``error`` line carries the reason.
"""

from __future__ import annotations

import importlib
import os
import sys
import traceback

# Before torch is imported anywhere: let MPS fall back to CPU for the handful
# of ops it lacks rather than aborting, and never phone home for weights —
# every file a runner needs is already in the model bundle.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
# Progress reaches Pepper as protocol lines; tqdm's bars would arrive as
# hundreds of log lines per load (every carriage-return redraw is a line).
os.environ.setdefault("TQDM_DISABLE", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

from .common import Job, Timer, emit, stage  # noqa: E402
from .runners import RUNNERS  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m pepper_runner <job.json>", file=sys.stderr)
        return 2

    job = Job.load(argv[1])
    module_name = RUNNERS.get(job.runner)
    if not module_name:
        emit("error", message=f"Unknown runner '{job.runner}'. Known: {', '.join(sorted(RUNNERS))}")
        return 2

    # A runner that builds on a cloned upstream codebase (EchoMimicV3's src/)
    # imports it from the checkout, not from site-packages.
    if job.package_dir:
        sys.path.insert(0, job.package_dir)

    timer = Timer()
    try:
        stage("starting")
        result = importlib.import_module(module_name).run(job)
    except Exception as exc:  # the protocol line is how Pepper learns why
        traceback.print_exc()
        emit("error", message=f"{type(exc).__name__}: {exc}"[:1000])
        return 1

    if not os.path.exists(job.output) or os.path.getsize(job.output) == 0:
        emit("error", message="Runner finished without writing its output")
        return 1

    emit("result", duration_ms=timer.elapsed_ms(), **(result or {}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
