"""Audio analysis for Pepper Pro's `analyze` jobs, run with ComfyUI's Python.

    python analyze.py beats <audio>                -> {"bpm", "beats", "downbeats", "duration"}
    python analyze.py stems <audio> <out_dir> [--device cpu|cuda]
                                                   -> {"vocals": path, "accompaniment": path}
    python analyze.py transcribe <audio> [--expected TEXT] [--model base]
                                                   -> {"text", "language", "segments", "match"?}

The one JSON result goes to stdout; progress goes to stderr, one line at a
time, which the server forwards to the job's log. Both tasks run on the CPU
by default so they never compete with ComfyUI for VRAM: a three-minute song
takes seconds to beat-track and a minute or two to separate.
"""

import argparse
import json
import sys
from pathlib import Path


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def beats(path: str) -> dict:
    import librosa
    import numpy as np

    log("loading audio")
    y, sr = librosa.load(path, sr=22050, mono=True)
    log("tracking beats")
    onset = librosa.onset.onset_strength(y=y, sr=sr)
    tempo, frames = librosa.beat.beat_track(onset_envelope=onset, sr=sr, units="frames")
    times = librosa.frames_to_time(frames, sr=sr)
    # Downbeats as the phase of every fourth beat that lands on the strongest
    # onsets: right for most 4/4 pop and dance music, which is what cuts are
    # timed to; a bar-aware model would be the upgrade.
    strength = onset[np.clip(frames, 0, len(onset) - 1)] if len(frames) else np.array([])
    phase = max(range(4), key=lambda p: float(strength[p::4].mean()) if len(strength[p::4]) else 0.0) if len(frames) >= 4 else 0
    bpm = float(np.atleast_1d(tempo)[0])
    return {
        "bpm": round(bpm, 2),
        "beats": [round(float(t), 3) for t in times],
        "downbeats": [round(float(t), 3) for t in times[phase::4]],
        "duration": round(float(len(y) / sr), 3),
    }


def stems(path: str, out_dir: str, device: str) -> dict:
    from demucs.separate import main as separate

    log(f"separating vocals on {device}")
    separate(["--two-stems", "vocals", "-n", "htdemucs", "-d", device, "-o", out_dir, "--filename", "{stem}.{ext}", path])
    base = Path(out_dir) / "htdemucs"
    vocals, rest = base / "vocals.wav", base / "no_vocals.wav"
    if not vocals.exists() or not rest.exists():
        raise SystemExit(f"demucs wrote no stems under {base}")
    return {"vocals": str(vocals), "accompaniment": str(rest)}


def word_error_rate(expected: str, heard: str) -> float:
    """Levenshtein distance over words, normalised by the expected length."""
    import re

    def words(text: str) -> list[str]:
        return re.findall(r"[\w']+", text.lower())

    a, b = words(expected), words(heard)
    if not a:
        return 0.0 if not b else 1.0
    row = list(range(len(b) + 1))
    for i, wa in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, wb in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (wa != wb))
    return row[len(b)] / len(a)


def transcribe(path: str, expected: str | None, model_name: str, cache: str | None) -> dict:
    import whisper

    log(f"transcribing with whisper {model_name}")
    model = whisper.load_model(model_name, download_root=cache)
    result = model.transcribe(path, fp16=False)
    out = {
        "text": result["text"].strip(),
        "language": result.get("language"),
        "segments": [
            {"start": round(s["start"], 2), "end": round(s["end"], 2), "text": s["text"].strip(), "no_speech": round(s["no_speech_prob"], 3)}
            for s in result["segments"]
        ],
    }
    if expected is not None:
        wer = word_error_rate(expected, out["text"])
        # A take that says the line with a word or two misheard passes; one
        # that says something else, or nothing, does not.
        out["match"] = {"wer": round(wer, 3), "ok": wer <= 0.25}
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="task", required=True)
    b = sub.add_parser("beats")
    b.add_argument("audio")
    s = sub.add_parser("stems")
    s.add_argument("audio")
    s.add_argument("out_dir")
    s.add_argument("--device", default="cpu")
    t = sub.add_parser("transcribe")
    t.add_argument("audio")
    t.add_argument("--expected")
    t.add_argument("--model", default="base")
    t.add_argument("--cache")
    args = parser.parse_args()
    if args.task == "beats":
        result = beats(args.audio)
    elif args.task == "stems":
        result = stems(args.audio, args.out_dir, args.device)
    else:
        result = transcribe(args.audio, args.expected, args.model, args.cache)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
