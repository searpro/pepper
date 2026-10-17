# Save as nvvfx/__init__.py in a directory on PYTHONPATH when starting a CPU
# ComfyUI, then read /object_info/RTXVideoSuperResolution and friends into
# recipes/rtx-master/node-schemas.json. Another gpu_only pack needs its own
# stub of the same shape: just the names its node schemas read at import.
# Schema-only stand-in for NVIDIA's nvvfx, so a CPU ComfyUI can describe the
# RTX nodes (their schemas read these enums); nothing here can run an effect.
from enum import IntEnum
class QualityLevel(IntEnum):
    BICUBIC = 0; LOW = 1; MEDIUM = 2; HIGH = 3; ULTRA = 4
    DENOISE_LOW = 8; DENOISE_MEDIUM = 9; DENOISE_HIGH = 10; DENOISE_ULTRA = 11
    DEBLUR_LOW = 12; DEBLUR_MEDIUM = 13; DEBLUR_HIGH = 14; DEBLUR_ULTRA = 15
    HIGHBITRATE_LOW = 16; HIGHBITRATE_MEDIUM = 17; HIGHBITRATE_HIGH = 18; HIGHBITRATE_ULTRA = 19
    STREAMING_MEDIUM = 21; STREAMING_ULTRA = 23
class ImageEncoding(IntEnum):
    RGB8 = 0; RGB10A2 = 1
class VideoFrameGeneration:
    class Mode(IntEnum):
        LOW = 0; MEDIUM = 1; HIGH = 2
class VideoSuperRes: pass
class TrueHDR: pass
