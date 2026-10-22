---
name: presenter-explainer
description: Make a researched short explainer video (50–65 s) on Pepper Pro with a recurring on-camera presenter who walks and works in the set while the camera moves — research the facts, write a line-by-line script, storyboard a start frame per line for the user to approve, give the presenter one consistent cloned voice (Qwen3-TTS), lip-sync every line with MiniMax H3 driven by that audio, master to 4K with RTX Video, and compose the cut on the laptop with real photos of the subject coming and going, word-by-word captions, stat callouts and an ACE-Step music bed, then write its publishing kit (titles, descriptions, tags, covers per platform) to the Video Publishing workspace in Notion and log its performance there. Use when asked for an explainer, a news or product breakdown, a "science behind it" video, or any talking-head piece that has to show real images of a real thing (a car, a launch, a gadget, an event).
---

# Presenter explainer

Built for the Tesla Roadster explainer (2026-10-18, 2:04, 9:16 4K): Maya, a
fictional presenter, explains the car with Tesla's photos and livestream frames
appearing over her. `examples/roadster-script.json` is that video's script and
every cue. The scripts here do the parts Pepper Pro can't:
`scripts/compose.py` (the cut; `scripts/hdr.py` its HDR cuts), `scripts/qc.py`
(checking takes) and `scripts/covers.py` (thumbnails); the finishing look is
Pepper Pro's `film-finish` recipe (step 6b). Step 7 hands the finished video to the
user's manual posting through Notion.

## Rules the user set

- **Real images only for the real subject.** Generated or edited pictures of
  the product looked poor ("the edits look poor") and were dropped: show
  photos of the actual thing so the information is legit. Only the presenter
  is generated. Credit every photo on screen ("Image: Tesla", "Tesla
  livestream"), and say before publishing that the photos are third-party.
- **Quality first, on the home box** (`16gb` tier). Ask before anything that
  bills; the home box doesn't.
- **The camera always moves, and Maya is never just a talking head**
  (mandatory, 2026-10-21). Every line is a shot with a camera move and
  something she does in the setting: walking, pouring, cooking, picking
  something up, sitting down. She looks into the lens at the moments that
  matter, not on every line. Her face stays visible and turned toward the
  camera enough for the lip sync to read. Plan this as a storyboard (step 2)
  and let the user approve it before anything renders.
- **No LTX refine on speaking shots**: it re-renders mouths without the audio.

## Checkpoints: what the user sees and approves, in order

Nothing renders on the GPU past a checkpoint the user hasn't passed. Stills
are cheap (7–13 s each), so show pictures rather than describe them.

1. **Topic.** Pitch 5–7 topics that fit step 0 (each with its hook and where
   its real photos would come from), recommend one or two, let the user
   pick. Check the current news first; say why a topic is timely if it is.
2. **Plan and draft script.** One message: what the last videos' numbers
   suggest (step 0), the angle, the length, how the hook plays in the first
   2 s, the draft script as a table (line · set · action · camera · what is
   on screen), title options, and the sources with each number checked. Ask
   which lines to change before any voice is recorded.
3. **Look.** A labelled contact sheet of 3–4 outfits in the main set, plus
   the second set; then the chosen outfit's final stills with your picks
   marked (step 2).
4. **Storyboard.** One start frame per line showing the action, with the
   action and camera move under each (`storyboard.jpg`, step 2). Say which
   actions are untested in H3.
5. **Test takes.** Voice every line, then render the one or two riskiest
   shots (hands and props, a new kind of move) and show them before the rest.
6. **Preview cut.** The half-size render and its contact sheet (step 6),
   before the 4K render.
7. **Publishing kit** in Notion (step 7).

Keep the project's `PLAN.md` current through these (script, picks, sources,
what is decided), so another session can pick it up.

## Who does what, on which model

A whole video in one session ran to 500–700k tokens of context, all on
Opus at high effort. Only the creative calls need that, so split the work:

| Work | Where | Model, effort |
| --- | --- | --- |
| Topics, facts, sources, real photos (0–1) | `explainer-researcher` agent | Sonnet, medium |
| Script, looks, storyboard, H3 directions (1–2) | this session | as the user chose (Opus, high) |
| Voice, takes, retakes, masters (3–5) | this session, or a new one from `PLAN.md` | medium effort |
| QC of every batch of stills and takes | `take-reviewer` agent | Sonnet, medium |
| Finish, compose, deliveries (6–6c) | a new session from `PLAN.md` | Sonnet, medium |
| Publishing kit (7) | `publishing-kit-writer` agent | Sonnet, medium |

**Using the agents is the user's standing direction**: spawn them for
these steps without asking. Do not run web searches, look at frames, or
write the Notion kit in this session. Every batch of stills or takes goes
to `take-reviewer` as it lands (several batches can run in parallel). Act
on its table, and open a frame yourself only where it flags something you
need to judge. An agent starts cold, so its brief carries the project
folder, the ids, and what to check or write. It returns a short table. Show the user the
pictures they approve yourself (`SendUserFile`); you do not need to open
them all first.

After checkpoint 4 (the storyboard approved) and after the last take
passes QC, bring `PLAN.md` up to date and offer the next phase as a new
session: `start_session` with `initiation: "own_initiative"`, `context:
"fresh"`, the `effort` or `model` from the table, and a brief that points
at `PLAN.md`. The user starts it with a click. A session cannot change its
own model or effort; failing that, suggest `/compact`.

Through the steps:

- Call `list_models` once per kind.
- Follow renders with a background monitor, or `get_job` on the ids still
  running at 50 s, with `preview: "none"` when a sheet will show them.
- Open single frames only where the reviewer's numbers flag something.

## 0. What makes a video work (the channel's numbers so far)

At ~1 day after posting all three at once (2026-10-20, YouTube): the 58 s
sunset question had 304 views, the 2:04 Roadster 138, the 2:05 El Niño 60.
Short won by far. So:

- **50–65 s, 8 lines, one idea.** About 3.1 words/s in Maya's cloned voice
  (182 words ran 57.8 s), so ~170 words at most. No "Trick 1/2/3" sections.
- **Topics people hear about every day and that touch their own body,
  money, mind or daily life** (microplastics, the feed algorithm,
  inflation), not advanced science news or gadget trivia; the user turned
  both down. Familiar is not enough: the viewer has to have a stake.
- **A hook in the first 2 s** that is a picture plus a claim the viewer has
  heard, and then a turn ("The real number is far smaller. But it's not
  zero."). Myth-then-truth suits the channel's real-sources promise.
- Ask the user for each platform's retention (average view duration, %
  viewed, viewed vs swiped away) at 24 h; views alone can't say where people
  leave.

## 1. Research and script

- The channel's audience is global: pick topics and examples that matter
  worldwide, never a country-specific angle (the user is in India; the
  viewers are not).
- Search the event, then fetch the two or three most detailed reports;
  prefer numbers the company published, and note which are only one outlet's.
  Keep a sources list for the reply.
- Write 8 lines of 6–10 s each (a master over ~10.5 s runs the box out of
  RAM, step 5): the hook, what the thing is, where it comes from, the
  number, the twist, the honest catch, a close with "Follow for the next
  one." Name each line's set and action as you write it (step 2). Check the
  arithmetic you narrate (0.81 s to 60 mph ≈ 3.4 g), and write years out
  ("twenty twenty-five") so the voice reads them right.
- The channel's style guide (Notion) forbids health, money and legal
  advice: explain what the research found, never tell people what to do.
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
- **Show the user the looks before choosing.** Edit 3–4 outfits into one
  setting (`count: 2` each) and send a labelled contact sheet; the user picks.
  What they asked for (2026-10-21): clothing like the sunset intro's (warm
  rust and cream, natural fabrics) that is fitted and shows Maya's figure,
  never vulgar: a fitted ribbed knit with a modest square or crew neckline,
  a wrap top tied at the waist, a tucked tailored shirt with a belt. Say
  "keep her age (early thirties) and her warm dark-brown hair": the edits
  drifted older and nearly black-haired without it. Use one outfit across
  every set in a short video. Drop any still with teeth showing (H3 freezes
  it into a grin).
- **Identity: score every picture of her, and every take.** Maya's reference
  pack is `~/projects/maya-reference` (`MAYA.md`, `maya-sheet.jpg`, `refs/`):
  the library still is the canonical face, with the best frames of the
  published videos and generated angles. `scripts/identity.py REF items…`
  gives the SFace cosine similarity to `refs/01-library.png` (images, or 8
  frames of a take with mean and min). Edits slim and age her and blacken her
  hair, and an edit of an edit drifts further: on 2026-10-21 the chain library
  1.00 → set still 0.91 → action still (turbo editor, head turned down) 0.71 →
  H3 take 0.63 looked like someone else to the user. The published videos'
  takes average 0.73–0.78. So: **a start frame needs ≥ 0.85, a take a mean ≥
  0.75 and no frame under 0.65**; generate `count: 3` and keep the best, retake
  below the bar. What held identity: one edit from the set still (which itself
  scored ≥ 0.87), the prompt's "her face completely unchanged (face shape,
  cheeks, jaw, …)", her face toward the camera and large in frame, the action
  in her hands and body: 0.85–0.89 with either `qwen-image-edit` or the turbo
  editor, against 0.71 for the same action with her head turned down. Avoid: replacing a drifted face by passing the
  library still as a second image (0.64–0.68, worse), and three-quarter or
  downward heads in start frames. `MiniMax H3 reference mode` (`h3-reference`)
  can bind several pictures to one subject, which may hold her better, but it
  is untested in Pepper and its 16 GB build is the NVFP4 file.
- **Then the storyboard: one start frame per line, showing her mid-action.**
  Edit the chosen set still once (not the library one, so outfit and light
  stay; never an edit of an edit), `count: 3`: "keep
  this exact woman, her face completely unchanged (face shape, cheeks, jaw,
  eyes, brows, nose, lips, skin tone, age, hair and earrings), <outfit>, and
  the same <set and light>. She … , her face toward the camera and clearly
  visible, looking just past the lens", then score them, and the action
  (pouring water from a plastic bottle into a glass; walking toward the
  camera holding a food container; drizzling olive oil into a pan; crouching
  at the tide line holding a fragment; sitting at the island with a mug;
  walking toward the camera into the sunset). Keep her face large enough to
  read the lips: medium shots for actions, knees-up for walks. Lay the eight
  out with each line's action and camera move under it (`storyboard.jpg`)
  and get the user's OK. `~/projects/microplastics-explainer` is the model:
  `stills.json` maps lines to start frames.
- **New presenter:** `krea2-image`, 9:16, `count: 4`, a stated age, clothing,
  "eyes fixed just past the camera lens, focused, with bright catchlights", a
  plain dark studio. Pick one; it is every segment's first frame. H3 renders
  at 768×1344 whatever the still's size, so a bigger still only matters for
  the library.

## 3. One voice for every line

1. **Maya already has her voice:** skip to 2 with her library clip
   (`from-qwen3-tts-2026-10-18T03-00-55-614Z-2f07ba77.flac`) and its
   transcript as `voice_text` ("This is the new Tesla Roadster, revealed on
   October fifteenth at a SpaceX test site in Texas. I'm Maya, and today
   we're working out how it does any of this."). A new presenter:
   `generate_audio` with `model: qwen3-tts`, `quality: design`, `count: 3`,
   a voice description and the intro line. Send the three to the user (they
   may pick); check each with Whisper for pace and accuracy.
2. For **every** line: `quality: final` (clone), `voice_reference` = the
   chosen clip, `params.voice_text` = what that clip says. Design mode per
   line would give a different voice each time. 8 lines took ~70 s.
3. Pull the files from the box into `voice/<id>.wav`
   (`ssh … docker exec pepper-pro cat /data/outputs/<name>`), then
   `compose.py align` and read what Whisper heard against the script.

## 4. Lip-synced presenter takes

`generate_video`, `model: h3-video`, `quality: draft`, `aspect_ratio: 9:16`,
`image` = the still, `audio` = the line's TTS output, `duration` = the
line + 0.35 s. Write the prompt in H3's base format yourself:

```
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Facial Realism. Photoreal vertical <framing> in <the set and its light>, shallow depth of field, clean frame with no on-screen text, numbers, captions or graphics. The scene begins exactly as shown in <Picture 1>, preserving its subjects, appearance, clothing and setting. <Name>: <the description, with this video's outfit>. <The camera move: type, amplitude, speed, where it ends, e.g. "A steadicam tracks backward at walking pace, keeping her framed from the knees up">. <The action as it unfolds, and when she looks just past the lens: "then lifts her head and looks just past the camera lens, her face turned toward the camera for the rest of the shot">. Her hands move naturally and hold the objects steadily. She speaks every word clearly, her lips, jaw and mouth forming each syllable in sync with her voice. The <light> stays the same throughout the shot. <Name> with <voice description> (S1) says: <d>[English] <the line, exactly></d>

overall_soundscape: <The set's ambience and the action's sounds (water pouring, surf, footsteps)> under her voice; no other sounds.

non_diegetic_music: N/A
```

A line where she only talks to the lens can use a static or slow camera with
"Her shoulders stay square to the camera; her eyes stay fixed just past the
lens" (the earlier videos' default), but no line is static in a video now.

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
  or plan a photo over the bad stretch. Then `python3 scripts/identity.py
  ~/projects/maya-reference/refs/01-library.png takes/S03.mp4 --min 0.75`;
  a take below the bar is a retake even if it looks fine at strip size (the
  user caught a 0.63 take by eye). H3 itself moves the face once she starts
  talking (0.88 on the first frame, 0.59–0.64 a quarter-second later with
  the head still frontal): on one line and seed (2026-10-21) the Facial
  Realism LoRA made no difference (0.72 with, 0.74 without), `final` none
  (0.74, twice the time), and a "calm, relaxed brow, natural eye size"
  direction none (0.71). The start frame is the lever that works (0.63 →
  0.72–0.74, the published El Niño takes' level). A monitor that polls the job ids and
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
  Pull the masters into `presenter-raw/<id>.mp4` (`qc.py --into presenter-raw`)
  to check them; step 6b finishes them into `presenter/` (and `presenter-hdr/`).
  **A take over ~10.5 s runs the box out of RAM**: a 12.25 s take got
  ComfyUI SIGKILLed, and every master queued behind it failed at once
  ("Cannot connect to ComfyUI"). Split long takes at a frame boundary
  (`ffmpeg -t 6.125 … -crf 8` and `-ss 6.125`), copy the halves into the
  box's uploads (`ssh … docker exec -i pepper-pro sh -c 'cat >
  /data/uploads/NAME.mp4' < file`), master each, and join them with ffmpeg's
  concat demuxer (`-c copy`); the seam doesn't show. Remove any preview
  symlinks in `presenter-raw/` before `qc.py --into presenter-raw`, or it writes
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

## 6b. Finishing look (before compose, on the box)

The look that makes the takes read as shot rather than generated, applied to
every master on the box's GPU by the `film-finish` recipe before compose
(photos, captions and pills go on top of it, clean). Per master, two jobs:

- `generate_video`, `model: film-finish`, `video:` the rtx-master job's
  `output_name`, `params: {look: "strong", output: "sdr"}` → `presenter/<id>.mp4`.
- The same with `output: "hdr10"` → `presenter-hdr/<id>.mp4`, for the HDR cuts.

Looks: `strong` is the one the user picked on 2026-10-21 (finish.py's warm
LUT, lifted blacks, halation, glow, chromatic shift, vignette, overlay grain;
the recipe reproduces it within 1-3 code values). `film-strong` / `film` are
the graded-from-light versions (soft highlight roll-off, teal shadows and
warm highlights, dense colour that leaves skin and lips alone, halation, a
Pro-Mist diffusion, lens aberration toward the corners, film grain); `clean`
has no texture. Use the look the user chose for the series; when it is
undecided, show a 100% crop of one take in each. `params.match` (another
take's output name) matches skin and exposure to a hero take of the same set.

The node reports seconds, light levels and the match in the job's `text`.
The CPU encode sets the speed (x264/x265 on the box's 6 cores), not the GPU.
On the laptop the same code runs on MPS, slowly:
`python apps/pepper-pro/server/comfy-nodes/pepper_finish/finish.py IN OUT --look strong`.

## 6c. Deliveries

`compose.py render --scale 1 --out final.mp4 --hdr` writes three cuts from
one pass (graphics drawn once, their white at 203 nits in HDR as BT.2408
asks): `final.mp4` (Rec.709 SDR), `final-hdr10.mp4` (BT.2020 PQ, mastering
and light-level metadata) and `final-hlg.mp4` (BT.2020 HLG, from the HDR10
cut through an exact LUT). Which goes where:

- YouTube: `final-hdr10.mp4`. YouTube makes its own SDR from it; HLG
  uploads reportedly get a flat SDR down-conversion, so not HLG there.
- Instagram: `final-hlg.mp4`, posted **from the phone app**; HDR is
  reported stripped from web uploads, so from the desktop post `final.mp4`.
- Facebook, everything else: `final.mp4`.

The HDR cuts need `presenter-hdr/<id>.mp4` for every segment; without
`--hdr`, compose is SDR only, as before.

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
