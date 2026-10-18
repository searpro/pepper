---
name: presenter-explainer
description: Make a researched explainer video on Pepper Pro with a recurring on-camera presenter — research the facts, write a line-by-line script, give the presenter one consistent cloned voice (Qwen3-TTS), lip-sync every line with MiniMax H3 driven by that audio, master to 4K with RTX Video, and compose the cut on the laptop with real photos of the subject coming and going, word-by-word captions, stat callouts and an ACE-Step music bed. Use when asked for an explainer, a news or product breakdown, a "science behind it" video, or any talking-head piece that has to show real images of a real thing (a car, a launch, a gadget, an event).
---

# Presenter explainer

Built for the Tesla Roadster explainer (2026-10-18, 2:04, 9:16 4K): Maya, a
fictional presenter, explains the car with Tesla's photos and livestream frames
appearing over her. `examples/roadster-script.json` is that video's script and
every cue. The two scripts here do the parts Pepper Pro can't:
`scripts/compose.py` (the cut) and `scripts/qc.py` (checking takes).

## Rules the user set

- **Real images only for the real subject.** Generated or edited pictures of
  the product looked poor ("the edits look poor") and were dropped: show
  photos of the actual thing so the information is legit. Only the presenter
  is generated. Credit every photo on screen ("Image: Tesla", "Tesla
  livestream"), and say before publishing that the photos are third-party.
- **Quality first, on the home box** (`16gb` tier). Ask before anything that
  bills; the home box doesn't.
- **Eye contact.** Every presenter prompt says the eyes stay just past the
  lens and the shoulders stay square to the camera (the drama tests and this
  video both lost eye contact when a direction implied turning).
- **No LTX refine on speaking shots**: it re-renders mouths without the audio.

## 1. Research and script

- Search the event, then fetch the two or three most detailed reports;
  prefer numbers the company published, and note which are only one outlet's.
  Keep a sources list for the reply.
- Write 12–16 lines of 5–12 s each (H3's range is 1–15 s; ~2.6 words/s):
  a cold open, an intro naming the presenter, one section per idea (call
  them "Trick 1/2/3" or similar for the chips), a balanced "the catch", a
  one-line close. Check the arithmetic you narrate (0.81 s to 60 mph ≈ 3.4 g).
- Collect photos into the project folder before rendering anything: the
  maker's page (tesla.com's images came full size by asking the CDN for
  `f_jpg,q_90` without a width), livestream frames from news coverage (read
  the `<img>` tags with the browser pane; download the original, not the
  resized srcset), and whatever the user attaches. Look at a contact sheet.

## 2. The presenter

- **From the library first.** `get_project` with no id lists the shared
  library. Maya is there (`ast_70ea1af4d2eb`: her still, a voice clip, its
  transcript in `meta.voice_text`). Name a library character in a plan to use
  it; `library: true` on a plan asset saves a new one for every project.
- **New presenter:** `krea2-image`, 9:16, `count: 4`, a stated age, clothing,
  "eyes fixed just past the camera lens, focused, with bright catchlights", a
  plain dark studio. Pick one; it is every segment's first frame. H3 renders
  at 768×1344 whatever the still's size, so a bigger still only matters for
  the library.

## 3. One voice for every line

1. `generate_audio` with `model: qwen3-tts`, `quality: design`, `count: 3`,
   a voice description and the intro line. Send the three to the user (they
   may pick); check each with Whisper for pace and accuracy.
2. For **every** line: `quality: final` (clone), `voice_reference` = the
   chosen clip, `params.voice_text` = what that clip says. Design mode per
   line would give a different voice each time. 14 lines took ~2 min.
3. Pull the files from the box into `voice/<id>.wav`
   (`ssh … docker exec pepper-pro cat /data/outputs/<name>`), then
   `compose.py align` and read what Whisper heard against the script.

## 4. Lip-synced presenter takes

`generate_video`, `model: h3-video`, `quality: draft`, `aspect_ratio: 9:16`,
`image` = the still, `audio` = the line's TTS output, `duration` = the
line + 0.35 s. Write the prompt in H3's base format yourself:

```
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Photoreal vertical medium shot, cinematic studio lighting, shallow depth of field, clean frame with no on-screen text, numbers, captions or graphics. The scene begins exactly as shown in <Picture 1>, preserving its subjects, appearance, clothing and setting. <Name>: <the library description>. The camera is static at chest height. Her shoulders stay square to the camera; she does not turn her body or head away, and her eyes stay fixed just past the camera lens, focused. <One acting direction for this line, gestures at chest height>. <Name> with <voice description> (S1) says: <d>[English] <the line, exactly></d>

overall_soundscape: Quiet studio room tone under her voice; no other sounds.

non_diegetic_music: N/A
```

- ~14 min per 10 s on the 5060 Ti (draft); `final` is twice that. The
  speech lands within 0.02 s of the TTS line, so the cut uses the TTS audio.
- Skip lines a full-screen photo covers end to end (use a still loop).
- **Failure modes seen:** "counts on her fingers" with spoken numbers drew
  digits on screen; "a little shrug / skeptical" turned her sideways and off
  camera; one take grimaced on a line. The "clean frame" and "shoulders
  square" sentences above came from those.
- **QC every take as it lands**: `scripts/qc.py --project DIR --jobs
  h3-jobs.json S03` saves the take, a 7-frame strip of the upper frame and the
  transcript. Look at the strip; retake (new seed, adjusted direction) or
  plan a photo over the bad stretch. A monitor that polls the job ids and
  prints each completion saves polling by hand.

**Detail** (measured on one 5 s take, 2026-10-18). The recipes save takes
at CRF 12 and masters at CRF 14 (before, `auto` gave 1.2 Mbps takes and soft
skin); that alone brought the texture back. Two optional steps add more:
`quality: final` at the draft's seed is a little more natural (11 min per
5 s, twice the draft), and **SeedVR2 ×2 on the take, then `rtx-master` at
`scale: 1.4271`** gives the most real skin, pores and lashes (+18 min per
5 s, lip sync kept). Offer SeedVR2 for close shots or a hero cut; at ~36 min
per 10 s line it adds about 7 h to a 12-line video.

## 5. Master, music

- `rtx-master`, `quality: upscale`, `params: {scale: 2.857, quality: ULTRA}`:
  768×1344 → 2192×3840 in ~40 s a take; frame-by-frame, so lip sync holds.
  Pull the masters into `presenter/<id>.mp4` (`qc.py --into presenter`).
- `generate_audio`, `model: ace-step-music`, `audio_type: music`,
  `lyrics: "[Instrumental]"`, `duration` = the cut + 5 s, `count: 2`, a style
  without vocals. ~15 s each. Prefer the one where Whisper hears nothing.
  Save as `music/bed.wav`.

## 6. Compose

`scripts/compose.py` (venv with numpy, pillow, faster-whisper) builds every
frame at 2160×3840 in PIL and encodes with x264 CRF 16; ~9 min for 2 min of
4K on an M-series Mac, ~1.5 min at `--scale 0.5`.

- The project's `script.json`: `photo_dirs`, `credits` (per photo, else
  `default_credit`), an optional `hook` (a title over the first seconds), and
  per segment its `text`, `chip` (section label), `stats` (`[word, label]`
  pills) and `cues` (photos: `at`/`until` words, `style` card | fit | pan,
  pan's `x0 x1 y0 y1 zoom`). See `examples/roadster-script.json`.
- Card: the lower part of the frame, so the face stays visible; use a
  full-screen style when the presenter's take cuts to a close-up (H3 does
  that on its own sometimes) or to hide a bad stretch.
- `fit` keeps on-screen telemetry readable; `pan` is for drama.
- Voice lines sit at their slots, the bed at 0.32 ducked by a sidechain
  compressor, loudnorm to −14 LUFS.
- Render a half-size preview, make a contact sheet of ~30 frames, fix, then
  render 4K. Deliver the 4K file and a 1080p copy under 30 MB for the phone
  (`-b:v 1650k` for 2 min).

## Gotchas

- Downloads to the box run ~11 MB/s: Qwen3-TTS is 13.6 GB (all three
  checkpoints), ACE-Step 10 GB.
- Auto mode blocks `scp`/`docker cp` to the box; the user runs those.
- Qwen-Image edits take ~10 min each on `16gb` (24 GB files): too slow to
  use per shot.
- Projects: these generations are loose jobs, not a Pepper project, because
  Pepper Pro's cut can't overlay photos or captions and has no route to import
  a finished file as a take. A project plan helps when the cut can stay in
  Pepper.
- The local ffmpeg has no `drawtext`; all text is drawn in PIL.
