"""Compose a presenter explainer: lip-synced presenter segments, real photos
coming and going over them, word-by-word captions, section chips, stat callouts,
and the voice lines over a ducked music bed. Everything a video needs is in its
project folder; `script.json` there holds the lines and the cues.

  python compose.py --project DIR align                  # Whisper word timings for voice/*.wav
  python compose.py --project DIR timeline               # where every cue lands
  python compose.py --project DIR render --scale 0.5 --out preview.mp4
  python compose.py --project DIR render --scale 1 --out final.mp4

The project folder: script.json, voice/<id>.wav (one line each), presenter/<id>.mp4
(that line's lip-synced take, any size; a segment fully covered by photos can be a
still loop), music/bed.wav (optional), and the photo folders script.json lists.
Every frame is composed in PIL and piped to ffmpeg, so motion is eased exactly.
Needs numpy, pillow, faster-whisper; fonts are macOS's Avenir Next.
"""
import argparse, json, math, re, subprocess, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

AVENIR = '/System/Library/Fonts/Avenir Next.ttc'
HEAVY, DEMI, MEDIUM = 8, 2, 5
ACCENT = (255, 212, 0)

# Set from the project's script.json by configure().
ROOT = Path('.')
FPS, W0, H0, PAD = 24, 2160, 3840, 0.35
PHOTO_DIRS, CREDIT, DEFAULT_CREDIT = [], {}, ''
CUES, CHIPS, STATS, HOOK, PUNCH = {}, {}, {}, None, 1.14


def configure(project):
    """Read script.json. Cues per segment: `at`/`until` are words of the line
    (first match after the previous cue; `a|b` matches either spelling, digits
    match Whisper's numerals); `until` absent runs to the next cue or the end of
    the line. style: card (a lower card, the face stays visible), fit (full
    screen, the whole photo over a blurred fill), pan (full screen, a 9:16
    window moving x0 -> x1 and y0 -> y1, zoomed by `zoom`). `enter: false`
    swaps a card in place (a table revealing rows)."""
    global ROOT, FPS, W0, H0, PAD, PHOTO_DIRS, CREDIT, DEFAULT_CREDIT, CUES, CHIPS, STATS, HOOK, PUNCH
    ROOT = Path(project).resolve()
    cfg = json.loads((ROOT / 'script.json').read_text())
    FPS = cfg.get('fps', 24)
    W0, H0 = cfg.get('size', [2160, 3840])
    PAD = cfg.get('pad', 0.35)
    PUNCH = cfg.get('punch', 1.14)
    PHOTO_DIRS = [ROOT / d for d in cfg.get('photo_dirs', ['photos'])]
    CREDIT = cfg.get('credits', {})
    DEFAULT_CREDIT = cfg.get('default_credit', '')
    CUES = {s['id']: s.get('cues', []) for s in cfg['segments']}
    CHIPS = {s['id']: s['chip'] for s in cfg['segments'] if s.get('chip')}
    STATS = {s['id']: [tuple(x) for x in s.get('stats', [])] for s in cfg['segments']}
    hook = cfg.get('hook')
    # `fill` (RGBA) backs the hook's lines: transparent suits a dark opening
    # frame, a bright sky needs a dark pill to stay readable. `y` is the first
    # line's centre as a fraction of the height; raise it when the presenter's
    # head sits high in the opening shot.
    HOOK = (hook['from'], hook['to'], hook['text'], tuple(hook.get('fill', (0, 0, 0, 0))), hook.get('y', 0.12)) if hook else None


def norm(w):
    w = re.sub(r"[^a-z0-9']", '', w.lower().replace('’', "'"))
    return {'tires': 'tyres', 'tire': 'tyre'}.get(w, w)


def ease(x):
    x = min(max(x, 0.0), 1.0)
    return 1 - (1 - x) ** 3


def font(index, px):
    return ImageFont.truetype(AVENIR, int(px), index=index)


def find_photo(name):
    for d in PHOTO_DIRS:
        p = d / f'{name}.jpg'
        if p.exists():
            return p
        p = d / f'{name}.png'
        if p.exists():
            return p
    raise FileNotFoundError(name)


def duration_of(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
                         capture_output=True, text=True, check=True).stdout
    return float(out.strip())


# ---------------------------------------------------------------- alignment

def align():
    from faster_whisper import WhisperModel
    model = WhisperModel('small.en', device='cpu', compute_type='int8')
    script = json.loads((ROOT / 'script.json').read_text())
    out = {}
    for seg in script['segments']:
        wav = ROOT / 'voice' / f"{seg['id']}.wav"
        if not wav.exists():
            continue
        pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(wav), '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'],
                             capture_output=True, check=True).stdout
        parts, _ = model.transcribe(np.frombuffer(pcm, np.float32), word_timestamps=True, initial_prompt=seg['text'])
        words = []
        for w in (w for p in parts for w in p.words):
            text = w.word.strip()
            if words and text.startswith('-'):
                words[-1]['w'] += text
                words[-1]['e'] = round(w.end, 3)
            else:
                words.append(dict(w=text, s=round(w.start, 3), e=round(w.end, 3)))
        out[seg['id']] = dict(duration=duration_of(wav), words=words,
                              heard=' '.join(w['w'] for w in words))
        print(seg['id'], out[seg['id']]['heard'])
    (ROOT / 'align.json').write_text(json.dumps(out, indent=1))


# ---------------------------------------------------------------- timeline

def build_timeline():
    script = json.loads((ROOT / 'script.json').read_text())
    al = json.loads((ROOT / 'align.json').read_text())
    t = 0.0
    segs = []
    for i, seg in enumerate(script['segments']):
        a = al[seg['id']]
        dur = a['duration'] + PAD
        words = [dict(w, s=w['s'] + t, e=w['e'] + t) for w in a['words']]

        def at(word, after=0.0):
            alts = {norm(x) for x in word.split('|')}
            for w in words:
                forms = {norm(w['w']), norm(w['w'].split('-')[0])}
                if w['s'] >= after - 1e-6 and (forms & alts or any(norm(w['w']).startswith(x) and x.isdigit() for x in alts)):
                    return w['s']
            raise KeyError(f"{seg['id']}: no '{word}' after {after:.2f} in {[w['w'] for w in words]}")

        cues = []
        last = t
        for c in CUES.get(seg['id'], []):
            s = at(c['at'], last)
            cues.append(dict(c, s=s))
            last = s
        for j, c in enumerate(cues):
            if c.get('until'):
                c['e'] = at(c['until'], c['s'])
            elif j + 1 < len(cues):
                c['e'] = cues[j + 1]['s']
            else:
                c['e'] = t + dur
        stats = []
        last = t
        for word, label in STATS.get(seg['id'], []):
            s = at(word, last)
            stats.append(dict(s=s, label=label))
            last = s
        for j, st in enumerate(stats):
            st['e'] = stats[j + 1]['s'] if j + 1 < len(stats) else t + dur
        segs.append(dict(id=seg['id'], t0=t, t1=t + dur, words=words, cues=cues, stats=stats,
                         chip=CHIPS.get(seg['id']), punch=1.0 if i % 2 == 0 else PUNCH))
        t += dur
    return segs, t


def caption_groups(words, max_chars=18, max_words=4):
    groups, cur = [], []
    for w in words:
        cur.append(w)
        text = ' '.join(x['w'] for x in cur)
        if len(cur) >= max_words or len(text) >= max_chars or re.search(r'[.,?!:;]$', w['w']):
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    out = []
    for i, g in enumerate(groups):
        end = groups[i + 1][0]['s'] if i + 1 < len(groups) else g[-1]['e'] + 0.25
        out.append(dict(s=g[0]['s'], e=min(end, g[-1]['e'] + 0.6), words=g))
    return out


# ---------------------------------------------------------------- drawing

class Painter:
    def __init__(self, scale):
        self.W, self.H = int(W0 * scale) // 2 * 2, int(H0 * scale) // 2 * 2
        self.s = scale
        self.cache = {}
        self.f_cap = font(HEAVY, 150 * scale)
        self.f_chip = font(DEMI, 62 * scale)
        self.f_stat = font(HEAVY, 92 * scale)
        self.f_credit = font(MEDIUM, 40 * scale)
        self.f_hook = font(HEAVY, 132 * scale)

    def photo(self, name):
        if name not in self.cache:
            self.cache[name] = Image.open(find_photo(name)).convert('RGB')
        return self.cache[name]

    def card_layer(self, name):
        key = ('card', name)
        if key in self.cache:
            return self.cache[key]
        im = self.photo(name)
        maxw, maxh = int(self.W * 0.92), int(self.H * 0.36)
        r = min(maxw / im.width, maxh / im.height)
        im = im.resize((int(im.width * r), int(im.height * r)), Image.LANCZOS)
        rad = int(44 * self.s)
        mask = Image.new('L', im.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.width - 1, im.height - 1], rad, fill=255)
        m = int(60 * self.s)
        layer = Image.new('RGBA', (im.width + 2 * m, im.height + 2 * m), (0, 0, 0, 0))
        shadow = Image.new('L', layer.size, 0)
        ImageDraw.Draw(shadow).rounded_rectangle([m, m + int(14 * self.s), m + im.width, m + im.height + int(14 * self.s)], rad, fill=170)
        shadow = shadow.filter(ImageFilter.GaussianBlur(int(26 * self.s)))
        layer.paste((0, 0, 0, 255), (0, 0), shadow)
        border = Image.new('RGBA', (im.width + int(8 * self.s), im.height + int(8 * self.s)), (0, 0, 0, 0))
        ImageDraw.Draw(border).rounded_rectangle([0, 0, border.width - 1, border.height - 1], rad + int(4 * self.s), fill=(255, 255, 255, 60))
        layer.alpha_composite(border, (m - int(4 * self.s), m - int(4 * self.s)))
        layer.paste(im, (m, m), mask)
        credit = CREDIT.get(name, DEFAULT_CREDIT)
        d = ImageDraw.Draw(layer)
        if not credit:
            self.cache[key] = layer
            return layer
        text = f'Image: {credit}'
        tw = d.textlength(text, font=self.f_credit)
        pad = int(14 * self.s)
        x0, y0 = m + im.width - tw - 3 * pad, m + im.height - int(64 * self.s)
        d.rounded_rectangle([x0, y0, x0 + tw + 2 * pad, y0 + int(52 * self.s)], int(20 * self.s), fill=(0, 0, 0, 140))
        d.text((x0 + pad, y0 + int(4 * self.s)), text, font=self.f_credit, fill=(255, 255, 255, 220))
        self.cache[key] = layer
        return layer

    def blurred_fill(self, name):
        key = ('fill', name)
        if key not in self.cache:
            im = self.photo(name)
            r = max(self.W / im.width, self.H / im.height)
            bg = im.resize((math.ceil(im.width * r), math.ceil(im.height * r)), Image.BILINEAR)
            bg = bg.crop(((bg.width - self.W) // 2, (bg.height - self.H) // 2, (bg.width - self.W) // 2 + self.W, (bg.height - self.H) // 2 + self.H))
            bg = bg.filter(ImageFilter.GaussianBlur(int(60 * self.s)))
            bg = Image.blend(bg, Image.new('RGB', bg.size, (0, 0, 0)), 0.45)
            self.cache[key] = bg
        return self.cache[key]

    def full_frame(self, cue, p):
        """A full-screen photo; p is 0..1 through its time on screen."""
        im = self.photo(cue['img'])
        if cue['style'] == 'fit':
            frame = self.blurred_fill(cue['img']).copy()
            z = 1.0 + 0.05 * p
            w = int(self.W * 0.98 * z)
            h = int(im.height * w / im.width)
            fg = im.resize((w, h), Image.LANCZOS)
            frame.paste(fg, ((self.W - w) // 2, int(self.H * 0.40 - h / 2)))
            return frame
        zoom = cue.get('zoom', 1.0) * (1.0 + 0.04 * p)
        ch = im.height / zoom
        cw = ch * self.W / self.H
        if cw > im.width:
            cw = im.width
            ch = cw * self.H / self.W
        x = cue.get('x0', 0.5) + (cue.get('x1', 0.5) - cue.get('x0', 0.5)) * (0.5 - 0.5 * math.cos(math.pi * p))
        cx = min(max(x * im.width, cw / 2), im.width - cw / 2)
        y = cue.get('y0', 0.5) + (cue.get('y1', cue.get('y0', 0.5)) - cue.get('y0', 0.5)) * (0.5 - 0.5 * math.cos(math.pi * p))
        cy = min(max(y * im.height, ch / 2), im.height - ch / 2)
        box = (max(cx - cw / 2, 0), max(cy - ch / 2, 0), min(cx + cw / 2, im.width), min(cy + ch / 2, im.height))
        return im.resize((self.W, self.H), Image.LANCZOS, box=box)

    def pill(self, frame, text, fnt, cy, fill=(0, 0, 0, 165), fg=(255, 255, 255), alpha=1.0, accent=None):
        d = ImageDraw.Draw(frame)
        tw = d.textlength(text, font=fnt)
        asc, desc = fnt.getmetrics()
        padx, pady = int(fnt.size * 0.55), int(fnt.size * 0.28)
        w, h = int(tw + 2 * padx), int(asc + desc + 2 * pady)
        layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        ld.rounded_rectangle([0, 0, w - 1, h - 1], h // 2, fill=fill)
        if accent:
            ld.rounded_rectangle([0, 0, w - 1, h - 1], h // 2, outline=accent, width=max(2, int(5 * self.s)))
        ld.text((padx, pady), text, font=fnt, fill=fg)
        if alpha < 1:
            layer.putalpha(layer.getchannel('A').point(lambda a: int(a * alpha)))
        frame.alpha_composite(layer, ((self.W - w) // 2, int(cy - h / 2)))

    def caption(self, frame, group, t):
        d = ImageDraw.Draw(frame)
        f = self.f_cap
        words = [w['w'] for w in group['words']]
        widths = [d.textlength(w, font=f) for w in words]
        space = d.textlength(' ', font=f)
        total = sum(widths) + space * (len(words) - 1)
        if total > self.W * 0.9:
            f = font(HEAVY, f.size * self.W * 0.9 / total)
            widths = [d.textlength(w, font=f) for w in words]
            space = d.textlength(' ', font=f)
            total = sum(widths) + space * (len(words) - 1)
        x = (self.W - total) / 2
        y = self.H * 0.835
        pop = ease((t - group['s']) / 0.12)
        stroke = max(3, int(f.size * 0.09))
        for w, wd, wi in zip(group['words'], widths, words):
            active = w['s'] <= t < max(w['e'], w['s'] + 0.12)
            col = ACCENT if active else (255, 255, 255)
            dy = -int(10 * self.s * (1 - pop)) if active else 0
            d.text((x, y + dy), wi, font=f, fill=col, stroke_width=stroke, stroke_fill=(0, 0, 0))
            x += wd + space


class PresenterReader:
    """Decodes one segment's clip at a time; holds its last frame if it runs short."""
    def __init__(self, painter):
        self.p, self.sid, self.proc, self.k, self.img = painter, None, None, -1, None

    def frame(self, sid, want):
        if sid != self.sid:
            if self.proc:
                self.proc.kill()
            path = ROOT / 'presenter' / f'{sid}.mp4'
            # Cover the frame (the masters are 2192x3840, a touch wider than 9:16) rather than letterbox it.
            self.h = self.p.H
            self.proc = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', str(path), '-vf',
                                          f'scale={self.p.W}:{self.p.H}:force_original_aspect_ratio=increase:flags=lanczos,'
                                          f'crop={self.p.W}:{self.p.H},fps={FPS}', '-f', 'rawvideo',
                                          '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
            self.sid, self.k, self.img = sid, -1, None
        size = self.p.W * self.h * 3
        while self.k < want:
            buf = self.proc.stdout.read(size)
            if len(buf) < size:
                break
            self.k += 1
            self.img = Image.frombuffer('RGB', (self.p.W, self.h), buf)
        return self.img


def render(scale, out, start=0.0, end=None):
    segs, total = build_timeline()
    end = total if end is None else min(end, total)
    p = Painter(scale)
    captions = [g for s in segs for g in caption_groups(s['words'])]
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{p.W}x{p.H}',
                            '-r', str(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16',
                            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(ROOT / 'video-only.mp4')],
                           stdin=subprocess.PIPE)
    reader = PresenterReader(p)
    n0, n1 = int(start * FPS), int(end * FPS)
    for n in range(n1):
        t = n / FPS
        si = next(i for i, s in enumerate(segs) if s['t0'] <= t < s['t1'] or i == len(segs) - 1)
        seg = segs[si]
        mimg = reader.frame(seg['id'], int((t - seg['t0']) * FPS))
        if n < n0:
            continue
        frame = Image.new('RGBA', (p.W, p.H), (8, 8, 10, 255))
        if mimg is not None:
            z = seg['punch']
            mw, mh = int(p.W * z), int(mimg.height * z)
            m = mimg.resize((mw, mh), Image.BICUBIC) if z != 1 else mimg
            frame.paste(m, (-(mw - p.W) // 2, -int((mh - p.H) * 0.25)))
        # Full-screen photos replace the presenter; cards sit over their lower half.
        for c in seg['cues']:
            if not (c['s'] - 0.001 <= t < c['e'] + 0.25):
                continue
            prog = (t - c['s']) / max(c['e'] - c['s'], 0.1)
            fade_in = ease((t - c['s']) / 0.22) if c.get('enter', True) else 1.0
            fade_out = 1 - ease((t - c['e']) / 0.25) if t > c['e'] else 1.0
            a = fade_in * fade_out
            if c['style'] in ('fit', 'pan'):
                img = p.full_frame(c, min(prog, 1.0)).convert('RGBA')
                if a < 1:
                    img.putalpha(int(255 * a))
                frame.alpha_composite(img)
            else:
                layer = p.card_layer(c['img'])
                dy = int(90 * p.s * (1 - fade_in))
                if a < 1:
                    layer = layer.copy()
                    layer.putalpha(layer.getchannel('A').point(lambda v: int(v * a)))
                frame.alpha_composite(layer, ((p.W - layer.width) // 2, int(p.H * 0.635 - layer.height / 2) + dy))
        if seg['chip']:
            first = si == 0 or segs[si - 1]['chip'] != seg['chip']
            a = ease((t - seg['t0']) / 0.3) if first else 1.0
            p.pill(frame, seg['chip'], p.f_chip, p.H * 0.065, alpha=a, accent=ACCENT)
        for stt in seg['stats']:
            if stt['s'] <= t < stt['e']:
                a = ease((t - stt['s']) / 0.18)
                p.pill(frame, stt['label'], p.f_stat, p.H * 0.452, fill=(255, 212, 0, 235), fg=(10, 10, 10), alpha=a)
        if HOOK and HOOK[0] <= t < HOOK[1]:
            a = ease((t - HOOK[0]) / 0.2) * (1 - ease((t - HOOK[1] + 0.25) / 0.25))
            for k, line in enumerate(HOOK[2].split('\n')):
                p.pill(frame, line, p.f_hook, p.H * (HOOK[4] + 0.065 * k), fill=HOOK[3], alpha=a)
        g = next((g for g in captions if g['s'] <= t < g['e']), None)
        if g:
            p.caption(frame, g, t)
        enc.stdin.write(frame.convert('RGB').tobytes())
        if n % (FPS * 5) == 0:
            print(f'{t:6.1f}/{end:.1f}s', flush=True)
    enc.stdin.close()
    enc.wait()
    mix(segs, total, start, end, out)


def mix(segs, total, start, end, out):
    """Voice lines at their slots, music under them ducked by the voice."""
    inputs, filters = [], []
    for i, s in enumerate(segs):
        inputs += ['-i', str(ROOT / 'voice' / f"{s['id']}.wav")]
        ms = int(s['t0'] * 1000)
        filters.append(f'[{i}:a]aresample=48000,pan=stereo|c0=c0|c1=c0,adelay={ms}|{ms}[v{i}]')
    n = len(segs)
    filters.append(''.join(f'[v{i}]' for i in range(n)) + f'amix=inputs={n}:normalize=0,apad,atrim=0:{total:.3f},asplit=2[voice][key]')
    music = ROOT / 'music' / 'bed.wav'
    if music.exists():
        inputs += ['-i', str(music)]
        filters.append(f'[{n}:a]aresample=48000,volume=0.32,afade=t=out:st={total - 2.5:.3f}:d=2.5,apad,atrim=0:{total:.3f}[m]')
        filters.append('[m][key]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[duck]')
        filters.append(f'[voice][duck]amix=inputs=2:normalize=0,atrim={start:.3f}:{end:.3f},asetpts=PTS-STARTPTS,loudnorm=I=-14:TP=-1.5:LRA=9[a]')
    else:
        filters.append(f'[key]anullsink;[voice]atrim={start:.3f}:{end:.3f},asetpts=PTS-STARTPTS,loudnorm=I=-14:TP=-1.5:LRA=9[a]')
    inputs += ['-i', str(ROOT / 'video-only.mp4')]
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', ';'.join(filters),
                    '-map', f'{len(segs) + (1 if music.exists() else 0)}:v', '-map', '[a]',
                    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k',
                    '-shortest', '-movflags', '+faststart', str(ROOT / out)], check=True)
    print('wrote', ROOT / out)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['align', 'render', 'timeline'])
    ap.add_argument('--project', default='.', help="the video's folder (script.json, voice/, presenter/, music/)")
    ap.add_argument('--scale', type=float, default=0.5)
    ap.add_argument('--out', default='preview.mp4')
    ap.add_argument('--start', type=float, default=0.0)
    ap.add_argument('--end', type=float, default=None)
    a = ap.parse_args()
    configure(a.project)
    if a.cmd == 'align':
        align()
    elif a.cmd == 'timeline':
        segs, total = build_timeline()
        print(json.dumps([dict(id=s['id'], t0=round(s['t0'], 2), t1=round(s['t1'], 2),
                               cues=[(c['img'], round(c['s'], 2), round(c['e'], 2)) for c in s['cues']]) for s in segs], indent=1))
        print('total', round(total, 2))
    else:
        render(a.scale, a.out, a.start, a.end)
