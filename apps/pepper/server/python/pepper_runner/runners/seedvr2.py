"""Video (and image) super-resolution through SeedVR2.

SeedVR2 is ByteDance's one-step diffusion restorer. Unlike a per-frame GAN
upscaler it denoises batches of frames together, so it adds detail that stays
put from frame to frame instead of shimmering, and it is at its best on
exactly what Pepper produces: soft, low-resolution AI video. It is what the
ComfyUI community settled on for finishing Wan/LTX/Hunyuan clips.

This runner drives the standalone CLI of numz/ComfyUI-SeedVR2_VideoUpscaler
(cloned by Pepper at a pinned commit into ``package_dir``) as a subprocess,
turning its log into progress. The CLI downloads its weights on first use into
``model_dir``, which Pepper points at the models volume so that happens once.

The CLI writes video without sound; Pepper puts the source's soundtrack back
afterwards (see services/upscale.ts), since MiniMax-H3 and LTX-2 clips have one.

Params: ``model_dir``, ``dit_model`` (a SeedVR2 checkpoint name), ``resolution``
(target short side), ``batch_size`` (frames denoised together, 4n+1),
``temporal_overlap``, ``seed``, ``color_correction``.
Inputs: ``video`` or ``image``.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

from ..common import progress, stage

# "Batch 3/12" and similar progress lines from the CLI's phase logging.
BATCH_RE = re.compile(r"(?:batch|Batch)\s+(\d+)\s*/\s*(\d+)")
PHASE_RE = re.compile(r"Phase\s+(\d)\s*:?\s*([A-Za-z][A-Za-z ]+)")


def run(job) -> dict:
    package = job.package_dir
    if not package or not os.path.isfile(os.path.join(package, "inference_cli.py")):
        raise FileNotFoundError("seedvr2 needs the SeedVR2 package (inference_cli.py) in package_dir")
    source = job.inputs.get("video") or job.inputs.get("image")
    if not source:
        raise ValueError("seedvr2 needs an input video or image")

    model_dir = job.param("model_dir")
    os.makedirs(model_dir, exist_ok=True)
    batch_size = int(job.param("batch_size", 33))
    if (batch_size - 1) % 4:
        raise ValueError("batch_size must be 4n+1 (1, 5, 9 … 33 …)")

    command = [
        sys.executable,
        os.path.join(package, "inference_cli.py"),
        source,
        "--output", job.output,
        "--model_dir", model_dir,
        "--dit_model", str(job.param("dit_model", "seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors")),
        "--resolution", str(int(job.param("resolution", 1080))),
        "--batch_size", str(batch_size),
        "--temporal_overlap", str(int(job.param("temporal_overlap", 3))),
        "--seed", str(int(job.param("seed", 42))),
        "--color_correction", str(job.param("color_correction", "lab")),
        # 1080p frames through a 7B model: tile the VAE rather than risk the
        # decode being the step that runs out of memory at the very end.
        "--vae_encode_tiled",
        "--vae_decode_tiled",
    ]
    if job.inputs.get("video"):
        command += ["--video_backend", "ffmpeg"]
    # Keep the DiT and VAE off the GPU while the other one runs: each alone
    # fits a 24 GB card at 1080p, both together may not.
    command += ["--dit_offload_device", "cpu", "--vae_offload_device", "cpu"]

    stage(f"upscaling with SeedVR2 ({job.param('dit_model', 'default model')})")
    process = subprocess.Popen(
        command,
        cwd=package,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert process.stdout
    tail: list[str] = []
    for line in process.stdout:
        line = line.rstrip()
        if not line:
            continue
        print(line, flush=True)
        tail = (tail + [line])[-30:]
        phase = PHASE_RE.search(line)
        if phase:
            stage(f"seedvr2 phase {phase.group(1)}: {phase.group(2).strip().lower()}")
        batch = BATCH_RE.search(line)
        if batch:
            progress(int(batch.group(1)), int(batch.group(2)), "seedvr2")
    code = process.wait()
    if code != 0 or not os.path.isfile(job.output):
        raise RuntimeError(f"SeedVR2 exited with {code}: " + " | ".join(tail[-8:]))
    return {"output": job.output, "resolution": int(job.param("resolution", 1080))}
