"""Film finishing for a take, streamed through the GPU one frame at a time.

ffmpeg decodes the take to raw YUV, torch does all the picture work on the card
in 32-bit float, and ffmpeg encodes on the CPU (x264 for SDR, x265 for HDR),
the three running at once. Memory stays the same whatever the take's length,
which a ComfyUI IMAGE batch cannot do: a 10 s 2192x3840 take is 24 GB as
float32 frames, more than the 16gb tier's RAM can hold next to ComfyUI.

The working space. A take is display-referred 8-bit Rec.709 SDR, so the
picture is first turned back into linear light with headroom above white:
`x_from_sdr` inverts a soft highlight shoulder (linear up to KNEE, then
compressing toward SDR white), so SDR white becomes `headroom` (4 by default,
two stops over diffuse white) and everything below the knee is untouched.
The look works there: exposure, contrast and saturation on light, halation,
bloom and lens effects as light adds up, grain in log exposure like film.
`sdr_from_x` is the exact inverse, so SDR out of an ungraded take is the take.
HDR out is the same light with SDR's diffuse white at 203 nits (ITU-R
BT.2408), so skin and walls sit where an HDR grade puts them and only what
the shoulder had compressed (sun, speculars, catchlights) rises toward the
peak. One grade, one picture: SDR, HDR10 and HLG differ only in the last step.

  python finish.py IN OUT --look film --output hdr10      # on the laptop (MPS) or the box (CUDA)
"""
from __future__ import annotations

import argparse
import json
import math
import queue
import subprocess
import threading
import time
from dataclasses import dataclass, field, replace
from fractions import Fraction
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

# --- Looks ---------------------------------------------------------------------


@dataclass(frozen=True)
class Look:
    """One finishing look. Sizes are fractions of the frame's short side (or
    pixels at a 2160 short side), so a look reads the same at 1080p and 4K."""

    # The original presenter look (finish.py's subtle/medium/strong), ported
    # as-is: a warm LUT on display values, halation and glow screened over,
    # a uniform chromatic shift, overlay grain. None for the film looks.
    legacy: dict | None = None
    # Film looks, on linear light (see the module docstring).
    exposure: float = 0.0          # stops
    contrast: float = 1.0          # log contrast of luminance around 18% grey
    saturation: float = 1.0
    density: float = 0.0           # darkens saturated colours, as subtractive film does
    warmth: float = 0.0            # >0 warmer: gains on red and blue in linear light
    shadow_tint: tuple = (0.0, 0.0, 0.0)     # linear gains at deep shadow, luminance-neutral
    highlight_tint: tuple = (0.0, 0.0, 0.0)  # and above diffuse white
    skin: float = 0.0              # 0..1: how far skin hues are pulled to the skin line
    lift: float = 0.0              # black level, as an SDR code value (0.03 = 3%)
    halation: float = 0.0          # strength of the red-orange glow round bright light
    halation_size: float = 0.006   # blur sigma, fraction of the short side
    bloom: float = 0.0             # a diffusion filter (Pro-Mist): share of the light spread
    bloom_size: float = 0.03
    aberration: float = 0.0        # lateral chromatic aberration, px at the corners at 2160
    vignette: float = 0.0          # stops darker at the corners
    grain: float = 0.0             # grain at mid grey, stops (std)
    grain_size: float = 1.6        # px at 2160
    grain_colour: float = 0.35     # 0 luma only, 1 independent per channel
    deband: bool = True


LOOKS: dict[str, Look] = {
    # finish.py's three, unchanged: the user's pick on 2026-10-21 was strong.
    'subtle': Look(deband=False, legacy=dict(grade=0.75, lift=0.035, grain=60, grain_size=1.6, grain_mix=0.30, hal=0.25, glow=0.08, shift=2, vig=0.30)),
    'medium': Look(deband=False, legacy=dict(grade=1.00, lift=0.055, grain=80, grain_size=2.0, grain_mix=0.45, hal=0.40, glow=0.14, shift=3, vig=0.40)),
    'strong': Look(deband=False, legacy=dict(grade=1.00, lift=0.080, grain=100, grain_size=2.4, grain_mix=0.60, hal=0.60, glow=0.22, shift=4, vig=0.50)),
    # A clean commercial grade: matched, protected skin, gentle density, no
    # texture. For product shots and anything that wants to look shot on a
    # good digital camera rather than film.
    'clean': Look(contrast=1.04, density=0.15, skin=0.3, lift=0.012,
                  shadow_tint=(-0.012, 0.0, 0.03), highlight_tint=(0.012, 0.004, -0.015),
                  bloom=0.03, vignette=0.25, grain=0.012, grain_size=1.2),
    # A film print look: soft highlight roll-off, teal-leaning shadows and
    # warm highlights (not warm skin: the sets are golden already), dense
    # strong colours, halation and a diffusion filter, film grain.
    'film': Look(contrast=1.06, density=0.25, skin=0.3, lift=0.035,
                 shadow_tint=(-0.035, 0.005, 0.055), highlight_tint=(0.025, 0.008, -0.03),
                 halation=0.5, bloom=0.08, aberration=2.5, vignette=0.4, grain=0.045, grain_size=1.8),
    # The same at the strength of `strong`: what a phone screen and the
    # platforms' compression still show.
    'film-strong': Look(contrast=1.08, density=0.32, skin=0.3, lift=0.06,
                        shadow_tint=(-0.045, 0.006, 0.07), highlight_tint=(0.03, 0.01, -0.035),
                        halation=0.8, bloom=0.12, aberration=3.5, vignette=0.5, grain=0.07, grain_size=2.3),
}

OUTPUTS = ('sdr', 'hdr10', 'hlg')

# --- Colour --------------------------------------------------------------------

LUMA_709 = (0.2126, 0.7152, 0.0722)
LUMA_2020 = (0.2627, 0.6780, 0.0593)
KNEE = 0.6          # SDR display-linear level where the highlight shoulder starts (code ~0.81)
GAMMA = 2.4         # BT.1886: what the take was graded for, and what SDR out is encoded with
REF_WHITE = 203.0   # nits of SDR white in HDR (ITU-R BT.2408)
# Linear BT.709 to BT.2020 primaries (ITU-R BT.2087).
M709_2020 = ((0.6274, 0.3293, 0.0433), (0.0691, 0.9195, 0.0114), (0.0164, 0.0880, 0.8956))
M2020_709 = ((1.6605, -0.5876, -0.0728), (-0.1246, 1.1329, -0.0083), (-0.0182, -0.1006, 1.1187))

PQ_M1, PQ_M2 = 2610 / 16384, 2523 / 4096 * 128
PQ_C1, PQ_C2, PQ_C3 = 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32
HLG_A = 0.17883277
HLG_B = 1 - 4 * HLG_A
HLG_C = 0.5 - HLG_A * math.log(4 * HLG_A)


def _shoulder(headroom: float) -> float:
    """The rational shoulder's scale: slope 1 at KNEE, SDR white (1.0) at `headroom`."""
    d = headroom - KNEE
    return (1 - KNEE) * d / (d - (1 - KNEE))


def x_from_sdr(lin: torch.Tensor, headroom: float) -> torch.Tensor:
    """SDR display-linear RGB (0..1) to working light. On the max of the three
    channels, so a highlight keeps its colour as it brightens (per channel, a
    clipped red would race ahead of green and blue and turn skin orange)."""
    a = _shoulder(headroom)
    n = lin.amax(-3, keepdim=True).clamp_min(1e-6)
    y = (n - KNEE).clamp(min=0.0, max=(1 - KNEE))
    expanded = KNEE + a * y / (a - y)
    return lin * torch.where(n > KNEE, expanded / n, torch.ones_like(n))


def sdr_from_x(x: torch.Tensor, headroom: float) -> torch.Tensor:
    """Working light to SDR display-linear, the exact inverse of x_from_sdr:
    whatever the grade pushes past white rolls off instead of clipping."""
    a = _shoulder(headroom)
    n = x.amax(-3, keepdim=True).clamp_min(1e-6)
    y = (n - KNEE).clamp_min(0.0)
    rolled = KNEE + a * y / (y + a)
    return (x * torch.where(n > KNEE, rolled / n, torch.ones_like(n))).clamp(0.0, 1.0)


def luminance(x: torch.Tensor, weights=LUMA_709) -> torch.Tensor:
    r, g, b = x.unbind(-3)
    return (weights[0] * r + weights[1] * g + weights[2] * b).unsqueeze(-3)


def matrix3(x: torch.Tensor, m) -> torch.Tensor:
    r, g, b = x.unbind(-3)
    return torch.stack([m[i][0] * r + m[i][1] * g + m[i][2] * b for i in range(3)], -3)


def pq_encode(nits: torch.Tensor) -> torch.Tensor:
    y = (nits / 10000.0).clamp(0.0, 1.0).pow(PQ_M1)
    return ((PQ_C1 + PQ_C2 * y) / (1 + PQ_C3 * y)).pow(PQ_M2)


def pq_decode(code: torch.Tensor) -> torch.Tensor:
    p = code.clamp(0.0, 1.0).pow(1 / PQ_M2)
    return ((p - PQ_C1).clamp_min(0.0) / (PQ_C2 - PQ_C3 * p)).pow(1 / PQ_M1) * 10000.0


def hlg_encode(nits: torch.Tensor, peak: float) -> torch.Tensor:
    """BT.2020 display light to HLG for a `peak`-nit display: the inverse OOTF
    (system gamma 1.2 at 1000 nits, BT.2100) to scene light, then the OETF."""
    gamma = 1.2 + 0.42 * math.log10(peak / 1000.0)
    disp = (nits / peak).clamp(0.0, 1.0)
    ys = luminance(disp, LUMA_2020).clamp_min(1e-7)
    scene = (disp * ys.pow((1 - gamma) / gamma)).clamp(0.0, 1.0)
    low = torch.sqrt(3 * scene)
    high = HLG_A * torch.log((12 * scene - HLG_B).clamp_min(1e-7)) + HLG_C
    return torch.where(scene <= 1 / 12, low, high)


def hdr_nits(x: torch.Tensor, peak: float) -> torch.Tensor:
    """Working light (BT.709) to BT.2020 display nits: SDR white at 203 nits,
    the brightest light desaturating toward white as it nears the peak (real
    highlights are white; an SDR clip has kept only its edge colour), and a
    soft clip in the top fifth instead of a hard one."""
    nits = x * REF_WHITE
    n = nits.amax(-3, keepdim=True)
    y = luminance(nits)
    toward_white = ((n - 2 * REF_WHITE) / (peak - 2 * REF_WHITE)).clamp(0.0, 1.0) * 0.5
    nits = nits + (y - nits) * toward_white
    n = nits.amax(-3, keepdim=True).clamp_min(1e-6)
    knee = 0.8 * peak
    soft = knee + (peak - knee) * torch.tanh((n - knee) / (peak - knee))
    nits = nits * torch.where(n > knee, soft / n, torch.ones_like(n))
    return matrix3(nits.clamp_min(0.0), M709_2020)


# --- YUV <-> RGB ---------------------------------------------------------------


def yuv_to_rgb(planes: tuple[torch.Tensor, torch.Tensor, torch.Tensor], bits: int, weights=LUMA_709) -> torch.Tensor:
    """Limited-range 4:2:0 planes (integers) to R'G'B' 0..1, chroma upsampled bilinearly."""
    s = float(1 << (bits - 8))
    y, u, v = (p.float() for p in planes)
    y = (y - 16 * s) / (219 * s)
    uv = torch.stack([u, v])[None]
    uv = F.interpolate(uv, size=y.shape[-2:], mode='bilinear', align_corners=False)[0]
    cb, cr = (uv - 128 * s) / (224 * s)
    kr, kg, kb = weights
    r = y + 2 * (1 - kr) * cr
    b = y + 2 * (1 - kb) * cb
    g = (y - kr * r - kb * b) / kg
    return torch.stack([r, g, b]).clamp(0.0, 1.0)


def rgb_to_yuv(rgb: torch.Tensor, bits: int, weights=LUMA_709, dither: torch.Generator | None = None) -> np.ndarray:
    """R'G'B' 0..1 (3,H,W) to limited-range 4:2:0 planes as one contiguous
    buffer, with triangular dither before rounding so gradients do not band."""
    s = float(1 << (bits - 8))
    kr, kg, kb = weights
    r, g, b = rgb.clamp(0.0, 1.0)
    y = kr * r + kg * g + kb * b
    cb = (b - y) / (2 * (1 - kb))
    cr = (r - y) / (2 * (1 - kr))
    uv = F.avg_pool2d(torch.stack([cb, cr])[None], 2)[0]
    y = 16 * s + 219 * s * y
    uv = 128 * s + 224 * s * uv

    def q(t):
        if dither is not None:
            t = t + (torch.rand(t.shape, generator=dither, device=t.device) - torch.rand(t.shape, generator=dither, device=t.device))
        return t.round().clamp(0, (1 << bits) - 1)

    dtype = torch.uint8 if bits == 8 else torch.int16
    out = torch.cat([q(y).flatten(), q(uv[0]).flatten(), q(uv[1]).flatten()]).to(dtype)
    return out.cpu().numpy()


# --- Image operations ----------------------------------------------------------


def _gauss_kernel(sigma: float, device) -> torch.Tensor:
    radius = max(1, int(math.ceil(sigma * 3)))
    t = torch.arange(-radius, radius + 1, device=device, dtype=torch.float32)
    k = torch.exp(-0.5 * (t / sigma) ** 2)
    return k / k.sum()


def blur(x: torch.Tensor, sigma: float) -> torch.Tensor:
    """Gaussian blur of (C,H,W). Wide blurs run on a reduced copy (a bloom of
    70 px is a 420-tap kernel at full size) and are scaled back up."""
    if sigma < 0.3:
        return x
    c, h, w = x.shape
    factor = 1
    while sigma / factor > 6 and min(h, w) // (factor * 2) >= 16:
        factor *= 2
    small = F.avg_pool2d(x[None], factor)[0] if factor > 1 else x
    k = _gauss_kernel(sigma / factor, x.device)
    pad = k.numel() // 2
    small = small[None]
    small = F.conv2d(F.pad(small, (pad, pad, 0, 0), mode='replicate'), k.view(1, 1, 1, -1).repeat(c, 1, 1, 1), groups=c)
    small = F.conv2d(F.pad(small, (0, 0, pad, pad), mode='replicate'), k.view(1, 1, -1, 1).repeat(c, 1, 1, 1), groups=c)
    if factor > 1:
        small = F.interpolate(small, size=(h, w), mode='bilinear', align_corners=False)
    return small[0]


def screen(a: torch.Tensor, b: torch.Tensor, opacity: float) -> torch.Tensor:
    return a + ((1 - (1 - a) * (1 - b)) - a) * opacity


class Frame:
    """What every operation on one frame size needs, computed once."""

    def __init__(self, h: int, w: int, device):
        self.h, self.w, self.device = h, w, device
        yy, xx = torch.meshgrid(torch.arange(h, device=device, dtype=torch.float32),
                                torch.arange(w, device=device, dtype=torch.float32), indexing='ij')
        self.cy, self.cx = (h - 1) / 2, (w - 1) / 2
        self.dx, self.dy = xx - self.cx, yy - self.cy
        self.r = torch.sqrt(self.dx ** 2 + self.dy ** 2)
        self.rmax = math.hypot(self.cx, self.cy)
        # grid_sample's normalised coordinates of every pixel.
        self.gx = (xx + 0.5) / w * 2 - 1
        self.gy = (yy + 0.5) / h * 2 - 1
        self.short = min(h, w)

    def sample(self, x: torch.Tensor, gx: torch.Tensor, gy: torch.Tensor, mode: str = 'bilinear') -> torch.Tensor:
        """x (C,H,W) sampled at normalised coordinates, edges repeated: the
        grid is clamped to the edge pixels' centres, which is border padding
        on every device (MPS has no border mode)."""
        grid = torch.stack([gx.clamp(-1 + 1 / self.w, 1 - 1 / self.w), gy.clamp(-1 + 1 / self.h, 1 - 1 / self.h)], -1)[None]
        return F.grid_sample(x[None], grid, mode=mode, padding_mode='zeros', align_corners=False)[0]


def radial_aberration(x: torch.Tensor, frame: Frame, px_at_corner: float) -> torch.Tensor:
    """Lateral chromatic aberration as lenses make it: none at the centre,
    growing toward the corners, red magnified a touch and blue reduced."""
    k = px_at_corner / frame.rmax
    out = [x[1]]
    for channel, scale in ((0, 1 + k), (2, 1 - k)):
        out.insert(channel, frame.sample(x[channel:channel + 1], frame.gx / scale, frame.gy / scale)[0])
    return torch.stack(out)


def deband(e: torch.Tensor, frame: Frame, gen: torch.Generator, bits: int) -> torch.Tensor:
    """Smooth 8-bit steps in flat gradients (skies, out-of-focus walls) before
    grading stretches them: a pixel takes the mean of four samples at a random
    distance when all four are within a step or two of it, which is only true
    on a gradient, never on texture or an edge."""
    radius = 14 * frame.short / 2160
    threshold = 1.6 / 255 if bits == 8 else 0.6 / 255
    angle = torch.rand((frame.h, frame.w), generator=gen, device=e.device) * math.pi
    dist = torch.rand((frame.h, frame.w), generator=gen, device=e.device) * radius + 1
    ox, oy = torch.cos(angle) * dist / frame.w * 2, torch.sin(angle) * dist / frame.h * 2
    samples = []
    for sx, sy in ((ox, oy), (-ox, -oy), (-oy * frame.h / frame.w, ox * frame.w / frame.h), (oy * frame.h / frame.w, -ox * frame.w / frame.h)):
        samples.append(frame.sample(e, frame.gx + sx, frame.gy + sy, mode='nearest'))
    s = torch.stack(samples)
    flat = ((s - e[None]).abs().amax(0).amax(0, keepdim=True) < threshold)
    return torch.where(flat, s.mean(0), e)


SKIN_HUE = math.radians(123.0)  # the vectorscope's skin-tone line, in Cb/Cr


def skin_pull(x: torch.Tensor, strength: float) -> torch.Tensor:
    """Pull hues near the skin line onto it, the way a colourist consolidates
    skin with a hue-vs-hue curve: within 20 degrees, by up to `strength` of
    the angle, fading out at the edge of the range and in grey pixels. A
    rotation in the Cb/Cr plane of linear light, so luminance is untouched."""
    e = x.clamp(0.0, 1.0).pow(1 / GAMMA)
    y = luminance(e)
    cb, cr = (e[2:3] - y) / 1.8556, (e[0:1] - y) / 1.5748
    hue = torch.atan2(cr, cb)
    delta = torch.remainder(SKIN_HUE - hue + math.pi, 2 * math.pi) - math.pi
    chroma = torch.sqrt(cb ** 2 + cr ** 2)
    window = (1 - delta.abs() / math.radians(20)).clamp(0, 1)
    # Skin is moderately saturated; lips and a red top are more, and keep
    # their own hue.
    saturation = (chroma / 0.03).clamp(0, 1) * (1 - ((chroma - 0.10) / 0.06).clamp(0, 1))
    weight = window * saturation * (1 - ((y - 0.85) / 0.15).clamp(0, 1))
    angle = delta * strength * weight
    yl = luminance(x)
    lcb, lcr = (x[2:3] - yl) / 1.8556, (x[0:1] - yl) / 1.5748
    c, s = torch.cos(angle), torch.sin(angle)
    ncb, ncr = lcb * c - lcr * s, lcb * s + lcr * c
    r = yl + 1.5748 * ncr
    b = yl + 1.8556 * ncb
    g = (yl - 0.2126 * r - 0.0722 * b) / 0.7152
    return torch.cat([r, g, b])


def grain_field(frame: Frame, look: Look, gen: torch.Generator, scale: float) -> torch.Tensor:
    """A frame of film grain: a luma grain shared by the three layers plus a
    little of each layer's own, each layer its own size (blue the coarsest,
    green the finest, as in colour negative), unit deviation."""
    size = look.grain_size * scale
    n = torch.randn((4, frame.h, frame.w), generator=gen, device=frame.device)
    luma = blur(n[0:1], size)
    out = []
    for i, k in enumerate((1.0, 0.85, 1.3)):
        own = blur(n[i + 1:i + 2], size * k)
        mixed = luma * (1 - look.grain_colour) + own * look.grain_colour
        out.append(mixed)
    g = torch.cat(out)
    return g / g.std().clamp_min(1e-6)


def film_grain(x: torch.Tensor, grain: torch.Tensor, amount: float) -> torch.Tensor:
    """Grain in log exposure, as film's silver lives: multiplicative in
    linear light, strongest from shadows to bright skin and thinning in deep
    black and in highlights, where a print's curve flattens it."""
    lg = torch.log2(luminance(x).clamp_min(1e-5) / 0.18)
    response = torch.exp(-0.5 * ((lg - 0.3) / 2.6) ** 2) * 0.85 + 0.15
    response = response * (1 - ((lg - 2.0) / 2.0).clamp(0, 1) * 0.7)
    return x * torch.exp2(grain * amount * response)


# --- Legacy (finish.py) --------------------------------------------------------


def legacy_grade(e: torch.Tensor, mix: float, lift: float) -> torch.Tensor:
    """finish.py's warm .cube, evaluated directly rather than through 33^3 samples."""
    t = lift + (1 - lift) * e
    t = t / (1 + 0.18 * t) * 1.18
    t = (0.5 + (t - 0.5) * 1.10).clamp(0, 1)
    y = luminance(t)
    shadows, highs = (1 - y * 2).clamp(0, 1), (y * 2 - 1).clamp(0, 1)
    t = t + shadows * torch.tensor([-0.030, 0.010, 0.035], device=e.device).view(3, 1, 1) \
          + highs * torch.tensor([0.040, 0.012, -0.035], device=e.device).view(3, 1, 1)
    t = y + (t - y) * (1 - 0.12 * highs)
    return (e + (t - e) * mix).clamp(0, 1)


def _q8(t: torch.Tensor) -> torch.Tensor:
    return (t * 255).round().clamp(0, 255)


def _screen8(a: torch.Tensor, b: torch.Tensor, opacity: float) -> torch.Tensor:
    """ffmpeg's 8-bit screen blend, integer truncations and all: they darken
    by a code value or two, which is part of how finish.py's output looks."""
    a8, b8 = _q8(a), _q8(b)
    s = 255 - torch.floor((255 - a8) * (255 - b8) / 255)
    return torch.floor(a8 + (s - a8) * opacity) / 255


def _overlay8(a: torch.Tensor, b: torch.Tensor, opacity: float) -> torch.Tensor:
    a8, b8 = _q8(a), _q8(b)
    m = torch.where(a8 < 128, 2 * torch.floor(a8 * b8 / 255), 255 - 2 * torch.floor((255 - a8) * (255 - b8) / 255))
    return torch.floor(a8 + (m - a8) * opacity) / 255


# ffmpeg's gblur (an IIR approximation) leaves 1.3x the deviation of a true
# Gaussian of the same sigma: a true one this much narrower matches it.
FFMPEG_GBLUR = 0.78


def legacy_look(e: torch.Tensor, frame: Frame, p: dict, gen: torch.Generator, lut, lut_mix: float) -> torch.Tensor:
    """finish.py's filtergraph, step for step, on display values, with
    ffmpeg's 8-bit arithmetic where it shows (blends, the grain's blur)."""
    k = frame.w / 2160
    e = lut(e, lut_mix) if lut is not None else legacy_grade(e, p['grade'], p['lift'])
    e = torch.floor(e.clamp(0, 1) * 255) / 255  # lut3d's 8-bit output truncates
    hal = ((e * 255 - 228).clamp_min(0) * 9 / 255).clamp(0, 1)
    hal = blur(hal, 18 * k) * torch.tensor([1.0, 0.38, 0.12], device=e.device).view(3, 1, 1)
    glow = blur(((e * 255 - 212).clamp_min(0) * 5 / 255).clamp(0, 1), 70 * k)
    e = _screen8(e, hal, p['hal'])
    e = _screen8(e, glow, p['glow'])
    shift = max(1, round(p['shift'] * k))
    r = torch.cat([e[0, :, shift:], e[0, :, -1:].expand(-1, shift)], 1)
    b = torch.cat([e[2, :, :1].expand(-1, shift), e[2, :, :-shift]], 1)
    e = torch.stack([r, e[1], b])
    # ffmpeg's vignette takes no planar RGB, so in finish.py it ran on
    # limited-range YUV and scaled the 16 of black too: the corners darken and
    # their blacks sink. Part of the look the user chose, so kept.
    c = torch.cos(p['vig'] * frame.r / frame.rmax)
    f = (c * c) * (c * c)
    e = (e * f - (1 - f) * 16 / 219).clamp_min(0)
    # The grain plate: mid grey (127 after the noise filter's offset) with
    # uniform noise of +-strength/2 per channel, new every frame.
    noise = (torch.rand((3, frame.h, frame.w), generator=gen, device=e.device) - 0.5) * (p['grain'] / 255)
    plate = blur(127 / 255 + noise, p['grain_size'] * k * FFMPEG_GBLUR)
    return _overlay8(e, plate, p['grain_mix']).clamp(0, 1)


# --- LUTs ----------------------------------------------------------------------


class CubeLut:
    """A .cube 3D LUT applied on the GPU with trilinear interpolation."""

    def __init__(self, path: Path, device):
        size, rows = 0, []
        for line in Path(path).read_text().splitlines():
            parts = line.strip().split()
            if not parts or parts[0].startswith('#'):
                continue
            if parts[0] == 'LUT_3D_SIZE':
                size = int(parts[1])
            elif parts[0][0].isdigit() or parts[0][0] in '-.':
                rows.append([float(v) for v in parts[:3]])
        if not size or len(rows) != size ** 3:
            raise ValueError(f'{path} is not a 3D .cube LUT ({len(rows)} rows for size {size})')
        # .cube order is red fastest: [b][g][r] -> grid_sample's (D,H,W) = (b,g,r).
        table = torch.tensor(rows, dtype=torch.float32, device=device).view(size, size, size, 3)
        self.table = table.permute(3, 0, 1, 2)[None].contiguous()

    def __call__(self, e: torch.Tensor, mix: float = 1.0) -> torch.Tensor:
        grid = (e.clamp(0, 1) * 2 - 1).permute(1, 2, 0)[None, None]  # (1,1,H,W,3) as (x=r, y=g, z=b)
        # Inputs are clamped to the cube, so zero padding is never reached
        # (align_corners: -1 and 1 are the first and last entries).
        out = F.grid_sample(self.table, grid, mode='bilinear', padding_mode='zeros', align_corners=True)[0, :, 0]
        return e + (out - e) * mix


# --- Take statistics and matching ------------------------------------------------


def skin_mask(e: torch.Tensor) -> torch.Tensor:
    """Pixels that are probably skin: the classic Cb/Cr box, mid luminance."""
    y = luminance(e)
    cb = 128 + 224 * (e[2:3] - y) / 1.8556
    cr = 128 + 224 * (e[0:1] - y) / 1.5748
    y8 = 16 + 219 * y
    return (cb > 77) & (cb < 127) & (cr > 133) & (cr < 173) & (y8 > 60) & (y8 < 230)


def take_stats(frames: list[torch.Tensor], headroom: float) -> dict:
    """What a take's light and skin are, from a few small frames (R'G'B'):
    the median of skin pixels in linear light, else of the whole frame."""
    skins, alls = [], []
    for e in frames:
        x = x_from_sdr(e.pow(GAMMA), headroom)
        m = skin_mask(e)[0]
        alls.append(x.reshape(3, -1))
        if m.any():
            skins.append(x[:, m])
    every = torch.cat(alls, 1)
    skin = torch.cat(skins, 1) if skins else every[:, :0]
    use_skin = skin.shape[1] > every.shape[1] * 0.005
    ref = (skin if use_skin else every).median(1).values.clamp_min(1e-4)
    return {'rgb': ref.tolist(), 'from': 'skin' if use_skin else 'frame', 'skin_share': skin.shape[1] / max(1, every.shape[1])}


def match_gains(take: dict, ref: dict, strength: float) -> tuple[float, list[float]]:
    """Exposure (stops) and channel gains that move a take's skin (or frame)
    toward the reference's, capped at a stop and 12% per channel so a wrong
    match can only nudge, and scaled by `strength`."""
    t, r = torch.tensor(take['rgb']), torch.tensor(ref['rgb'])
    w = torch.tensor(LUMA_709)
    stops = float(torch.log2((r * w).sum() / (t * w).sum()).clamp(-1, 1)) * strength
    chroma_t, chroma_r = t / (t * w).sum(), r / (r * w).sum()
    gains = (chroma_r / chroma_t).clamp(0.88, 1.12)
    gains = (1 + (gains - 1) * strength)
    # Luminance-neutral, then capped again: renormalising can push a channel
    # past the cap (a red-heavy correction lifts red to 1.16 otherwise).
    gains = (gains / (gains * w).sum()).clamp(0.88, 1.12)
    return stops, gains.tolist()


# --- The pipeline ----------------------------------------------------------------


@dataclass
class Settings:
    look: Look
    output: str = 'sdr'
    peak: float = 1000.0
    headroom: float = 4.0
    lut: Path | None = None
    lut_mix: float = 1.0
    expand: str = 'curve'        # 'curve' or 'rtx' (NVIDIA RTX Video HDR, CUDA only)
    exposure: float = 0.0        # from matching
    gains: list = field(default_factory=lambda: [1.0, 1.0, 1.0])
    seed: int = 0


class Finisher:
    """The per-frame picture work for one take."""

    def __init__(self, settings: Settings, h: int, w: int, device, bits: int):
        self.s, self.device, self.bits = settings, device, bits
        self.frame = Frame(h, w, device)
        self.gen = torch.Generator(device=device)
        self.gen.manual_seed(settings.seed)
        self.lut = CubeLut(settings.lut, device) if settings.lut else None
        self.scale = self.frame.short / 2160
        self.gains = torch.tensor(settings.gains, device=device).view(3, 1, 1) * (2 ** settings.exposure)
        self.rtx = None
        if settings.output != 'sdr' and settings.expand == 'rtx':
            self.rtx = RtxHdr(settings.peak, device)
        self.max_cll = 0.0
        self.max_fall = 0.0

    def light(self, e: torch.Tensor) -> torch.Tensor:
        """R'G'B' in, working light out: deband, the look, the optics and the grain."""
        look, s = self.s.look, self.s
        if look.deband:
            e = deband(e, self.frame, self.gen, self.bits)
        if look.legacy is not None:
            x = x_from_sdr(e.pow(GAMMA), s.headroom) * self.gains
            e = sdr_from_x(x, s.headroom).pow(1 / GAMMA)
            e = legacy_look(e, self.frame, look.legacy, self.gen, self.lut, s.lut_mix)
            return x_from_sdr(e.pow(GAMMA), s.headroom)
        x = x_from_sdr(e.pow(GAMMA), s.headroom) * self.gains
        if self.lut is not None:
            # A bought look LUT is Rec.709 display in and out, so it runs on the
            # SDR picture and the result goes back into light: the same LUT
            # then drives the HDR master too.
            sdr = sdr_from_x(x, s.headroom).pow(1 / GAMMA)
            x = x_from_sdr(self.lut(sdr, s.lut_mix).clamp(0, 1).pow(GAMMA), s.headroom)
        warm = torch.tensor([1 + look.warmth, 1.0, 1 - look.warmth], device=self.device).view(3, 1, 1)
        x = x * warm * (2 ** look.exposure)
        if look.contrast != 1.0:
            y = luminance(x).clamp_min(1e-6)
            x = x * (0.18 * (y / 0.18) ** look.contrast) / y
        y = luminance(x)
        x = y + (x - y) * look.saturation
        if look.density:
            mx, mn = x.amax(0, keepdim=True), x.amin(0, keepdim=True)
            sat = ((mx - mn) / mx.clamp_min(1e-6)).clamp(0, 1)
            # Squared, so strong colours (a red top, foliage) deepen while
            # skin, a middling saturation, barely darkens.
            x = x * (1 - look.density * sat * sat)
        if look.skin:
            x = skin_pull(x, look.skin)
        if any(look.shadow_tint) or any(look.highlight_tint):
            y = luminance(x).clamp_min(1e-6)
            lg = torch.log2(y / 0.18)
            w_sh = (-lg / 4).clamp(0, 1)
            w_hi = ((lg - 1) / 3).clamp(0, 1)
            sh = torch.tensor(look.shadow_tint, device=self.device).view(3, 1, 1)
            hi = torch.tensor(look.highlight_tint, device=self.device).view(3, 1, 1)
            x = x * (1 + w_sh * sh + w_hi * hi)
        x = x.clamp_min(0.0)
        # Optics, in light: what a lens and a film stock add, in that order.
        if look.bloom:
            wide = blur(x, look.bloom_size * self.frame.short)
            near = blur(x, look.bloom_size * self.frame.short * 0.25)
            x = x * (1 - look.bloom) + (near * 0.6 + wide * 0.4) * look.bloom
        if look.halation:
            hot = (luminance(x) - 1.0).clamp_min(0.0)
            hal = blur(hot, look.halation_size * self.frame.short) * 0.7 + blur(hot, look.halation_size * self.frame.short * 3) * 0.3
            x = x + hal * torch.tensor([1.0, 0.32, 0.08], device=self.device).view(3, 1, 1) * look.halation
        if look.aberration:
            x = radial_aberration(x, self.frame, look.aberration * self.scale)
        if look.vignette:
            x = x * torch.exp2(-look.vignette * (self.frame.r / self.frame.rmax) ** 2.2)
        if look.lift:
            black = look.lift ** GAMMA
            x = black + x * (1 - black)
        if look.grain:
            x = film_grain(x, grain_field(self.frame, look, self.gen, self.scale), look.grain)
        return x

    def __call__(self, e: torch.Tensor) -> torch.Tensor:
        """R'G'B' (3,H,W) in, the output signal's R'G'B' out (Rec.709 BT.1886,
        or BT.2020 PQ / HLG)."""
        s = self.s
        if self.rtx is not None:
            # RTX Video HDR expands the graded SDR picture itself; grain goes on
            # after, since its debander would take it off.
            look = s.look
            graded = self.light_without_grain(e)
            nits = self.rtx(sdr_from_x(graded, s.headroom).pow(1 / GAMMA))
            if look.grain:
                x = matrix3(nits, M2020_709) / REF_WHITE
                x = film_grain(x, grain_field(self.frame, look, self.gen, self.scale), look.grain)
                nits = matrix3(x.clamp_min(0), M709_2020) * REF_WHITE
        else:
            x = self.light(e)
            if s.output == 'sdr':
                return sdr_from_x(x, s.headroom).pow(1 / GAMMA)
            nits = hdr_nits(x, s.peak)
        self.track(nits)
        return pq_encode(nits) if s.output == 'hdr10' else hlg_encode(nits, s.peak)

    def light_without_grain(self, e: torch.Tensor) -> torch.Tensor:
        look = self.s.look
        self.s.look = replace(look, grain=0.0) if look.legacy is None else replace(look, legacy={**look.legacy, 'grain': 0})
        try:
            return self.light(e)
        finally:
            self.s.look = look

    def track(self, nits: torch.Tensor) -> None:
        """MaxCLL and MaxFALL as the frames go by (HDR10's content light level)."""
        mx = nits.amax(0)
        self.max_cll = max(self.max_cll, float(torch.quantile(mx[::4, ::4].flatten().float(), 0.9999)))
        self.max_fall = max(self.max_fall, float(mx.mean()))


class RtxHdr:
    """NVIDIA RTX Video HDR (the VFX SDK's TrueHDR) on one frame: SDR R'G'B'
    in, BT.2020 display nits out. Imported only when asked for: nvvfx loads
    only where there is an NVIDIA driver."""

    def __init__(self, peak: float, device):
        import nvvfx  # noqa: PLC0415

        index = device.index if device.index is not None else torch.cuda.current_device()
        self.effect = nvvfx.TrueHDR(contrast=100, saturation=100, middle_gray=50, luminance=int(peak), debanding_off=0, device=index)
        self.effect.__enter__()
        self.effect.load()

    def __call__(self, e: torch.Tensor) -> torch.Tensor:
        result = self.effect.run(e.clamp(0, 1).contiguous())
        packed = torch.from_dlpack(result.image).clone().view(torch.int32)
        rgb = torch.stack([packed & 0x3FF, (packed >> 10) & 0x3FF, (packed >> 20) & 0x3FF]).float() / 1023
        return pq_decode(rgb)

    def close(self):
        self.effect.__exit__(None, None, None)


# --- Video I/O -------------------------------------------------------------------


def probe(path: Path) -> dict:
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)],
                         capture_output=True, text=True, check=True).stdout
    info = json.loads(out)
    video = next(s for s in info['streams'] if s['codec_type'] == 'video')
    pix = video.get('pix_fmt', 'yuv420p')
    rate = Fraction(video.get('r_frame_rate') or '24/1') if video.get('r_frame_rate', '0/0') != '0/0' else Fraction(24)
    return {
        'width': int(video['width']),
        'height': int(video['height']),
        'fps': f'{rate.numerator}/{rate.denominator}',
        'frames': int(video.get('nb_frames') or 0) or round(float(info['format'].get('duration', 0)) * rate),
        'bits': 10 if ('10' in pix or '12' in pix) else 8,
        'audio': any(s['codec_type'] == 'audio' for s in info['streams']),
        'duration': float(info['format'].get('duration', 0)),
    }


def sample_frames(path: Path, count: int, width: int, device) -> list[torch.Tensor]:
    """A few small R'G'B' frames spread through a video, for statistics."""
    info = probe(path)
    h = round(info['height'] * width / info['width'] / 2) * 2
    step = max(1, info['frames'] // count)
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-vf', f"select='not(mod(n\\,{step}))',scale={width}:{h}:flags=area",
                          '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-'], capture_output=True, check=True).stdout
    arr = np.frombuffer(raw, dtype='<u2').reshape(-1, h, width, 3)
    return [torch.from_numpy(f.astype(np.float32) / 65535).permute(2, 0, 1).to(device) for f in arr]


def encoder_args(output: str, encoder: str, max_cll: tuple[int, int]) -> tuple[list[str], str]:
    if output == 'sdr':
        tags = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
        if encoder == 'gpu':
            return ['-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', '14', '-b:v', '0', *tags], 'yuv420p'
        preset = 'slow' if encoder == 'cpu' else 'medium'
        return ['-c:v', 'libx264', '-preset', preset, '-crf', '14', '-pix_fmt', 'yuv420p',
                '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', *tags], 'yuv420p'
    trc = 'smpte2084' if output == 'hdr10' else 'arib-std-b67'
    tags = ['-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', trc, '-color_range', 'tv']
    if encoder == 'gpu':
        return ['-c:v', 'hevc_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', '14', '-b:v', '0',
                '-profile:v', 'main10', '-pix_fmt', 'p010le', *tags], 'yuv420p10le'
    params = f'colorprim=bt2020:transfer={trc}:colormatrix=bt2020nc:range=limited:repeat-headers=1'
    if output == 'hdr10':
        # Mastering display: P3-D65 at 1000 nits, what HDR10 is graded on.
        params += (':hdr10=1:hdr10-opt=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)'
                   f':max-cll={max_cll[0]},{max_cll[1]}')
    preset = 'medium' if encoder == 'cpu' else 'fast'
    return ['-c:v', 'libx265', '-preset', preset, '-crf', '14', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1',
            '-x265-params', params, *tags], 'yuv420p10le'


def nvenc_works(codec: str) -> bool:
    """Whether NVENC can encode here: ffmpeg lists it wherever it was built in,
    but it needs the driver's encode library, which a container gets only with
    the `video` capability."""
    done = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.1', '-frames:v', '1',
                           '-c:v', codec, '-f', 'null', '-'], capture_output=True)
    return done.returncode == 0


def default_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device('cuda')
    if torch.backends.mps.is_available():
        return torch.device('mps')
    return torch.device('cpu')


def prepare(src: Path, settings: Settings, match: Path | None, match_strength: float, device) -> tuple[Settings, dict]:
    """A pre-pass over small frames: the take's statistics, the matching gains
    against `match`, and an HDR10 light level estimate for the encoder's
    headers (x265 writes them before the first frame)."""
    report: dict = {}
    small = sample_frames(src, 12, 480, device)
    if match is not None and match_strength > 0:
        mine, theirs = take_stats(small, settings.headroom), take_stats(sample_frames(match, 12, 480, device), settings.headroom)
        stops, gains = match_gains(mine, theirs, match_strength)
        settings = replace(settings, exposure=stops, gains=gains)
        report['match'] = {'take': mine, 'reference': theirs, 'stops': round(stops, 3), 'gains': [round(g, 4) for g in gains]}
    if settings.output == 'hdr10':
        probe_settings = replace(settings, output='hdr10', expand='curve')
        f = Finisher(probe_settings, small[0].shape[1], small[0].shape[2], device, 8)
        for e in small:
            f(e)
        report['light_level_estimate'] = [round(f.max_cll), round(f.max_fall)]
    return settings, report


def finish_video(src: Path, dst: Path, settings: Settings, *, match: Path | None = None, match_strength: float = 0.0,
                 encoder: str = 'cpu', device=None, progress=None, interrupted=None) -> dict:
    """Finish `src` into `dst`. `progress(done, total)` is called per frame;
    `interrupted()` raises to stop. Returns a report (timings, light level,
    matching)."""
    device = device or default_device()
    started = time.time()
    info = probe(src)
    w, h = info['width'], info['height']
    if w % 2 or h % 2:
        raise ValueError(f'{src} is {w}x{h}: 4:2:0 video needs even dimensions')
    fallback = None
    if encoder == 'gpu' and not nvenc_works('h264_nvenc' if settings.output == 'sdr' else 'hevc_nvenc'):
        encoder, fallback = 'fast', 'NVENC is not available here (a container needs the video capability): encoded on the CPU'
    settings, report = prepare(src, settings, match, match_strength, device)
    if fallback:
        report['encoder_note'] = fallback
    cll = report.get('light_level_estimate', [int(settings.peak), int(settings.peak * 0.4)])
    max_cll = (min(int(settings.peak), int(cll[0] * 1.1) + 1), min(int(settings.peak), int(cll[1] * 1.2) + 1))
    codec, pix_out = encoder_args(settings.output, encoder, max_cll)
    bits_out = 10 if pix_out.endswith('10le') else 8
    pix_in = 'yuv420p10le' if info['bits'] == 10 else 'yuv420p'
    frame_bytes = w * h * 3 // 2 * (2 if info['bits'] == 10 else 1)

    # Passthrough: one raw frame per decoded frame. Raw output otherwise
    # defaults to constant frame rate and repeats frames over any gap in the
    # timestamps (a file cut without re-encoding has some), which shifts the
    # picture against the soundtrack.
    reader = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', str(src), '-map', '0:v:0', '-vsync', 'passthrough', '-f', 'rawvideo', '-pix_fmt', pix_in, '-'],
                              stdout=subprocess.PIPE, bufsize=frame_bytes * 2)
    dst.parent.mkdir(parents=True, exist_ok=True)
    # The raw frames carry no colour description; without one ffmpeg takes
    # them for BT.601 and converts them to the output's tags, shifting every
    # colour. setparams says what they already are.
    space = ('bt709', 'bt709', 'bt709') if settings.output == 'sdr' else \
        ('bt2020nc', 'bt2020', 'smpte2084' if settings.output == 'hdr10' else 'arib-std-b67')
    tag = f'setparams=colorspace={space[0]}:color_primaries={space[1]}:color_trc={space[2]}:range=tv'
    writer = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', pix_out, '-s', f'{w}x{h}', '-framerate', info['fps'],
                               '-i', '-', '-i', str(src), '-map', '0:v', '-map', '1:a?', '-vf', tag, '-c:a', 'copy', *codec,
                               '-movflags', '+faststart', str(dst)], stdin=subprocess.PIPE)
    frames_in: queue.Queue = queue.Queue(maxsize=4)
    frames_out: queue.Queue = queue.Queue(maxsize=4)
    errors: list[BaseException] = []
    stop = threading.Event()

    def put(q: queue.Queue, item) -> bool:
        # A put that gives up once the run is stopping, so a thread blocked
        # on a full queue cannot keep the job alive after an error.
        while not stop.is_set():
            try:
                q.put(item, timeout=0.5)
                return True
            except queue.Full:
                continue
        return False

    def read():
        try:
            while not stop.is_set():
                buf = reader.stdout.read(frame_bytes)
                if len(buf) < frame_bytes or not put(frames_in, buf):
                    break
        except BaseException as err:  # noqa: BLE001
            errors.append(err)
        finally:
            put(frames_in, None)

    def write():
        try:
            while not stop.is_set():
                try:
                    buf = frames_out.get(timeout=0.5)
                except queue.Empty:
                    continue
                if buf is None:
                    break
                writer.stdin.write(buf)
        except BaseException as err:  # noqa: BLE001
            errors.append(err)
        finally:
            try:
                writer.stdin.close()
            except OSError:
                pass

    threads = [threading.Thread(target=read, daemon=True), threading.Thread(target=write, daemon=True)]
    for t in threads:
        t.start()
    finisher = Finisher(settings, h, w, device, info['bits'])
    # The look is dozens of full-frame elementwise passes; compiled, they fuse
    # into a few kernels: 4x faster on the 5060 Ti (strong 0.089 -> 0.021 s a
    # 4K frame, film-strong 0.109 -> 0.040), for 7-10 s of compiling the first
    # time and 1-2 s once Inductor's cache has the graph. CUDA only, and not
    # around RTX Video HDR's own calls.
    step = finisher
    if device.type == 'cuda' and finisher.rtx is None:
        try:
            import triton  # noqa: F401, PLC0415

            step = torch.compile(finisher.__call__, dynamic=False)
        except Exception:  # noqa: BLE001
            step = finisher
    dither = torch.Generator(device=device)
    dither.manual_seed(settings.seed + 1)
    weights = LUMA_709 if settings.output == 'sdr' else LUMA_2020
    dtype = torch.uint8 if info['bits'] == 8 else torch.int16
    done, gpu_seconds = 0, 0.0
    try:
        with torch.inference_mode():
            while (buf := frames_in.get()) is not None:
                if interrupted:
                    interrupted()
                t0 = time.time()
                arr = torch.frombuffer(bytearray(buf), dtype=dtype).to(device).int()
                y = arr[:w * h].view(h, w)
                u = arr[w * h:w * h * 5 // 4].view(h // 2, w // 2)
                v = arr[w * h * 5 // 4:].view(h // 2, w // 2)
                rgb = yuv_to_rgb((y, u, v), info['bits'])
                try:
                    signal = step(rgb)
                except Exception:  # noqa: BLE001
                    if step is finisher:
                        raise
                    # A compiler failure is not the take's fault: carry on uncompiled.
                    step = finisher
                    signal = finisher(rgb)
                out = rgb_to_yuv(signal, bits_out, weights, dither)
                if bits_out == 10:
                    out = out.astype('<u2')
                gpu_seconds += time.time() - t0
                put(frames_out, out.tobytes())
                done += 1
                if progress:
                    progress(done, info['frames'])
                if errors:
                    raise errors[0]
    except BaseException:
        stop.set()
        reader.kill()
        writer.kill()
        writer.wait()
        dst.unlink(missing_ok=True)  # a half-written file must not look like a result
        raise
    finally:
        put(frames_out, None)
        for t in threads:
            t.join(timeout=60)
        if finisher.rtx is not None:
            finisher.rtx.close()
    if reader.wait() != 0 and not done:
        raise RuntimeError(f'ffmpeg could not decode {src}')
    if writer.wait() != 0:
        dst.unlink(missing_ok=True)
        raise RuntimeError(f'ffmpeg could not encode {dst} (an mp4 takes AAC or MP3 sound as it is; other sound fails here)')
    if errors:
        raise errors[0]
    elapsed = time.time() - started
    report.update({
        'frames': done, 'seconds': round(elapsed, 1), 'gpu_seconds': round(gpu_seconds, 1),
        'seconds_per_video_second': round(elapsed / max(1e-6, info['duration']), 2),
        'size': f'{w}x{h}', 'output': settings.output, 'encoder': codec[1], 'device': str(device),
    })
    if settings.output != 'sdr':
        report['light_level'] = [round(finisher.max_cll), round(finisher.max_fall)]
        report['light_level_tagged'] = list(max_cll) if settings.output == 'hdr10' else None
    return report


# --- Delivery LUTs ------------------------------------------------------------------


def write_delivery_luts(directory: Path, peak: float = 1000.0, headroom: float = 4.0, n: int = 65) -> list[Path]:
    """.cube LUTs that turn an HDR10 master into the other deliveries, so a cut
    composed once in PQ can be exported as HDR10, HLG and SDR without a second
    render: PQ->HLG (BT.2100 at `peak`) and PQ->Rec.709 SDR (this module's own
    tone mapping, so the SDR is the grade, not the platform's down-conversion)."""
    directory.mkdir(parents=True, exist_ok=True)
    g = torch.linspace(0, 1, n)
    b, gg, r = torch.meshgrid(g, g, g, indexing='ij')
    pq = torch.stack([r, gg, b]).reshape(3, -1, 1)
    nits = pq_decode(pq)
    written = []
    for name, out in (('pq-to-hlg.cube', hlg_encode(nits, peak)),
                      ('pq-to-sdr709.cube', sdr_from_x(matrix3(nits, M2020_709).clamp_min(0) / REF_WHITE, headroom).pow(1 / GAMMA))):
        path = directory / name
        rows = out.reshape(3, -1).T.clamp(0, 1).numpy()
        with open(path, 'w') as f:
            f.write(f'TITLE "{name[:-5]}"\nLUT_3D_SIZE {n}\n')
            f.writelines(f'{v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n' for v in rows)
        written.append(path)
    return written


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('src', type=Path)
    ap.add_argument('dst', type=Path)
    ap.add_argument('--look', choices=LOOKS, default='film')
    ap.add_argument('--output', choices=OUTPUTS, default='sdr')
    ap.add_argument('--peak', type=float, default=1000)
    ap.add_argument('--lut', type=Path)
    ap.add_argument('--lut-mix', type=float, default=1.0)
    ap.add_argument('--match', type=Path, help='a reference take whose skin and exposure this take is matched to')
    ap.add_argument('--match-strength', type=float, default=0.8)
    ap.add_argument('--expand', choices=('curve', 'rtx'), default='curve')
    ap.add_argument('--encoder', choices=('cpu', 'fast', 'gpu'), default='fast')
    ap.add_argument('--device')
    ap.add_argument('--luts', type=Path, help='also write the delivery LUTs into this directory')
    a = ap.parse_args()
    if a.luts:
        print(write_delivery_luts(a.luts, a.peak))
    s = Settings(look=LOOKS[a.look], output=a.output, peak=a.peak, lut=a.lut, lut_mix=a.lut_mix, expand=a.expand)
    rep = finish_video(a.src, a.dst, s, match=a.match, match_strength=a.match_strength if a.match else 0, encoder=a.encoder,
                       device=torch.device(a.device) if a.device else None,
                       progress=lambda d, t: print(f'\r{d}/{t}', end='', flush=True))
    print()
    print(json.dumps(rep, indent=2))
