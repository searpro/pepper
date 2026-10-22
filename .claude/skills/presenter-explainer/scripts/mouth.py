"""How much the mouth moves in a take: the mean (and 90th percentile) absolute
difference of a 64x48 mouth crop between consecutive frames, the crop placed
from YuNet's mouth-corner landmarks. Whisper can't tell a frozen mouth (it hears
the input audio); this can.

  python3 mouth.py takes/S01.mp4 takes/S02.mp4

Measured 2026-10-22: speaking takes 10-14 (a published microplastics take 13.7);
a take whose prompt asked for "an even, gentle delivery" 4.8, which the user saw
as "not talking". Below ~10 on a speaking line, look at the mouth and retake.
Needs opencv-python and ~/projects/.face-models/yunet.onnx (see identity.py).
"""
import sys
from pathlib import Path

import cv2
import numpy as np

det = cv2.FaceDetectorYN.create(str(Path.home() / 'projects/.face-models/yunet.onnx'), '', (320, 320), 0.6)

for path in sys.argv[1:]:
    cap = cv2.VideoCapture(path)
    prev, diffs = None, []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        det.setInputSize((frame.shape[1], frame.shape[0]))
        _, faces = det.detect(frame)
        if faces is None:
            prev = None
            continue
        f = max(faces, key=lambda r: r[2] * r[3])
        w = f[2]
        # YuNet's landmarks 3 and 4 are the mouth corners.
        mx, my = (f[10] + f[12]) / 2, (f[11] + f[13]) / 2
        crop = frame[max(0, int(my - .18 * w)):int(my + .22 * w), max(0, int(mx - .3 * w)):int(mx + .3 * w)]
        if crop.size == 0:
            prev = None
            continue
        crop = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), (64, 48)).astype(float)
        if prev is not None:
            diffs.append(np.abs(crop - prev).mean())
        prev = crop
    if diffs:
        print(f'{Path(path).stem:12s} mouth motion mean {np.mean(diffs):5.1f}  p90 {np.percentile(diffs, 90):5.1f}')
    else:
        print(f'{path}: no face found')
