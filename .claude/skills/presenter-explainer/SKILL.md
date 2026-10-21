---
name: presenter-explainer
description: Make a researched explainer video on Pepper Pro with a recurring on-camera presenter — research the facts, write a line-by-line script, give the presenter one consistent cloned voice (Qwen3-TTS), lip-sync every line with MiniMax H3 driven by that audio, master to 4K with RTX Video, and compose the cut on the laptop with real photos of the subject coming and going, word-by-word captions, stat callouts and an ACE-Step music bed, then write its publishing kit (titles, descriptions, tags, covers per platform) to the Video Publishing workspace in Notion and log its performance there. Use when asked for an explainer, a news or product breakdown, a "science behind it" video, or any talking-head piece that has to show real images of a real thing (a car, a launch, a gadget, an event).
---

# Presenter explainer

Built for the Tesla Roadster explainer (2026-10-18, 2:04, 9:16 4K): Maya, a
fictional presenter, explains the car with Tesla's photos and livestream frames
appearing over her. `examples/roadster-script.json` is that video's script and
every cue. The scripts here do the parts Pepper Pro can't:
`scripts/compose.py` (the cut), `scripts/qc.py` (checking takes) and
`scripts/covers.py` (thumbnails). Step 7 hands the finished video to the
user's manual posting through Notion.

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

- The channel's audience is global: pick topics and examples that matter
  worldwide, never a country-specific angle (the user is in India; the
  viewers are not).
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
- **A science topic has no maker's photos: use the agencies'.** NOAA, NASA
  and NOAA Climate.gov images are public domain; Copernicus Sentinel-2 and
  Wikimedia Commons files carry their licence in the Commons API's
  `extmetadata` (credit CC BY ones by name). Prefer true-colour satellite
  pairs (before/after) to false-colour ones viewers can't read. A map that
  will fill the screen needs more pixels than an agency's PNG has: render it
  from the agency's own data instead (El Niño: NOAA Coral Reef Watch's 5 km
  SST anomaly NetCDF, `~/projects/el-nino-explainer/make_map.py`, with
  netCDF4 in the venv). Charts with small print are unreadable on a phone;
  say the number with a stat pill instead.

## 2. The presenter

- **From the library first.** `get_project` with no id lists the shared
  library. Maya is there (`ast_70ea1af4d2eb`: her still, a voice clip, its
  transcript in `meta.voice_text`). Name a library character in a plan to use
  it; `library: true` on a plan asset saves a new one for every project.
- **New look per video, settings that act out the story.** The user wants
  an outfit Maya hasn't worn before in every video (the list of used ones
  is in Claude's memory, `feedback-presenter-wardrobe`), and liked settings
  that show the topic (El Niño: storm beach, tropical heat, a downpour with a
  clear umbrella, a cracked lakebed). `qwen-image-turbo-edit` on her library
  still (7–15 s each, `count: 2`, no `aspect_ratio`: it keeps the input's;
  `qwen-image-edit` gave the same look in 17–27 s in an A/B on 2026-10-21)
  with "change her clothes completely: she now wears …; no white t-shirt, no
  bomber jacket", the weather, and "a calm, neutral, attentive expression
  with her lips gently closed, not smiling, no teeth showing. Her arms rest
  at her sides, hands out of frame. Shoulders square to the camera, eyes
  just past the lens". Plain "mouth closed" gave an open-mouthed smile and a
  raised hand on both editors, which is the frame H3 freezes into a grin.
  Rain, wind, surf, heat haze and drifting dust all played in H3 with lip
  sync intact.
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
- **Facial Realism LoRA:** `loras: ["minimax-h3-facial-realism-closeup"]`
  and `Facial Realism. ` at the start of the `[Shot 1]` description. In an
  A/B at the same seed (2026-10-21, two lines) the performance, lip sync and
  eye contact were identical and so was the render time; cropped 2× the face
  had more defined lashes, brows and skin texture and less of a plastic
  sheen, and the background stayed closer to the still. Use it on presenter
  takes. `list_models` shows the H3 LoRAs in the library and their notes.
- Skip lines a full-screen photo covers end to end (use a still loop).
- **Failure modes seen:** "counts on her fingers" with spoken numbers drew
  digits on screen; "a little shrug / skeptical" turned her sideways and off
  camera; one take grimaced on a line. The "clean frame" and "shoulders
  square" sentences above came from those.
- **Never ask for a smile through a line.** "A warm, friendly smile" or
  "sincere, warm expression" froze the mouth in a grin for the whole take, with
  no lip sync (2 of 8 takes on the channel intro). Say instead: "She speaks
  every word clearly, her lips, jaw and mouth forming each syllable in sync
  with her voice", and put any smile "only after the last word". Whisper
  can't catch this (it hears the input audio); look at the mouth.
  Even "a brief smile only after the last word" leaked onto a short, bright
  closing phrase ("I'm Maya. Let's make it click."; "Follow for the next
  one."), and a retake with no smile in the prompt grinned again there: H3
  reads the smile off the delivery. For those lines write no smile at all
  ("a single small nod after the last word"), and if it still grins, cut
  away to a full-screen image for the last phrase. Check the final 2 s at
  8–12 fps on every take; a 7-frame strip misses it.
- **Camera moves work** (channel intro, 2026-10-19), all with eye contact
  kept: a push-in to a close-up, a ~20° arc ("she turns her head with it so
  her eyes stay fixed just past the lens"), a sideways truck, a walk toward a
  steadicam tracking backward, a pull-back that ends on a wave. Arcs and
  trucks travel further than "small amplitude" and can drift the light to
  afternoon; "the warm golden-hour backlight … stays the same throughout the
  shot" held it.
- **QC every take as it lands**: `scripts/qc.py --project DIR --jobs
  h3-jobs.json S03` saves the take, a 7-frame strip of the upper frame and the
  transcript. Look at the strip, and at a dense run of mouth frames when the
  expression barely changes across it; retake (new seed, adjusted direction)
  or plan a photo over the bad stretch. A monitor that polls the job ids and
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
  **A take over ~10.5 s runs the box out of RAM**: a 12.25 s take got
  ComfyUI SIGKILLed, and every master queued behind it failed at once
  ("Cannot connect to ComfyUI"). Split long takes at a frame boundary
  (`ffmpeg -t 6.125 … -crf 8` and `-ss 6.125`), copy the halves into the
  box's uploads (`ssh … docker exec -i pepper-pro sh -c 'cat >
  /data/uploads/NAME.mp4' < file`), master each, and join them with ffmpeg's
  concat demuxer (`-c copy`); the seam doesn't show. Remove any preview
  symlinks in `presenter/` before `qc.py --into presenter`, or it writes
  through them into `takes/`.
- `generate_audio`, `model: ace-step-music`, `audio_type: music`,
  `lyrics: "[Instrumental]"`, `duration` = the cut + 5 s, `count: 2`, a style
  without vocals. ~15 s each. Prefer the one where Whisper hears nothing.
  Save as `music/bed.wav`.

## 6. Compose

`scripts/compose.py` (venv with numpy, pillow, faster-whisper) builds every
frame at 2160×3840 in PIL and encodes with x264 CRF 16; ~9 min for 2 min of
4K on an M-series Mac, ~1.5 min at `--scale 0.5`.

- The project's `script.json`: `photo_dirs`, `credits` (per photo, else
  `default_credit`), an optional `hook` (a title over the first seconds; give
  it `fill: [0,0,0,150]` over a bright opening and `y` to clear the head), and
  per segment its `text`, `chip` (section label), `stats` (`[word, label]`
  pills, which stay up to the next pill or the end of the line; a pill that
  labels a full-screen image takes a third item, `[word, label, until]`, so
  it leaves with the image instead of landing on her face; `stats_y` moves
  them, say to 0.70, on a line whose take pushes in
  to a close-up, where the default 0.452 sits on her mouth) and `cues`
  (photos: `at`/`until` words, `style` card | fit | pan, pan's
  `x0 x1 y0 y1 zoom`). See `examples/roadster-script.json`. Full-screen
  cues get their credit drawn bottom right too. Photos must be .png or .jpg
  (convert a .gif). The venv lives at `~/projects/.explainer-venv`.
- Card: the lower part of the frame, so the face stays visible; use a
  full-screen style when the presenter's take cuts to a close-up (H3 does
  that on its own sometimes) or to hide a bad stretch.
- `fit` keeps on-screen telemetry readable; `pan` is for drama.
- Voice lines sit at their slots, the bed at 0.32 ducked by a sidechain
  compressor, loudnorm to −14 LUFS.
- Render a half-size preview, make a contact sheet of ~30 frames, fix, then
  render 4K. Deliver the 4K file and a 1080p copy under 30 MB for the phone
  (`-b:v 1650k` for 2 min).

## 7. Publishing kit (Notion)

The user posts by hand: no upload automation, no platform API reviews. This
step gives them everything to copy for each platform, in Notion and in the
project folder. `references/notion.md` has the workspace's IDs.

1. **Read the channel's row** in Notion's Channels database: its active
   `Platforms` (only those get a section; TikTok is inactive because it is
   blocked in India) and the style guide in its page body. The style guide
   wins over anything here.
2. **Covers: let the model design the whole thumbnail.** The user rejected
   covers made of a frame plus text drawn in PIL. `qwen-image-edit` (~25 s
   each, `count: 2`) draws the full thumbnail, headline included: `image` is
   the presenter still (or a pose edited from it), the prompt asks for a
   bold YouTube-thumbnail design, the exact headline lines and colours
   ("in a heavy, rounded sans-serif with a thick black outline… 'ORANGE?' in
   bright yellow… spelled exactly"), and *"leave the top eighth of the
   picture as plain sky/studio with nothing on it"*, which keeps the
   headline and face inside Instagram's 3:4 grid crop. For a real subject,
   pass its photo as a `reference_images` entry (copy it into the box's
   uploads with `ssh … docker exec -i pepper-pro sh -c 'cat >
   /data/uploads/NAME.jpg' < file`) and ask for it "as a large straight
   rectangular photo panel… not tilted". The model redraws that photo, so
   lay the real one over it: measure the panel's inner edges and give
   `covers.json` an entry with `"photo"`, `"credit"` and
   `"photo_box"` (fractions of the final 1080×1920; the source is scaled by
   1080/768, then 7 px come off the top). Then run `scripts/covers.py
   --project DIR` and look at `covers/sheet.jpg` (the green box is the 3:4
   grid crop). Read every headline letter by letter: `flux2-klein-edit`
   misspelled 2 of 4 ("ORAIGE", "DOVIN"); Qwen spelled all 8 right.
   **Licence:** `qwen-image-edit` here is Qwen-Image 2.1 under a
   non-commercial research licence; `flux2-klein-edit` (Apache 2.0) is the
   commercial-safe fallback. Say which one made the covers.
3. **Text**, per the style guide: three YouTube titles (the first
   recommended), a description with sources, image credits and the
   disclosure line, tags, an Instagram caption, a Facebook caption, a pinned
   comment. Every number in the copy must be one the video says.
4. **`publish-kit.md`** in the project folder
   (`~/projects/maya-intro/publish-kit.md` is the model): files (the 4K
   master for YouTube, the 1080p copy for Instagram and Facebook), covers,
   then one section per platform with settings (the AI label on every one).
5. **The Videos page**, status `Ready to post`, related to the channel:
   upload each cover with `notion-create-file-upload` and a `curl -F
   file=@…` POST to the returned URL, then place them in the body (an upload
   can be placed once, so upload the recommended cover a second time for the
   `Cover` property, set with `notion-update-page` as
   `[{"type":"file_upload","file_upload":{"id":…}}]`). The body has a
   callout (order and timing), a Covers row, a `<tabs>` block with one tab per
   platform whose copy sits in `plain text` code blocks (Notion gives those a
   copy button), the pinned comment and the posting checklist. Put file
   paths in backticks: Notion turns `.mp4` names into links otherwise.

**Tracking.** After posting, the user pastes the links into the page and sets
`Posted on` and `Next check`. At 24 h, 7 d and 30 d they send screenshots of
each platform's analytics; add one Performance row per platform and
checkpoint, named `<video> · <platform> · <checkpoint>`, related to the video,
with whatever the screenshot shows (leave a metric empty rather than
guessing), attach the screenshot, and move `Next check` to the next
checkpoint (clear it after 30 d). When asked how videos are doing, query
Performance at one checkpoint across videos and say which topics, titles and
covers are winning.

## Gotchas

- Downloads to the box run ~11 MB/s: Qwen3-TTS is 13.6 GB (all three
  checkpoints), ACE-Step 10 GB.
- Auto mode blocks `scp`/`docker cp` to the box; the user runs those.
- Qwen-Image edits take 7–27 s each on `16gb` once loaded (Turbo is the
  faster); the first after another model loads its files first.
- Projects: these generations are loose jobs, not a Pepper project, because
  Pepper Pro's cut can't overlay photos or captions and has no route to import
  a finished file as a take. A project plan helps when the cut can stay in
  Pepper.
- The local ffmpeg has no `drawtext`; all text is drawn in PIL.
