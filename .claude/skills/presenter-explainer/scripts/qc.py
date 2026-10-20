"""Pull finished takes from the box and check them: a 7-frame strip of the
upper frame (face, gestures, stray on-screen text) and what Whisper hears.

  python qc.py --project DIR --jobs h3-jobs.json S03 S04     # writes DIR/takes/<id>.mp4 and <id>-sheet.png
  python qc.py --project DIR --jobs master-jobs.json --into presenter S03

`--jobs` maps segment ids to Pepper job ids. The box is reached over SSH and
the API is called inside the container, so the token never leaves it.
"""
import argparse, io, json, os, re, subprocess
from pathlib import Path

import numpy as np
from PIL import Image

CURL = "docker exec pepper-pro sh -c 'curl -s -H \"Authorization: Bearer $PEPPER_API_TOKEN\" localhost:3000/v1/jobs/{}'"

ap = argparse.ArgumentParser()
ap.add_argument('ids', nargs='+')
ap.add_argument('--project', default='.')
ap.add_argument('--jobs', required=True, help='JSON {segment id: job id}')
ap.add_argument('--host', default=os.environ.get('PEPPER_HOME_HOST', 'lijin@lk-gpu-server'))
ap.add_argument('--into', default='takes', help='folder under the project for the files (takes, or presenter for masters)')
ap.add_argument('--no-listen', action='store_true', help='skip the Whisper transcript')
a = ap.parse_args()

root = Path(a.project).resolve()
out_dir = root / a.into
out_dir.mkdir(parents=True, exist_ok=True)
jobs = json.loads((root / a.jobs).read_text() if not Path(a.jobs).is_absolute() else Path(a.jobs).read_text())
ssh = lambda cmd, text=True: subprocess.run(['ssh', a.host, cmd], capture_output=True, text=text, check=True).stdout
model = None
for sid in a.ids:
    raw = ssh(CURL.format(jobs[sid]))
    job = json.loads(raw)
    # The result names the output; a master's params also name its input
    # (from-h3-video-…), so searching the raw JSON can pick the wrong file.
    outputs = [o['name'] for o in (job.get('result') or {}).get('outputs', []) if o.get('name', '').endswith('.mp4')]
    found = re.search(r'(?<!from-)\b[a-z0-9-]+-\d{4}-\d\d-\d\dT[0-9-]+Z-[0-9a-f]+\.mp4', raw)
    name = outputs[0] if outputs else found and found.group(0)
    if job.get('status') != 'completed' or not name:
        print(sid, job.get('status'), (job.get('error') or {}).get('message', ''))
        continue
    path = out_dir / f'{sid}.mp4'
    path.write_bytes(ssh(f'docker exec pepper-pro cat /data/outputs/{name}', text=False))
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,bit_rate:format=duration',
                            '-of', 'json', str(path)], capture_output=True, text=True).stdout
    info = json.loads(probe)
    dur = float(info['format']['duration'])
    st = info['streams'][0]
    frames = []
    for i in range(7):
        t = 0.3 + i * (dur - 0.6) / 6
        png = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', str(path), '-frames:v', '1', '-vf',
                              'crop=iw:ih*0.67:0:0,scale=240:-2', '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True).stdout
        frames.append(Image.open(io.BytesIO(png)))
    sheet = Image.new('RGB', (240 * 7, frames[0].height))
    for i, f in enumerate(frames):
        sheet.paste(f, (i * 240, 0))
    sheet.save(out_dir / f'{sid}-sheet.png')
    heard = ''
    if not a.no_listen:
        if model is None:
            from faster_whisper import WhisperModel
            model = WhisperModel('small.en', device='cpu', compute_type='int8')
        pcm = np.frombuffer(subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'],
                                           capture_output=True).stdout, np.float32)
        segs, _ = model.transcribe(pcm)
        heard = ' '.join(s.text.strip() for s in segs)
    print(sid, name, f"{st['width']}x{st['height']}", f"{int(st.get('bit_rate', 0)) / 1e6:.1f} Mbps", f'{dur:.2f}s', '|', heard)
