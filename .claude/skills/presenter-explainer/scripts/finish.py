"""The finishing look for presenter takes, as one ffmpeg pass per take, before compose.py
puts photos, captions and pills on top (they stay clean). The user's stack, bottom to top:

  1. grade: a warm filmic 3D LUT written here (lifted blacks, soft highlight shoulder,
     cool shadows / warm highlights), so the sets match each other
  2. film texture: luma grain that changes every frame, blended in overlay mode so it
     sits in the midtones and shadows rather than on clipped highlights
  3. optical polish: halation (highlights blurred and tinted red-orange, screened back),
     a wider neutral glow, a slight chromatic shift, a soft vignette
  4. export: x264 (or ProRes 422 HQ with --prores) tagged Rec.709

  python finish.py --project DIR --look medium S01 S02 ...      # presenter/S01.mp4 -> finished/S01.mp4
  python finish.py --project DIR --look subtle --in presenter/S04.mp4 --out ab/S04-subtle.mp4
  python finish.py --project DIR --look medium --lut ~/luts/2383.cube --lut-mix 0.6 S01 ...   # a bought LUT as the grade

Speed ramps belong to the cut, not here. Lens flares are left out on purpose: generated
flares look pasted on, and the beach takes have the real sun.
"""
import argparse, subprocess
from pathlib import Path

import numpy as np

LOOKS = {
    # grade: mix of the LUT with identity; lift: black point; grain: noise strength before the
    # overlay; grain_size: blur sigma of the grain at 4K (bigger = coarser, and it has to be
    # coarse to survive a phone-size view and the platforms' compression); grain_mix: overlay
    # opacity; hal: halation opacity; glow: glow opacity; shift: chromatic shift in px at 4K;
    # vig: vignette angle. The first A/B (grain 28-46, size 0.9, mix 0.10-0.24) was invisible
    # to the user on a phone.
    'subtle': dict(grade=0.75, lift=0.035, grain=60, grain_size=1.6, grain_mix=0.30, hal=0.25, glow=0.08, shift=2, vig=0.30),
    'medium': dict(grade=1.00, lift=0.055, grain=80, grain_size=2.0, grain_mix=0.45, hal=0.40, glow=0.14, shift=3, vig=0.40),
    'strong': dict(grade=1.00, lift=0.080, grain=100, grain_size=2.4, grain_mix=0.60, hal=0.60, glow=0.22, shift=4, vig=0.50),
}


def write_lut(path, mix, lift, n=33):
    """A warm filmic grade as a .cube: per channel tone curve with lifted blacks and a soft
    shoulder, then split toning by luma (shadows a touch teal, highlights warm), a little
    less saturation in the brightest tones, all mixed with identity by `mix`."""
    g = np.linspace(0, 1, n)
    b, gg, r = np.meshgrid(g, g, g, indexing='ij')  # .cube order: red fastest
    rgb = np.stack([r, gg, b], -1)

    def tone(x):
        x = lift + (1 - lift) * x                       # lifted blacks
        x = x / (1 + 0.18 * x)                          # soft highlight shoulder ...
        x = x / (1 / (1 + 0.18))                        # ... renormalised so white stays white
        return np.clip(0.5 + (x - 0.5) * 1.10, 0, 1)    # gentle contrast

    out = tone(rgb)
    y = (out * [0.2126, 0.7152, 0.0722]).sum(-1, keepdims=True)
    shadows, highs = np.clip(1 - y * 2, 0, 1), np.clip(y * 2 - 1, 0, 1)
    out = out + shadows * [-0.030, 0.010, 0.035] + highs * [0.040, 0.012, -0.035]
    sat = 1 - 0.12 * highs
    out = y + (out - y) * sat
    out = np.clip(rgb + (out - rgb) * mix, 0, 1)
    with open(path, 'w') as f:
        f.write(f'TITLE "presenter warm"\nLUT_3D_SIZE {n}\n')
        for v in out.reshape(-1, 3):
            f.write(f'{v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n')


def graph(look, lut, width, lut_mix=1.0):
    k = width / 2160  # strengths are tuned at 4K width
    hal_sigma, glow_sigma = 18 * k, 70 * k
    shift = max(1, round(look['shift'] * k))
    # A bought or downloaded LUT is mixed back toward the untouched take by `lut_mix`, the
    # way a colourist dials a look's strength; the built-in grade already carries its mix.
    grade = (f"[0:v]format=gbrp,split=2[o][l];[l]lut3d=file='{lut}':interp=tetrahedral[lg];"
             f"[o][lg]blend=all_mode=normal:all_opacity={lut_mix},split=3[base][h][gl];" if lut_mix < 1 else
             f"[0:v]format=gbrp,lut3d=file='{lut}':interp=tetrahedral,split=3[base][h][gl];")
    return (
        grade +
        # Halation: only near-clipped tones (sun, window, speculars), not lit skin, which
        # glowed and lost definition at a 205 threshold in the first A/B.
        f"[h]lutrgb=r='if(gt(val,228),(val-228)*9,0)':g='if(gt(val,228),(val-228)*9,0)':b='if(gt(val,228),(val-228)*9,0)',"
        f"gblur=sigma={hal_sigma:.1f},colorchannelmixer=rr=1:gg=0.38:bb=0.12[hal];"
        f"[gl]lutrgb=r='if(gt(val,212),(val-212)*5,0)':g='if(gt(val,212),(val-212)*5,0)':b='if(gt(val,212),(val-212)*5,0)',"
        f"gblur=sigma={glow_sigma:.1f}[glow];"
        f"[base][hal]blend=all_mode=screen:all_opacity={look['hal']}[a];"
        f"[a][glow]blend=all_mode=screen:all_opacity={look['glow']}[b];"
        f"[b]rgbashift=rh=-{shift}:bh={shift},vignette=angle={look['vig']}[c];"
        # Grain: a mid-grey plate with temporal luma noise, softened to film-grain size.
        f"color=c=0x808080:s={width}x{{h}}:r=24,format=gbrp,noise=alls={look['grain']}:allf=t+u,"
        f"gblur=sigma={look['grain_size'] * k:.2f}[grain];"
        f"[c][grain]blend=all_mode=overlay:all_opacity={look['grain_mix']}:shortest=1,format=yuv420p[v]"
    )


def finish(src, dst, look, lut, prores=False, lut_mix=1.0):
    w, h = map(int, subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                                    '-of', 'csv=p=0', str(src)], capture_output=True, text=True).stdout.strip().split(','))
    fg = graph(look, lut, w, lut_mix).replace('{h}', str(h))
    tags = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
    codec = (['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'] if prores
             else ['-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p'])
    if prores:
        fg = fg.replace('format=yuv420p[v]', 'format=yuv422p10le[v]')
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(src), '-filter_complex', fg, '-map', '[v]', '-map', '0:a?',
                    *codec, *tags, '-c:a', 'copy', str(dst)], check=True)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('ids', nargs='*')
    ap.add_argument('--project', default='.')
    ap.add_argument('--look', choices=LOOKS, default='medium')
    ap.add_argument('--in', dest='src')
    ap.add_argument('--out')
    ap.add_argument('--prores', action='store_true')
    ap.add_argument('--lut', help='a Rec.709-input creative .cube to use instead of the built-in grade (never a log-input LUT: H3 takes are display Rec.709)')
    ap.add_argument('--lut-mix', type=float, default=1.0, help='strength of --lut, 0..1')
    a = ap.parse_args()
    root = Path(a.project).expanduser().resolve()
    look = LOOKS[a.look]
    if a.lut:
        lut = Path(a.lut).expanduser().resolve()
    else:
        lut = root / f'grade-{a.look}.cube'
        write_lut(lut, look['grade'], look['lift'])
    jobs = [(Path(a.src), Path(a.out))] if a.src else [(root / 'presenter' / f'{i}.mp4', root / 'finished' / f'{i}.mp4') for i in a.ids]
    for src, dst in jobs:
        src, dst = (root / src if not src.is_absolute() else src), (root / dst if not dst.is_absolute() else dst)
        finish(src, dst, look, lut, a.prores, a.lut_mix if a.lut else 1.0)
        print(dst)
