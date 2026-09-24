"""LTX-Video 0.9.8 2B distilled — text-to-video and image-to-video through diffusers.

Ported from ai-video's run_ltx.py: Lightricks' distilled multi-scale recipe —
7 steps at half resolution, a 2x latent upsample, then 3 refining steps, all
at cfg 1. ~3 minutes for 97 frames at 768x512 on a 24 GB M4, peaking around
14 GB, most of it the T5 encoder (dequantized at load; freed before sampling).

The fastest of the small video models, with weaker detail retention on
image-to-video than Wan 2.2 5B.

Bundle components:
  checkpoint/       ltxv-2b-0.9.8-distilled.safetensors (transformer + VAE in one file)
  clip/             t5-v1_1-xxl encoder GGUF
  tokenizer/        T5 tokenizer files
  upsampler/        ltxv-spatial-upscaler (latent_upsampler config.json + safetensors); optional
"""

from __future__ import annotations

from pepper_runner.common import (CONFIGS, Job, fit_to_image, free_memory, pick_device, stage, staged_config,
                                  step_callback, write_video)

# Lightricks' distilled schedules (ltxv-2b-0.9.8-distilled.yaml).
PASS1 = [1000, 993, 987, 981, 975, 909, 725, 0.03]
PASS2 = [1000, 909, 725, 421, 0]  # entered at denoise_strength 0.999, i.e. from 909
# 32x spatial VAE compression; pass 1 runs at half size, so the target must
# halve to a multiple of 32 as well.
MULTIPLE = 64


def run(job: Job) -> dict:
    import torch
    from diffusers import (AutoencoderKLLTXVideo, FlowMatchEulerDiscreteScheduler, LTXConditionPipeline,
                           LTXLatentUpsamplePipeline, LTXVideoTransformer3DModel)
    from diffusers.pipelines.ltx.modeling_latent_upsampler import LTXLatentUpsamplerModel
    from diffusers.pipelines.ltx.pipeline_ltx_condition import LTXVideoCondition
    from diffusers.utils import load_image
    from PIL import Image
    from transformers import AutoTokenizer, T5Config, T5EncoderModel

    device, dtype = pick_device()
    prompt = job.param("prompt", "")
    fps = int(job.param("fps", 24))
    seed = int(job.param("seed", 42))
    # LTX wants 8k+1 frames (8x temporal compression around a first frame).
    frames = max(9, round((int(job.param("video_frames", 97)) - 1) / 8) * 8 + 1)

    image_path = job.inputs.get("image")
    image = load_image(image_path).convert("RGB") if image_path else None
    width, height = fit_to_image(image, int(job.param("width", 768)), int(job.param("height", 512)), MULTIPLE)
    upsampler_dir = job.components.get("other:upsampler")
    single_pass = not upsampler_dir or bool(job.param("single_pass", False))

    # 1) Encode the prompt with the GGUF T5, then free it.
    stage("encoding prompt")
    te_file = job.file("clip", ".gguf")
    text_encoder = T5EncoderModel.from_pretrained(
        str(te_file.parent), gguf_file=te_file.name,
        config=T5Config.from_json_file(str(CONFIGS / "t5_v1_1_xxl_encoder.json")), torch_dtype=dtype,
    ).to(device)
    checkpoint = str(job.file("checkpoint", ".safetensors"))
    with staged_config("ltx_vae.json", "vae") as cfg:
        vae = AutoencoderKLLTXVideo.from_single_file(checkpoint, config=cfg.dir, subfolder=cfg.subfolder,
                                                     torch_dtype=dtype)
    pipe = LTXConditionPipeline(
        scheduler=FlowMatchEulerDiscreteScheduler.from_config(
            FlowMatchEulerDiscreteScheduler.load_config(str(CONFIGS / "ltx_scheduler.json"))),
        vae=vae, text_encoder=text_encoder,
        tokenizer=AutoTokenizer.from_pretrained(str(job.slot("other:tokenizer"))), transformer=None,
    )
    with torch.no_grad():
        prompt_embeds, prompt_mask, _, _ = pipe.encode_prompt(
            prompt, do_classifier_free_guidance=False, max_sequence_length=256, device=device, dtype=dtype)
    pipe.text_encoder = None
    del text_encoder
    free_memory(device)

    # 2) Transformer, then sample.
    stage("loading transformer")
    with staged_config("ltx_transformer.json", "transformer") as cfg:
        pipe.transformer = LTXVideoTransformer3DModel.from_single_file(
            checkpoint, config=cfg.dir, subfolder=cfg.subfolder, torch_dtype=dtype)
    pipe.to(device)
    pipe.set_progress_bar_config(disable=True)  # progress goes out as protocol lines
    pipe.vae.enable_tiling()  # caps decode memory; untiled decode is the peak otherwise

    conditions = [LTXVideoCondition(image=image, frame_index=0)] if image is not None else None
    common = dict(prompt_embeds=prompt_embeds, prompt_attention_mask=prompt_mask, num_frames=frames,
                  guidance_scale=1.0, decode_timestep=0.05, decode_noise_scale=0.025, image_cond_noise_scale=0.0,
                  generator=torch.Generator().manual_seed(seed), frame_rate=fps)

    if single_pass:
        output = pipe(conditions=conditions, width=width, height=height, timesteps=PASS1,
                      callback_on_step_end=step_callback(len(PASS1)), **common).frames[0]
    else:
        w1, h1 = width // 2, height // 2
        latents = pipe(conditions=conditions, width=w1, height=h1, timesteps=PASS1, output_type="latent",
                       callback_on_step_end=step_callback(len(PASS1), "sampling (low res)"), **common).frames
        stage("upsampling latents")
        upsampler = LTXLatentUpsamplerModel.from_pretrained(upsampler_dir, torch_dtype=dtype).to(device)
        latents = LTXLatentUpsamplePipeline(vae=pipe.vae, latent_upsampler=upsampler)(
            latents=latents, adain_factor=1.0, output_type="latent").frames
        del upsampler
        output = pipe(conditions=conditions, width=w1 * 2, height=h1 * 2, timesteps=PASS2, latents=latents,
                      denoise_strength=0.999, callback_on_step_end=step_callback(len(PASS2) - 1, "refining"),
                      **common).frames[0]
        if (w1 * 2, h1 * 2) != (width, height):
            output = [f.resize((width, height), Image.LANCZOS) for f in output]

    write_video(output, job.output, fps)
    return {"width": width, "height": height, "frames": len(output), "fps": fps, "seed": seed,
            "mode": "i2v" if image is not None else "t2v", "multiscale": not single_pass}
