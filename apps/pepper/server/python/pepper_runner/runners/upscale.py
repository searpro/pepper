"""Image super-resolution through spandrel.

spandrel reads the checkpoint formats the upscaling community actually ships —
ESRGAN old and new layouts (4x-UltraSharp, NMKD-Siax), RealESRGAN x2plus's
pixel-unshuffle variant, the SRVGGNet "compact" models, SPAN, RCAN, DAT, HAT,
SwinIR and more — and says which architecture and native scale a file is.
sd-cli's ESRGAN graph only implements plain RRDBNet, which is why this runner
exists at all.

Inference is tiled with an overlap so a 1024² image at 4× (a 4096² result)
never needs the whole activation map in memory at once; the seams are
feathered away by averaging the overlapping borders.

Params: ``model`` (path to the checkpoint), ``scale`` (the output scale asked
for: 2 or 4), ``tile`` (input tile edge, default 512), ``overlap`` (default 32).
Inputs: ``image``.
"""

from __future__ import annotations

import math

from ..common import Job, emit, free_memory, progress, stage


def run(job: Job) -> dict:
    import numpy as np
    import torch
    from PIL import Image
    from spandrel import ModelLoader

    model_path = job.param("model")
    if not model_path:
        raise ValueError("upscale needs a 'model' checkpoint path")
    source = job.inputs.get("image")
    if not source:
        raise ValueError("upscale needs an input image")
    target_scale = int(job.param("scale", 4))
    tile = int(job.param("tile", 512))
    overlap = int(job.param("overlap", 32))

    if torch.cuda.is_available():
        device = "cuda"
    elif torch.backends.mps.is_available():
        device = "mps"
    else:
        device = "cpu"

    stage("loading upscaler")
    descriptor = ModelLoader(device=device).load_from_file(model_path)
    descriptor.eval()
    # fp16 halves the activation memory and is roughly twice as fast on MPS;
    # architectures spandrel knows to overflow in half precision (DAT, RCAN,
    # HAT…) stay in fp32.
    dtype = torch.float16 if descriptor.supports_half and device != "cpu" else torch.float32
    descriptor.model.to(dtype)
    native = int(descriptor.scale)

    image = Image.open(source)
    has_alpha = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
    rgba = image.convert("RGBA") if has_alpha else None
    rgb = image.convert("RGB")
    width, height = rgb.size

    tensor = torch.from_numpy(np.array(rgb, dtype=np.float32) / 255.0).permute(2, 0, 1).unsqueeze(0)
    result = _tiled(descriptor, tensor, native, tile, overlap, device, dtype)

    stage("writing image")
    array = (result.squeeze(0).permute(1, 2, 0).clamp(0, 1).numpy() * 255.0).round().astype("uint8")
    upscaled = Image.fromarray(array, "RGB")

    # A native pass that overshoots (a 4× model asked for 2×) is resampled
    # down; one that undershoots (a 2× model asked for 4×) is resampled up,
    # which still beats a plain resize of the original.
    out_w, out_h = width * target_scale, height * target_scale
    method = "native"
    if upscaled.size != (out_w, out_h):
        upscaled = upscaled.resize((out_w, out_h), Image.Resampling.LANCZOS)
        method = f"x{native}+resample"

    if rgba is not None:
        # The networks are RGB-only; alpha is carried over with a plain resize.
        alpha = rgba.getchannel("A").resize((out_w, out_h), Image.Resampling.LANCZOS)
        upscaled = upscaled.convert("RGBA")
        upscaled.putalpha(alpha)

    upscaled.save(job.output, format="PNG")
    free_memory(device)
    return {
        "width": out_w,
        "height": out_h,
        "source_width": width,
        "source_height": height,
        "architecture": descriptor.architecture.name,
        "native_scale": native,
        "method": method,
        "precision": "fp16" if dtype == torch.float16 else "fp32",
    }


def _tiled(descriptor, image, scale: int, tile: int, overlap: int, device: str, dtype):
    """Run the model tile by tile, blending overlaps with a linear feather."""
    import torch

    _, channels, height, width = image.shape
    if height <= tile and width <= tile:
        progress(0, 1, "upscaling")
        with torch.inference_mode():
            out = descriptor(image.to(device, dtype)).float().cpu()
        progress(1, 1, "upscaling")
        return out

    stride = tile - overlap
    rows = max(1, math.ceil((height - overlap) / stride))
    cols = max(1, math.ceil((width - overlap) / stride))
    total = rows * cols
    output = torch.zeros(1, channels, height * scale, width * scale)
    weight = torch.zeros(1, 1, height * scale, width * scale)
    done = 0
    progress(0, total, "upscaling")

    for row in range(rows):
        for col in range(cols):
            y0 = min(row * stride, max(0, height - tile))
            x0 = min(col * stride, max(0, width - tile))
            y1, x1 = min(y0 + tile, height), min(x0 + tile, width)
            patch = image[:, :, y0:y1, x0:x1].to(device, dtype)
            with torch.inference_mode():
                out = descriptor(patch).float().cpu()
            mask = _feather(out.shape[2], out.shape[3], overlap * scale,
                            top=y0 > 0, left=x0 > 0, bottom=y1 < height, right=x1 < width)
            output[:, :, y0 * scale:y1 * scale, x0 * scale:x1 * scale] += out * mask
            weight[:, :, y0 * scale:y1 * scale, x0 * scale:x1 * scale] += mask
            done += 1
            progress(done, total, "upscaling")

    emit("stage", stage="blending tiles")
    return output / weight.clamp_min(1e-6)


def _feather(h: int, w: int, ramp: int, top: bool, left: bool, bottom: bool, right: bool):
    """A weight mask that ramps from ~0 to 1 over ``ramp`` pixels on edges that overlap a neighbour."""
    import torch

    ys = torch.ones(h)
    xs = torch.ones(w)
    if ramp > 0:
        r = torch.linspace(1.0 / (ramp + 1), 1.0, min(ramp, h))
        if top:
            ys[: len(r)] = torch.minimum(ys[: len(r)], r)
        if bottom:
            ys[-len(r):] = torch.minimum(ys[-len(r):], r.flip(0))
        r = torch.linspace(1.0 / (ramp + 1), 1.0, min(ramp, w))
        if left:
            xs[: len(r)] = torch.minimum(xs[: len(r)], r)
        if right:
            xs[-len(r):] = torch.minimum(xs[-len(r):], r.flip(0))
    return (ys[:, None] * xs[None, :]).view(1, 1, h, w)
