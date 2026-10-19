"""Make a video's covers (thumbnails) from `covers.json` in its project folder:
a clean frame of a presenter take or a generated still, bold title text, and
optionally a real photo of the subject on a card with its credit. Every cover is
1080x1920 with what matters inside the centre 3:4, which Instagram's profile
grid crops to.

  python covers.py --project DIR          # writes DIR/covers/<name>.jpg and covers/sheet.jpg

covers.json:
  {"covers": [
    {"name": "a", "take": "S01", "t": 2.0,              # a frame of presenter/S01.mp4 (no captions burned in)
     "text": ["WHY IS THE", "*SUNSET* ORANGE?"],         # *word* is drawn in the accent colour
     "text_y": 0.2},                                    # centre of the text block, as a fraction of the height
    {"name": "b", "image": "covers/src/pose.png", "zoom": 1.1, "y": 0.4,
     "text": ["..."], "photo": "event-refs/d1-upside.jpg", "credit": "Tesla livestream",
     "photo_y": 0.68},                                  # centre of the photo card
    {"name": "c", "image": "event-refs/x.jpg", "fit": true, "credit": "Tesla livestream", "text": ["..."]}
                                                         # a landscape photo whole, over a blurred fill
  ]}
Paths are relative to the project. Needs pillow; fonts are macOS's Avenir Next.
"""
import argparse, io, json, subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

AVENIR = '/System/Library/Fonts/Avenir Next.ttc'
HEAVY, MEDIUM = 8, 5
ACCENT = (255, 212, 0)
W, H = 1080, 1920
# The 3:4 window Instagram's grid shows, centred: 1080x1440 from y=240.
SAFE = (240, 1680)


def font(index, px):
    return ImageFont.truetype(AVENIR, int(px), index=index)


def fill_frame(im, zoom=1.0, y=0.5):
    """Scale to cover 1080x1920, then crop; `y` picks the vertical position of the crop."""
    r = max(W / im.width, H / im.height) * zoom
    im = im.resize((round(im.width * r), round(im.height * r)), Image.LANCZOS)
    x0 = (im.width - W) // 2
    y0 = round((im.height - H) * min(max(y, 0.0), 1.0))
    return im.crop((x0, y0, x0 + W, y0 + H))


def fit_photo(im):
    """A landscape photo whole across the width, over a blurred, darkened fill of itself."""
    bg = fill_frame(im).filter(ImageFilter.GaussianBlur(40))
    bg = Image.blend(bg, Image.new('RGB', bg.size, (0, 0, 0)), 0.45)
    w = W
    h = round(im.height * w / im.width)
    bg.paste(im.resize((w, h), Image.LANCZOS), (0, (H - h) // 2))
    return bg, (H - h) // 2 + h


def credit_pill(frame, credit, right, bottom):
    d = ImageDraw.Draw(frame, 'RGBA')
    f = font(MEDIUM, 26)
    text = f'Image: {credit}'
    tw = d.textlength(text, font=f)
    bx, by = right - tw - 34, bottom - 50
    d.rounded_rectangle([bx, by, bx + tw + 20, by + 38], 12, fill=(0, 0, 0, 150))
    d.text((bx + 10, by + 3), text, font=f, fill=(255, 255, 255))


def take_frame(root, take, t):
    png = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', str(root / 'presenter' / f'{take}.mp4'),
                          '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True, check=True).stdout
    return Image.open(io.BytesIO(png)).convert('RGB')


def shade(frame, cy):
    """Darken a soft band behind the text so white type reads over a bright sky."""
    band = Image.new('L', (W, H), 0)
    ImageDraw.Draw(band).rectangle([0, cy - 330, W, cy + 330], fill=150)
    band = band.filter(ImageFilter.GaussianBlur(120))
    frame.paste((0, 0, 0), (0, 0), band)


def title(frame, lines, cy):
    d = ImageDraw.Draw(frame)
    # `*` toggles the accent, so *UPSIDE DOWN* colours both words.
    words, on = [], False
    for line in lines:
        row = []
        for w in line.split():
            start = w.startswith('*')
            on = on or start
            row.append((w.strip('*'), on))
            if w.endswith('*') and (len(w) > 1 or not start):
                on = False
        words.append(row)
    size = 150
    while True:
        f = font(HEAVY, size)
        widest = max(sum(d.textlength(w + ' ', font=f) for w, _ in line) for line in words)
        if widest <= W * 0.88 or size <= 70:
            break
        size -= 4
    lh = size * 1.08
    y = cy - lh * len(words) / 2
    for line in words:
        total = sum(d.textlength(w, font=f) for w, _ in line) + d.textlength(' ', font=f) * (len(line) - 1)
        x = (W - total) / 2
        for w, accent in line:
            d.text((x, y), w, font=f, fill=ACCENT if accent else (255, 255, 255),
                   stroke_width=max(4, size // 18), stroke_fill=(0, 0, 0))
            x += d.textlength(w + ' ', font=f)
        y += lh


def photo_card(frame, path, credit, cy):
    im = Image.open(path).convert('RGB')
    maxw, maxh = int(W * 0.86), int(H * 0.27)
    r = min(maxw / im.width, maxh / im.height)
    im = im.resize((int(im.width * r), int(im.height * r)), Image.LANCZOS)
    x, y = (W - im.width) // 2, int(cy - im.height / 2)
    rad = 28
    shadow = Image.new('L', (W, H), 0)
    ImageDraw.Draw(shadow).rounded_rectangle([x, y + 12, x + im.width, y + im.height + 12], rad, fill=180)
    frame.paste((0, 0, 0), (0, 0), shadow.filter(ImageFilter.GaussianBlur(22)))
    mask = Image.new('L', im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.width - 1, im.height - 1], rad, fill=255)
    ImageDraw.Draw(frame).rounded_rectangle([x - 5, y - 5, x + im.width + 5, y + im.height + 5], rad + 5, fill=(255, 255, 255))
    frame.paste(im, (x, y), mask)
    if credit:
        credit_pill(frame, credit, x + im.width, y + im.height)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project', default='.')
    a = ap.parse_args()
    root = Path(a.project).resolve()
    spec = json.loads((root / 'covers.json').read_text())
    out = root / 'covers'
    out.mkdir(exist_ok=True)
    made = []
    for c in spec['covers']:
        base = take_frame(root, c['take'], c.get('t', 1.0)) if 'take' in c else Image.open(root / c['image']).convert('RGB')
        cy = H * c.get('text_y', 0.2)
        if c.get('fit'):
            frame, photo_bottom = fit_photo(base)
        else:
            frame = fill_frame(base, c.get('zoom', 1.0), c.get('y', 0.5))
        shade(frame, cy)
        if c.get('fit') and c.get('credit'):
            credit_pill(frame, c['credit'], W - 10, photo_bottom)
        if c.get('photo'):
            photo_card(frame, root / c['photo'], c.get('credit', ''), H * c.get('photo_y', 0.68))
        title(frame, c['text'], cy)
        path = out / f"{c['name']}.jpg"
        frame.save(path, quality=92)
        made.append(frame)
        print('wrote', path)
    # A contact sheet with the 3:4 grid crop marked, to check nothing important falls outside it.
    tw = 360
    sheet = Image.new('RGB', (tw * len(made) + 20 * (len(made) - 1), tw * 16 // 9), (30, 30, 30))
    for i, f in enumerate(made):
        small = f.resize((tw, tw * 16 // 9))
        d = ImageDraw.Draw(small)
        s = tw / W
        d.rectangle([0, SAFE[0] * s, tw - 1, SAFE[1] * s], outline=(0, 255, 120), width=2)
        sheet.paste(small, (i * (tw + 20), 0))
    sheet.save(out / 'sheet.jpg', quality=88)
    print('wrote', out / 'sheet.jpg')


if __name__ == '__main__':
    main()
