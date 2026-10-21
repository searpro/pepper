"""HDR helpers for compose.py, in numpy: the graphics layer into PQ, and the
HDR10 -> HLG delivery LUT. The constants mirror Pepper Pro's film-finish node
(apps/pepper-pro/server/comfy-nodes/pepper_finish/finish.py), which made the
HDR10 takes: SDR white, and so graphics white, at 203 nits (ITU-R BT.2408),
BT.709 primaries inside BT.2020, BT.1886 gamma 2.4 for SDR code values.
"""
import math
from pathlib import Path

import numpy as np

REF_WHITE = 203.0
GAMMA = 2.4
M709_2020 = np.array([[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]])
LUMA_2020 = np.array([0.2627, 0.6780, 0.0593])
PQ_M1, PQ_M2 = 2610 / 16384, 2523 / 4096 * 128
PQ_C1, PQ_C2, PQ_C3 = 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32
HLG_A = 0.17883277
HLG_B = 1 - 4 * HLG_A
HLG_C = 0.5 - HLG_A * math.log(4 * HLG_A)


def pq_encode(nits):
    y = np.clip(nits / 10000.0, 0, 1) ** PQ_M1
    return ((PQ_C1 + PQ_C2 * y) / (1 + PQ_C3 * y)) ** PQ_M2


def pq_decode(code):
    p = np.clip(code, 0, 1) ** (1 / PQ_M2)
    return (np.maximum(p - PQ_C1, 0) / (PQ_C2 - PQ_C3 * p)) ** (1 / PQ_M1) * 10000.0


def hlg_encode(nits, peak=1000.0):
    """BT.2020 display light (..., 3) to HLG for a `peak`-nit display (BT.2100)."""
    gamma = 1.2 + 0.42 * math.log10(peak / 1000.0)
    disp = np.clip(nits / peak, 0, 1)
    ys = np.maximum(disp @ LUMA_2020, 1e-7)[..., None]
    scene = np.clip(disp * ys ** ((1 - gamma) / gamma), 0, 1)
    with np.errstate(divide='ignore', invalid='ignore'):
        high = HLG_A * np.log(np.maximum(12 * scene - HLG_B, 1e-7)) + HLG_C
    return np.where(scene <= 1 / 12, np.sqrt(3 * scene), high)


class GraphicsToPQ:
    """8-bit SDR graphics (straight-alpha RGB) to 16-bit PQ code values,
    through a table over all 2^24 colours built once (~100 MB, a few
    seconds), so a full-screen photo costs a lookup rather than a pow per pixel."""

    def __init__(self):
        self.table = None

    def __call__(self, rgb: np.ndarray) -> np.ndarray:
        if self.table is None:
            levels = (np.arange(256) / 255.0) ** GAMMA
            table = np.empty((1 << 24, 3), np.uint16)
            g, b = np.meshgrid(levels, levels, indexing='ij')
            gb = np.stack([np.zeros_like(g), g, b], -1).reshape(-1, 3)
            for r in range(256):
                lin = gb.copy()
                lin[:, 0] = levels[r]
                table[r << 16:(r + 1) << 16] = np.round(pq_encode(lin @ M709_2020.T * REF_WHITE) * 65535)
            self.table = table
        idx = (rgb[..., 0].astype(np.uint32) << 16) | (rgb[..., 1].astype(np.uint32) << 8) | rgb[..., 2]
        return self.table[idx]


def over_pq(base: np.ndarray, layer_rgba: np.ndarray, to_pq: GraphicsToPQ) -> np.ndarray:
    """The graphics layer over an HDR frame, blended in PQ code values: a
    perceptual scale, so a 65% black pill darkens the picture as it does in
    the SDR cut (blending in linear light would leave it lighter)."""
    a = layer_rgba[..., 3:4].astype(np.float32) / 255
    covered = a[..., 0] > 0
    if not covered.any():
        return base
    out = base.astype(np.float32)
    ov = to_pq(layer_rgba[covered][:, :3]).astype(np.float32)
    ac = a[covered]
    out[covered] = out[covered] * (1 - ac) + ov * ac
    return np.round(out).astype(np.uint16)


def write_pq_to_hlg(path: Path, peak: float = 1000.0, n: int = 65) -> Path:
    """A .cube that turns an HDR10 (PQ, BT.2020) cut into HLG for the same
    display peak: exact up to the LUT's sampling, graphics white landing at
    HLG's 75% as BT.2408 asks."""
    g = np.linspace(0, 1, n)
    b, gg, r = np.meshgrid(g, g, g, indexing='ij')
    pq = np.stack([r, gg, b], -1).reshape(-1, 3)
    out = np.clip(hlg_encode(pq_decode(pq), peak), 0, 1)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w') as f:
        f.write(f'TITLE "pq-to-hlg {int(peak)} nits"\nLUT_3D_SIZE {n}\n')
        f.writelines(f'{v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n' for v in out)
    return path
