"""Wan 2.2 TI2V-5B (Turbo) — text-to-video and image-to-video through diffusers.

Ported from ai-video's run_wan22.py, which measured this the best quality per
gigabyte of the small video models on a 24 GB M4: a GGUF transformer that
diffusers keeps quantized, 4 steps at cfg 1 for the Turbo distillation.

Memory choreography matters more than anything else here. transformers
*dequantizes* a GGUF text encoder at load (umt5-xxl is ~11 GB in bf16 whatever
the quant), so the prompt is encoded first and the encoder freed before the
transformer is loaded — the two are never resident together.

Bundle components:
  checkpoint/       Wan2.2-TI2V-5B(-Turbo) GGUF transformer
  clip/             umt5-xxl encoder GGUF
  vae/              diffusers AutoencoderKLWan (config.json + safetensors)
  tokenizer/        umt5-xxl tokenizer files
"""

from __future__ import annotations

from pepper_runner.common import (CONFIGS, Job, encode_real_tokens, fit_to_image, free_memory, load_gguf_t5,
                                  pick_device, stage, staged_config, step_callback, write_video)

# WanPipeline's max_sequence_length: embeddings are the real tokens,
# zero-padded to this length.
TEXT_LENGTH = 226

# Wan's own default negative prompt. It only matters with cfg > 1, which the
# Turbo distillation does not use, but a base (non-Turbo) GGUF does.
DEFAULT_NEGATIVE = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，"
    "JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，"
    "手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
)
# The VAE compresses 16x spatially and the transformer patches 2x2 on top.
MULTIPLE = 32


def run(job: Job) -> dict:
    import torch
    from diffusers import (AutoencoderKLWan, GGUFQuantizationConfig, UniPCMultistepScheduler,
                           WanImageToVideoPipeline, WanPipeline, WanTransformer3DModel)
    from diffusers.utils import load_image
    from diffusers.pipelines.wan.pipeline_wan import prompt_clean
    from transformers import AutoTokenizer, UMT5EncoderModel

    device, dtype = pick_device()
    prompt = job.param("prompt", "")
    cfg = float(job.param("cfg_scale", 1.0))
    negative = job.param("negative_prompt") or DEFAULT_NEGATIVE
    steps = int(job.param("steps", 4))
    fps = int(job.param("fps", 24))
    seed = int(job.param("seed", 42))
    # Wan wants 4k+1 frames: the VAE compresses time 4x around a first frame.
    frames = max(5, round((int(job.param("video_frames", 49)) - 1) / 4) * 4 + 1)

    image_path = job.inputs.get("image")
    image = load_image(image_path).convert("RGB") if image_path else None
    width, height = fit_to_image(image, int(job.param("width", 1280)), int(job.param("height", 704)), MULTIPLE)

    # 1) Encode the prompt on the CPU, then free the encoder, before anything
    #    else loads: transformers dequantizes the GGUF to ~11 GB.
    stage("encoding prompt")
    text_encoder = load_gguf_t5(UMT5EncoderModel, job.file("clip", ".gguf"), "umt5_xxl_encoder.json", dtype)
    tokenizer = AutoTokenizer.from_pretrained(str(job.slot("other:tokenizer")))

    def encode(text: str):
        # What WanPipeline.encode_prompt produces: cleaned text, real-token
        # embeddings zero-padded to TEXT_LENGTH, batch of one.
        embeds = encode_real_tokens(tokenizer, text_encoder, prompt_clean(text), TEXT_LENGTH)
        padded = torch.cat([embeds, embeds.new_zeros(TEXT_LENGTH - embeds.size(0), embeds.size(1))])
        return padded.unsqueeze(0).to(device=device, dtype=dtype)

    prompt_embeds = encode(prompt)
    negative_embeds = encode(negative) if cfg > 1 else None
    del text_encoder
    free_memory(device)

    # bf16 VAE: decode dominates on MPS and bf16 is ~4x faster than fp32 with
    # identical output. It must exist before the pipeline is built — its
    # scale factor is read at construction, and without it the latent grid is
    # silently computed at 8x instead of 16x.
    vae = AutoencoderKLWan.from_pretrained(str(job.slot("vae")), torch_dtype=dtype)
    scheduler = UniPCMultistepScheduler.from_config(
        UniPCMultistepScheduler.load_config(str(CONFIGS / "wan22_ti2v_scheduler.json")))
    # One model, two pipelines: TI2V-5B conditions on an image by replacing
    # the first latent frame, and diffusers' I2V pipeline refuses to run
    # without one — so text-to-video goes through the plain Wan pipeline.
    # `expand_timesteps` is what makes both treat this as the 5B TI2V model.
    common = dict(tokenizer=tokenizer, text_encoder=None, vae=vae, scheduler=scheduler,
                  transformer=None, expand_timesteps=True)
    pipe = (WanImageToVideoPipeline(image_processor=None, image_encoder=None, **common)
            if image is not None else WanPipeline(**common))

    # 2) The GGUF transformer stays quantized in memory.
    stage("loading transformer")
    pipe.transformer = _load_transformer(job, dtype, WanTransformer3DModel, GGUFQuantizationConfig)
    pipe.to(device)
    pipe.set_progress_bar_config(disable=True)  # progress goes out as protocol lines

    stage("sampling")
    kwargs = dict(
        prompt_embeds=prompt_embeds, negative_prompt_embeds=negative_embeds if cfg > 1 else None,
        height=height, width=width, num_frames=frames, num_inference_steps=steps, guidance_scale=cfg,
        output_type="pil", generator=torch.Generator().manual_seed(seed),
        callback_on_step_end=step_callback(steps),
    )
    if image is not None:
        kwargs["image"] = image
    output = pipe(**kwargs).frames[0]

    write_video(output, job.output, fps)
    return {"width": width, "height": height, "frames": len(output), "fps": fps, "seed": seed,
            "mode": "i2v" if image is not None else "t2v"}


def _load_transformer(job: Job, dtype, cls, quant_cls):
    with staged_config("wan22_ti2v_transformer.json", "transformer") as cfg:
        return cls.from_single_file(
            str(job.file("checkpoint", ".gguf")), config=cfg.dir, subfolder=cfg.subfolder,
            quantization_config=quant_cls(compute_dtype=dtype), torch_dtype=dtype,
        )
