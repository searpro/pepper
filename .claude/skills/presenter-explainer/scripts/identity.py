"""Score how much a face looks like the presenter: OpenCV YuNet finds the largest face,
SFace embeds it, and the cosine similarity to the reference face is the score (1.0 is the
reference itself; OpenCV calls >= 0.363 the same person, but for a recurring presenter
the bar is much higher: see the skill's step 2).

  python3 identity.py REF.png label=pic.png label=take.mp4 label=take.mp4@3.2
  python3 identity.py REF.png --min 0.85 starts/*.png        # pass/fail per picture

A video is sampled at 8 frames and reports mean and min. Needs opencv-python (system
python3 has it) and the two ONNX models in ~/projects/.face-models (from opencv_zoo:
face_detection_yunet_2023mar.onnx as yunet.onnx, face_recognition_sface_2021dec.onnx as
sface.onnx). SFace is a frontal model: a three-quarter view of the same person scores
lower, and past about 60 degrees the score means little.
"""
import argparse, subprocess
from pathlib import Path

import cv2
import numpy as np

MODELS = Path.home() / 'projects/.face-models'
det = cv2.FaceDetectorYN.create(str(MODELS / 'yunet.onnx'), '', (320, 320), 0.6)
rec = cv2.FaceRecognizerSF.create(str(MODELS / 'sface.onnx'), '')


def feature(img):
    # YuNet misses or mislocates faces in 4K frames; the masters are scored at 768 wide.
    if img.shape[1] > 1000:
        img = cv2.resize(img, (768, int(img.shape[0] * 768 / img.shape[1])))
    det.setInputSize((img.shape[1], img.shape[0]))
    _, faces = det.detect(img)
    if faces is None:
        return None
    face = max(faces, key=lambda f: f[2] * f[3])
    return rec.feature(rec.alignCrop(img, face))


def frame(path, t):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', str(path), '-frames:v', '1',
                          '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True).stdout
    return cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)


def images(spec):
    path, _, at = spec.partition('@')
    path = str(Path(path).expanduser())
    if not path.endswith('.mp4'):
        return [cv2.imread(path)]
    if at:
        return [frame(path, float(at))]
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                               capture_output=True, text=True).stdout)
    return [frame(path, 0.2 + i * (dur - 0.4) / 7) for i in range(8)]


ap = argparse.ArgumentParser()
ap.add_argument('ref')
ap.add_argument('items', nargs='+', help='label=path, or a bare path')
ap.add_argument('--min', type=float, help='print PASS/FAIL against this mean')
a = ap.parse_args()
ref = feature(cv2.imread(a.ref))
for item in a.items:
    label, _, spec = item.rpartition('=') if '=' in item else (Path(item).stem, '', item)
    scores = [None if (f := feature(im)) is None else float(rec.match(ref, f, cv2.FaceRecognizerSF_FR_COSINE))
              for im in images(spec)]
    found = [s for s in scores if s is not None]
    if not found:
        print(f'{label:14s} no face')
        continue
    line = f'{label:14s} mean {np.mean(found):.3f}'
    if len(scores) > 1:
        line += f'  min {min(found):.3f}  ' + ' '.join('-' if s is None else f'{s:.2f}' for s in scores)
    if a.min is not None:
        line += '  ' + ('PASS' if np.mean(found) >= a.min else 'FAIL')
    print(line)
