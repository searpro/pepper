"""One module per model family, each exposing ``run(job) -> dict`` (result metadata)."""

RUNNERS = {
    "wan22_ti2v": "pepper_runner.runners.wan22_ti2v",
    "ltx_video": "pepper_runner.runners.ltx_video",
    "echomimic_v3": "pepper_runner.runners.echomimic_v3",
    "upscale": "pepper_runner.runners.upscale",
}
