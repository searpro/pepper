"""Shared plumbing for Pepper's Python runners.

Every runner is a one-shot job: Pepper spawns ``python -m pepper_runner <job.json>``,
the runner loads what it needs, writes one video and exits. Nothing stays
resident between jobs — on a unified-memory Mac a video model left loaded is
memory the LLM and TTS backends cannot have, and a crashed job cannot leak into
the next one.

Progress goes to stdout as ``@@pepper <json>`` lines, which Pepper's job
manager turns into step progress and stages. Anything else on stdout/stderr
is plain log output.
"""

from __future__ import annotations

import gc
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

MARKER = "@@pepper "
CONFIGS = Path(__file__).parent / "configs"


def emit(kind: str, **data: Any) -> None:
    """One protocol line. Flushed immediately: Pepper reads the pipe live."""
    sys.stdout.write(MARKER + json.dumps({"type": kind, **data}) + "\n")
    sys.stdout.flush()


def stage(name: str) -> None:
    emit("stage", stage=name, memory=memory_report())


def memory_report() -> str | None:
    """Accelerator memory in use, for the stage log: tensors vs what the driver holds."""
    torch = sys.modules.get("torch")
    if torch is None:
        return None
    gb = 1024**3
    if torch.cuda.is_available():
        return f"cuda {torch.cuda.memory_allocated() / gb:.1f} GB allocated, {torch.cuda.memory_reserved() / gb:.1f} GB reserved"
    if torch.backends.mps.is_available():
        return (f"mps {torch.mps.current_allocated_memory() / gb:.1f} GB allocated, "
                f"{torch.mps.driver_allocated_memory() / gb:.1f} GB driver")
    return None


def progress(step: int, total: int, stage_name: str = "sampling") -> None:
    emit("progress", step=step, total=total, stage=stage_name)


@dataclass
class Job:
    runner: str
    output: str
    components: dict[str, str]
    params: dict[str, Any]
    inputs: dict[str, str | None] = field(default_factory=dict)
    package_dir: str | None = None

    @classmethod
    def load(cls, path: str) -> "Job":
        data = json.loads(Path(path).read_text())
        return cls(
            runner=data["runner"],
            output=data["output"],
            components=data.get("components", {}),
            params=data.get("params", {}),
            inputs=data.get("inputs", {}),
            package_dir=data.get("package_dir"),
        )

    def slot(self, name: str) -> Path:
        """The directory a component slot was installed into."""
        path = self.components.get(name)
        if not path:
            raise FileNotFoundError(f"Model bundle has no '{name}' component")
        return Path(path)

    def file(self, slot: str, *suffixes: str, contains: str | None = None) -> Path:
        """The one weights file in a slot matching a suffix — the largest, if several."""
        candidates = [
            p for p in self.slot(slot).iterdir()
            if p.is_file() and (not suffixes or p.name.lower().endswith(suffixes))
            and (contains is None or contains.lower() in p.name.lower())
        ]
        if not candidates:
            raise FileNotFoundError(f"No {'/'.join(suffixes) or 'file'} in the '{slot}' component")
        return max(candidates, key=lambda p: p.stat().st_size)

    def param(self, key: str, default: Any = None) -> Any:
        value = self.params.get(key)
        return default if value is None else value


def pick_device():
    """CUDA, then Apple's MPS, then CPU — with the dtype each runs well in.

    Pre-Ampere CUDA (T4, V100) runs bf16 in software emulation at a tenth of
    fp16's speed, so those get fp16. Apple Silicon does bf16 natively.
    """
    import torch

    if torch.cuda.is_available():
        major, _ = torch.cuda.get_device_capability()
        return "cuda", torch.bfloat16 if major >= 8 else torch.float16
    if torch.backends.mps.is_available():
        return "mps", torch.bfloat16
    return "cpu", torch.float32


def free_memory(device: str) -> None:
    gc.collect()
    import torch

    if device == "cuda":
        torch.cuda.empty_cache()
    elif device == "mps":
        torch.mps.empty_cache()


def step_callback(total: int, stage_name: str = "sampling") -> Callable:
    """A diffusers ``callback_on_step_end`` that reports progress."""
    progress(0, total, stage_name)

    def callback(_pipe, i, _t, kwargs):
        progress(i + 1, total, stage_name)
        return kwargs

    return callback


def ffmpeg_binary() -> str:
    """ffmpeg for muxing: Pepper's own, else the one imageio-ffmpeg ships."""
    explicit = os.environ.get("FFMPEG_PATH")
    if explicit:
        return explicit
    found = shutil.which("ffmpeg")
    if found:
        return found
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def write_video(frames: list, path: str, fps: int, audio: str | None = None, audio_seconds: float | None = None) -> None:
    """Encode PIL/numpy frames as H.264 MP4, muxing an audio track if given.

    H.264 + yuv420p because that is what every browser's <video> plays; the
    audio is cut to the video's length so a long clip does not leave a frozen
    or silent tail.
    """
    import imageio
    import numpy as np

    stage("encoding video")
    target = Path(path)
    silent = target.with_suffix(".silent.mp4") if audio else target
    writer = imageio.get_writer(str(silent), fps=fps, codec="libx264", quality=9,
                                pixelformat="yuv420p", macro_block_size=16)
    try:
        for frame in frames:
            writer.append_data(np.asarray(frame.convert("RGB") if hasattr(frame, "convert") else frame))
    finally:
        writer.close()

    if audio:
        cmd = [ffmpeg_binary(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(silent), "-i", audio,
               "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest"]
        if audio_seconds:
            cmd += ["-t", f"{audio_seconds:.3f}"]
        subprocess.run(cmd + [str(target)], check=True)
        silent.unlink(missing_ok=True)


def snap(value: float, multiple: int, minimum: int | None = None) -> int:
    snapped = max(multiple, round(value / multiple) * multiple)
    return max(minimum, snapped) if minimum else snapped


def fit_to_image(image, target_w: int, target_h: int, multiple: int) -> tuple[int, int]:
    """Keep the input image's aspect at roughly the requested pixel count."""
    if image is None:
        return snap(target_w, multiple), snap(target_h, multiple)
    area = target_w * target_h
    ratio = image.width / image.height
    h = (area / ratio) ** 0.5
    return snap(h * ratio, multiple), snap(h, multiple)


class Timer:
    def __init__(self) -> None:
        self.start = time.time()

    def elapsed_ms(self) -> int:
        return int((time.time() - self.start) * 1000)


class staged_config:
    """A throwaway diffusers-layout directory holding one vendored config.

    ``from_single_file`` wants ``<dir>/<subfolder>/config.json``. The configs
    are fixed by each architecture and tiny, so they ship inside the runner
    rather than as a component that would otherwise drag in a multi-gigabyte
    diffusers repo for one JSON file.
    """

    def __init__(self, vendored: str, subfolder: str) -> None:
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.subfolder = subfolder
        target = Path(self.dir) / subfolder
        target.mkdir(parents=True)
        shutil.copy(CONFIGS / vendored, target / "config.json")

    def __enter__(self) -> "staged_config":
        return self

    def __exit__(self, *_exc) -> None:
        self._tmp.cleanup()


def load_gguf_t5(encoder_cls, gguf: Path, config_name: str, dtype):
    """A T5-family encoder from GGUF, pinned to the CPU.

    transformers dequantizes the GGUF (umt5-xxl is ~11 GB in bf16). Kept off
    the accelerator deliberately: on Apple Silicon the Metal driver holds on
    to those pages after the encoder is freed, and the video model loaded
    next runs out of memory. With only the real tokens encoded (see
    ``encode_real_tokens``) a prompt costs a few seconds of CPU.
    """
    from transformers import T5Config

    return encoder_cls.from_pretrained(
        str(gguf.parent), gguf_file=gguf.name, config=T5Config.from_json_file(str(CONFIGS / config_name)),
        torch_dtype=dtype, device_map="cpu",  # transformers 5 would otherwise pick the accelerator
    ).eval()


def encode_real_tokens(tokenizer, encoder, text: str, max_length: int = 512):
    """``[tokens, dim]`` embeddings of the prompt's real tokens only.

    Pipelines pad to a fixed length and then trim or zero the padding; since
    the padding is masked out of attention, encoding just the real tokens
    gives identical values for them (verified bit-exact against the padded
    path) at a fraction of the cost.
    """
    import torch

    inputs = tokenizer([text], max_length=max_length, truncation=True, add_special_tokens=True,
                       return_tensors="pt")
    with torch.no_grad():
        embeds = encoder(inputs.input_ids, attention_mask=inputs.attention_mask)[0]
    return embeds[0, : int(inputs.attention_mask.sum())]
