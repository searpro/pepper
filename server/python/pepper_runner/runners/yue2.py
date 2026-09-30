"""Full songs through YuE2 (m-a-p/YuE2-3B).

YuE2 writes a symbolic plan (melody and chords as ABC notation) from the style
and lyrics, generates semantic tokens against it, then renders 48 kHz stereo
audio through its VAE. On a 4090 a 3.6-minute song takes about 71 seconds in
about 11 GB, which is what earns it a place next to ACE-Step and HeartMuLa: on
SongBench it scores above both, and above Suno v5.

It runs in its own venv (Pepper's `yue2` environment): its inference package
pins torch 2.10 and transformers 4.57, which the shared runner environment
cannot also satisfy.

Licence: CC BY-NC 4.0 — the catalogue marks it non-commercial.

Params: ``model_dir`` (the bundle's weights folder, or a HF repo id),
``vae_dir`` (the bundle's aux folder holding YuE2-Vae; fetched from HuggingFace
when absent), ``style``, ``lyrics``, ``seed``, ``cot`` (full | melody | off),
``cfg_scale`` (optional).
"""

from __future__ import annotations

import os

from ..common import stage


def run(job) -> dict:
    from yue2 import YuE2Pipeline

    style = job.param("style")
    lyrics = job.param("lyrics") or ""
    if not style:
        raise ValueError("yue2 needs a style prompt")
    model = job.param("model_dir") or "m-a-p/YuE2-3B"

    # With the VAE installed beside the model nothing is downloaded at run
    # time, so the job neither needs the network nor writes to the volume.
    vae_dir = job.param("vae_dir")
    local_vae = bool(vae_dir) and os.path.isfile(os.path.join(vae_dir, "model.safetensors"))

    stage("loading YuE2")
    pipe = YuE2Pipeline.from_pretrained(
        model,
        device="cuda",
        **({"vae": vae_dir, "local_files_only": True} if local_vae else {}),
    )
    try:
        kwargs = {
            "style": style,
            "lyrics": lyrics,
            "cot": job.param("cot", "full"),
            "seed": int(job.param("seed", 1234)),
        }
        if job.param("cfg_scale") is not None:
            kwargs["cfg_scale"] = float(job.param("cfg_scale"))
        stage("composing and singing")
        song = pipe(**kwargs)
        # The extension picks the container; Pepper serves WAV like the other music models.
        song.save(job.output)
    finally:
        pipe.close()
    if not os.path.isfile(job.output):
        raise RuntimeError("YuE2 finished without writing audio")
    timing = getattr(song, "timing", {}) or {}
    return {
        "output": job.output,
        "seconds": timing.get("e2e_seconds"),
        "truncated": bool(getattr(song, "truncated", False)),
    }
