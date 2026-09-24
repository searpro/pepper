"""EchoMimicV3-Flash — audio-driven human animation from one image, a speech clip and a prompt.

Built on antgroup/echomimic_v3's own model code (``src/``, cloned into the
bundle's Python package), following infer_flash.py, with three substitutions
that make it fit a 24 GB Mac instead of the CUDA boxes upstream tested on:

- **Text encoder:** the umt5-xxl GGUF through transformers' UMT5EncoderModel
  instead of the 11 GB ``models_t5_umt5-xxl-enc-bf16.pth``. It is the same
  encoder (diffusers' Wan pipelines use exactly this), it is freed as soon as
  the prompt is encoded, and the pipeline is handed the cached embeddings.
- **CLIP image encoder:** the ViT-H/14 visual tower in diffusers format
  (1.3 GB) instead of the 4.8 GB open-clip checkpoint whose text tower the
  pipeline never uses. ``ClipVisionAdapter`` reproduces Wan's preprocessing
  and its "output of block 31 of 32" feature.
- **Device:** MPS/CUDA/CPU from ``pick_device`` rather than upstream's
  hardcoded CUDA; attention falls back to PyTorch SDPA when flash-attn is
  absent, which upstream already supports.

Bundle components:
  checkpoint/          echomimicv3-flash-pro config.json + diffusion_pytorch_model.safetensors
  vae/                 Wan2.1_VAE.pth
  clip/                umt5-xxl encoder GGUF
  tokenizer/           umt5-xxl tokenizer files
  image_encoder/       CLIPVisionModel (config.json + model.safetensors)
  wav2vec/             chinese-wav2vec2-base (config, preprocessor config, weights)
"""

from __future__ import annotations

import math
from contextlib import nullcontext as _nullcontext

import torch

from pepper_runner.common import (Job, encode_real_tokens, free_memory, load_gguf_t5, pick_device, stage,
                                  step_callback, write_video)

# EchoMimicV3's audio features are aligned to 25 fps video: the wav2vec
# embedding is resampled to one vector per frame at that rate.
FPS = 25
MAX_FRAMES = 121
DEFAULT_NEGATIVE = (
    "Gesture is bad. Gesture is unclear. Strange and twisted hands. Bad hands. Bad fingers. "
    "Unclear and blurry hands. Unclear gestures, broken hands, fused fingers. 手指融合，"
)
# config/config.yaml upstream, inlined so the runner does not need omegaconf.
TRANSFORMER_KWARGS = {"transformer_subpath": "./", "dict_mapping": {"in_dim": "in_channels", "dim": "hidden_size"}}
VAE_KWARGS = {"vae_subpath": "Wan2.1_VAE.pth", "temporal_compression_ratio": 4, "spatial_compression_ratio": 8}
# Flow_UniPC with shift 1 in the scheduler; the real shift (5) is applied by
# the pipeline call, as infer_flash.py does.
SCHEDULER_KWARGS = {"num_train_timesteps": 1000, "shift": 1, "use_dynamic_shifting": False,
                    "base_shift": 0.5, "max_shift": 1.15, "base_image_seq_len": 256, "max_image_seq_len": 4096}


def run(job: Job) -> dict:
    import librosa
    from PIL import Image
    from transformers import AutoTokenizer, UMT5EncoderModel, Wav2Vec2FeatureExtractor

    from src.cache_utils import get_teacache_coefficients
    from src.fm_solvers_unipc import FlowUniPCMultistepScheduler
    from src.pipeline_wan_fun_inpaint_audio_2512 import WanFunInpaintAudioPipeline
    from src.utils import filter_kwargs, get_image_to_video_latent2
    from src.wan_transformer3d_audio_2512 import WanTransformerAudioMask3DModel
    from src.wan_vae import AutoencoderKLWan
    from src.wav2vec2 import Wav2Vec2Model

    image_path, audio_path = job.inputs.get("image"), job.inputs.get("audio")
    if not image_path:
        raise ValueError("EchoMimicV3 animates a reference image: pass one as the speaker image")
    if not audio_path:
        raise ValueError("EchoMimicV3 is audio-driven: pass a speech clip")

    device, dtype = pick_device()
    prompt = job.param("prompt", "A person is speaking.")
    negative = job.param("negative_prompt") or DEFAULT_NEGATIVE
    steps = int(job.param("steps", 8))
    guidance = float(job.param("cfg_scale", 6.0))
    audio_guidance = float(job.param("audio_cfg_scale", 3.0))
    seed = int(job.param("seed", 43))
    width, height = int(job.param("width", 512)), int(job.param("height", 512))
    max_frames = min(int(job.param("video_frames", MAX_FRAMES)), MAX_FRAMES)

    # --- Audio: how long the clip is decides how many frames there are. -----
    stage("encoding audio")
    speech, sr = librosa.load(audio_path, sr=16000)
    speech = _loudness_norm(speech, sr)
    if job.param("exact_frames", False):
        # Pepper's speech-to-video orchestrator already sized this chunk (on
        # the 4k+1 grid) and stitches on that length; rendering a different
        # count would drift the seams out of sync.
        frames = max_frames
    else:
        frames = min(int(len(speech) / sr * FPS), max_frames)
        frames = int((frames - 1) // 4 * 4) + 1 if frames > 1 else 1  # 4k+1 for the causal VAE
    speech = speech[: int(frames / FPS * sr)]

    wav2vec_dir = str(job.slot("other:wav2vec"))
    audio_encoder = Wav2Vec2Model.from_pretrained(wav2vec_dir, local_files_only=True).to("cpu")
    audio_encoder.feature_extractor._freeze_parameters()
    extractor = Wav2Vec2FeatureExtractor.from_pretrained(wav2vec_dir, local_files_only=True)
    audio_embeds = _audio_embeds(speech, extractor, audio_encoder, frames, sr)
    del audio_encoder
    # A window of 5 embeddings (2 either side) per frame, clamped at the ends.
    audio_embeds = audio_embeds.to(device=device, dtype=dtype)
    offsets = torch.arange(5) - 2
    centers = torch.clamp(torch.arange(frames).unsqueeze(1) + offsets.unsqueeze(0), 0, audio_embeds.shape[0] - 1)
    audio_embeds = audio_embeds[centers].unsqueeze(0)

    # --- Prompt: encode with the GGUF umt5 on the CPU, then free it. --------
    # Freed before any of the video models load, so the 11 GB encoder and the
    # transformer are never resident together.
    stage("encoding prompt")
    text_encoder = load_gguf_t5(UMT5EncoderModel, job.file("clip", ".gguf"), "umt5_xxl_encoder.json", dtype)
    tokenizer = AutoTokenizer.from_pretrained(str(job.slot("other:tokenizer")))
    # Upstream's _get_t5_prompt_embeds result: a list of real-token embeddings.
    prompt_embeds = [encode_real_tokens(tokenizer, text_encoder, prompt).to(device=device, dtype=dtype)]
    negative_embeds = [encode_real_tokens(tokenizer, text_encoder, negative).to(device=device, dtype=dtype)]
    del text_encoder
    free_memory(device)

    # --- Models -------------------------------------------------------------
    stage("loading models")
    transformer = WanTransformerAudioMask3DModel.from_pretrained(
        str(job.slot("checkpoint")), transformer_additional_kwargs=dict(TRANSFORMER_KWARGS),
        low_cpu_mem_usage=True, torch_dtype=dtype,
    )
    if device == "mps":
        _patch_for_mps(transformer)
    vae = AutoencoderKLWan.from_pretrained(str(job.file("vae", ".pth")), additional_kwargs=VAE_KWARGS).to(dtype)
    if device != "cuda":
        _stream_tiled_decode(vae, device)
    clip = ClipVisionAdapter.load(str(job.slot("other:image_encoder")), dtype)
    scheduler = FlowUniPCMultistepScheduler(**filter_kwargs(FlowUniPCMultistepScheduler, SCHEDULER_KWARGS))

    pipeline = WanFunInpaintAudioPipeline(
        transformer=transformer, vae=vae, tokenizer=tokenizer, text_encoder=DtypeStub(dtype),
        scheduler=scheduler, clip_image_encoder=clip,
    )
    # The pipeline encodes the prompt inside __call__ and reads
    # text_encoder.dtype; hand it the cached embeddings and a dtype-only
    # stand-in for the encoder that is already gone.
    pipeline.encode_prompt = lambda *args, **kwargs: (prompt_embeds, negative_embeds)

    pipeline.to(device=device)
    pipeline.set_progress_bar_config(disable=True)  # progress goes out as protocol lines
    coefficients = get_teacache_coefficients("Wan2.1-Fun-V1.1-1.3B-InP")
    if coefficients is not None and job.param("teacache", True):
        pipeline.transformer.enable_teacache(coefficients, steps, 0.1, num_skip_start_steps=min(5, steps), offload=False)

    # --- Sample -------------------------------------------------------------
    reference = Image.open(image_path).convert("RGB")
    sample_h, sample_w = _sample_size(reference, (height, width))
    video, mask, clip_image = get_image_to_video_latent2(reference, None, video_length=frames,
                                                         sample_size=[sample_h, sample_w])
    stage("sampling")
    # Upstream wraps the transformer in CUDA autocast and relies on it to
    # reconcile float32 embedding maths with bf16 weights. On Metal that
    # context is a no-op, and a mixed-dtype matmul aborts the process outright
    # (an MPS assertion, not a Python error) — so the same job is done with
    # MPS autocast here.
    autocast = torch.autocast("mps", dtype=dtype) if device == "mps" else _nullcontext()
    with torch.no_grad(), autocast:
        sample = pipeline(
            prompt, num_frames=frames, negative_prompt=negative, audio_embeds=audio_embeds, audio_scale=1.0,
            ip_mask=None, use_un_ip_mask=False, height=sample_h, width=sample_w,
            generator=torch.Generator(device="cpu" if device == "mps" else device).manual_seed(seed),
            neg_scale=1.0, neg_steps=0, use_dynamic_cfg=False, use_dynamic_acfg=False,
            guidance_scale=guidance, audio_guidance_scale=audio_guidance, num_inference_steps=steps,
            video=video, mask_video=mask, clip_image=clip_image, cfg_skip_ratio=0.0, shift=5.0,
            callback_on_step_end=step_callback(steps),
        ).videos

    # [b, c, f, h, w] floats in 0..1 -> HxWx3 uint8 frames, each colour-matched
    # to the first as upstream's save_videos_grid does: it holds skin tone and
    # lighting steady across the clip.
    import numpy as np
    from src.utils import color_transfer

    video_np = sample if isinstance(sample, np.ndarray) else sample.float().cpu().numpy()
    clip_frames = [np.uint8(np.clip(f, 0, 1) * 255) for f in video_np[0, :, :frames].transpose(1, 2, 3, 0)]
    clip_frames = [clip_frames[0]] + [np.uint8(color_transfer(f, clip_frames[0])) for f in clip_frames[1:]]
    # A chunk of a longer clip is stitched and re-muxed with the whole
    # recording by Pepper, so its own audio track would only be discarded.
    muxed = job.param("mux_audio", True)
    write_video(clip_frames, job.output, FPS, audio=audio_path if muxed else None, audio_seconds=frames / FPS)
    return {"width": sample_w, "height": sample_h, "frames": frames, "fps": FPS, "seed": seed,
            "audio_seconds": round(frames / FPS, 3), "mode": "s2v"}


def _stream_tiled_decode(vae, device: str, tile: int = 32, overlap: int = 8) -> None:
    """Replace upstream's VAE decode with a spatially tiled, streaming one.

    Upstream decodes the whole frame at once and concatenates every frame's
    output on the device. On Apple Silicon that is ruinous: Metal's 3D
    convolutions take ~19 GB of driver memory for four latent frames at
    448x592 and it grows with every frame, so a normal clip is killed by the
    OS mid-decode. This keeps upstream's decoder and its causal time cache but
    decodes ``tile``-latent squares (256 px) that overlap by ``overlap`` and
    are blended with linear ramps, moves each frame's pixels to the CPU as it
    is produced, and releases Metal's cached blocks between frames — a few GB,
    flat in the clip's length.
    """
    from diffusers.models.autoencoders.vae import DecoderOutput

    model, scale = vae.model, vae.scale
    ratio = 8  # spatial compression of the Wan 2.1 VAE

    def decode_frames(z):  # z: [1, C, T, h, w] on device -> [3, frames, H, W] float32 on CPU
        model.clear_cache()
        mean, std = (s.to(z.device, z.dtype) for s in scale)
        if isinstance(mean, torch.Tensor):
            z = z / std.view(1, model.z_dim, 1, 1, 1) + mean.view(1, model.z_dim, 1, 1, 1)
        else:
            z = z / std + mean
        x = model.conv2(z)
        chunks = []
        for i in range(x.shape[2]):
            model._conv_idx = [0]
            out = model.decoder(x[:, :, i:i + 1], feat_cache=model._feat_map, feat_idx=model._conv_idx)
            chunks.append(out[0].float().clamp_(-1, 1).cpu())
            del out
            free_memory(device)
        model.clear_cache()
        return torch.cat(chunks, 1)

    def ramp(length, fade_start, fade_end):
        w = torch.ones(length)
        if fade_start:
            w[:fade_start] = torch.linspace(0, 1, fade_start + 2)[1:-1]
        if fade_end:
            w[-fade_end:] = torch.linspace(1, 0, fade_end + 2)[1:-1]
        return w

    def starts(size):
        if size <= tile:
            return [0]
        stride = tile - overlap
        positions = list(range(0, size - tile, stride)) + [size - tile]
        return sorted(set(positions))

    def tiled(latents):
        _, _, _, h, w = latents.shape
        result = weight = None
        for top in starts(h):
            for left in starts(w):
                piece = decode_frames(latents[:, :, :, top:top + tile, left:left + tile])
                if result is None:
                    result = torch.zeros(3, piece.shape[1], h * ratio, w * ratio)
                    weight = torch.zeros(1, 1, h * ratio, w * ratio)
                th, tw = piece.shape[2], piece.shape[3]
                fade = overlap * ratio
                wy = ramp(th, fade if top > 0 else 0, fade if top + tile < h else 0)
                wx = ramp(tw, fade if left > 0 else 0, fade if left + tile < w else 0)
                mask = (wy[:, None] * wx[None, :])[None, None]
                y0, x0 = top * ratio, left * ratio
                result[:, :, y0:y0 + th, x0:x0 + tw] += piece * mask
                weight[:, :, y0:y0 + th, x0:x0 + tw] += mask
        return result / weight.clamp_min(1e-6)

    def _decode(zs):
        return DecoderOutput(sample=torch.stack([tiled(u.unsqueeze(0)) for u in zs]))

    vae._decode = _decode


def _patch_for_mps(transformer) -> None:
    """Keep upstream's float64 maths off Metal, which has no float64 at all.

    Two places compute in double precision on the device: the RoPE table
    (complex128) and the timestep sinusoid. Both are positional encodings of
    small integers, well within float32/complex64 precision — which is what
    they run in under CUDA autocast anyway.
    """
    import src.wan_transformer3d_audio_2512 as module

    transformer.freqs = transformer.freqs.to(torch.complex64)

    def sinusoidal_embedding_1d(dim, position):
        half = dim // 2
        position = position.to(torch.float32)
        sinusoid = torch.outer(position, torch.pow(10000, -torch.arange(half).to(position).div(half)))
        return torch.cat([torch.cos(sinusoid), torch.sin(sinusoid)], dim=1)

    module.sinusoidal_embedding_1d = sinusoidal_embedding_1d


def _loudness_norm(audio, sr, lufs=-23):
    import pyloudnorm as pyln

    meter = pyln.Meter(sr)
    loudness = meter.integrated_loudness(audio)
    if abs(loudness) > 100:  # silence: nothing to normalise
        return audio
    return pyln.normalize.loudness(audio, loudness, lufs)


def _audio_embeds(speech, extractor, encoder, frames, sr):
    """Per-frame wav2vec features: every encoder layer's output, resampled to ``frames``.

    Upstream reads ``hidden_states[1:]`` off its Wav2Vec2Model wrapper, which
    transformers 5 no longer populates through that path (hidden states are
    collected by the top-level model now, not the encoder). Hooking the
    layers captures exactly the same tensors on either major version.
    """
    import numpy as np
    from einops import rearrange

    layer_outputs: list = []
    hooks = [
        layer.register_forward_hook(
            lambda _m, _i, out: layer_outputs.append(out[0] if isinstance(out, tuple) else out))
        for layer in encoder.encoder.layers
    ]
    try:
        features = np.squeeze(extractor(speech, sampling_rate=sr).input_values)
        features = torch.from_numpy(features).float().unsqueeze(0)
        with torch.no_grad():
            encoder(features, seq_len=int(frames), output_hidden_states=True)
    finally:
        for hook in hooks:
            hook.remove()
    embeds = torch.stack(layer_outputs, dim=1).squeeze(0)  # [layers, frames, dim]
    return rearrange(embeds, "b s d -> s b d").cpu()


def _sample_size(image, target):
    """infer_flash.py's get_sample_size: keep the image's aspect, cap its area, multiples of 16."""
    w, h = image.size
    area, target_area = w * h, target[0] * target[1]
    if target_area < area:
        ratio = math.sqrt(area / target_area)
        w, h = w / ratio // 16 * 16, h / ratio // 16 * 16
    else:
        w, h = w // 16 * 16, h // 16 * 16
    return int(h), int(w)


class DtypeStub(torch.nn.Module):
    """Stands in for the freed text encoder: the pipeline only reads ``.dtype``."""

    def __init__(self, dtype):
        super().__init__()
        self.register_buffer("_marker", torch.zeros(0, dtype=dtype), persistent=False)

    @property
    def dtype(self):
        return self._marker.dtype

    # diffusers asks every pipeline component for its device when working out
    # where to run; ModelMixin provides this, a bare nn.Module does not.
    @property
    def device(self):
        return self._marker.device


class ClipVisionAdapter(torch.nn.Module):
    """Wan's CLIPModel interface over transformers' CLIPVisionModel.

    Upstream calls ``encoder([frames])`` with each item ``[C, 1, H, W]`` in
    [-1, 1] and gets back the ViT-H/14 tokens after 31 of its 32 blocks. That
    is ``hidden_states[-2]`` here: the same feature diffusers' Wan I2V
    pipeline uses with this exact checkpoint.
    """

    MEAN = (0.48145466, 0.4578275, 0.40821073)
    STD = (0.26862954, 0.26130258, 0.27577711)

    def __init__(self, model):
        super().__init__()
        self.model = model
        self.register_buffer("mean", torch.tensor(self.MEAN).view(1, 3, 1, 1), persistent=False)
        self.register_buffer("std", torch.tensor(self.STD).view(1, 3, 1, 1), persistent=False)

    @classmethod
    def load(cls, path: str, dtype):
        from transformers import CLIPVisionModel

        return cls(CLIPVisionModel.from_pretrained(path, torch_dtype=dtype)).eval()

    @property
    def dtype(self):
        return self.model.dtype

    @property
    def device(self):
        return self.model.device

    def forward(self, videos):
        import torch.nn.functional as F

        size = self.model.config.image_size
        x = torch.cat([F.interpolate(u.transpose(0, 1).float(), size=(size, size), mode="bicubic",
                                     align_corners=False) for u in videos])
        x = (x.mul(0.5).add(0.5) - self.mean) / self.std
        out = self.model(pixel_values=x.to(self.model.dtype), output_hidden_states=True)
        return out.hidden_states[-2]
