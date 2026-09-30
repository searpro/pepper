# Production-quality video on open weights

A research report and roadmap: what it would take for Pepper to produce
image and video work comparable to Kling, Seedance, Higgsfield and Runway
using only open weights, on hardware one person can afford.

Researched 30 September 2026 from model cards, leaderboards, the ComfyUI
community (comfyui-wiki's release log, Hugging Face discussions, Reddit
round-ups) and the Chinese short-drama scene (Bilibili, Sohu, CSDN). Nothing
here has been measured on Pepper's own GPU setup yet; where a number comes
from someone else's run, it says so. The links are listed at the end.

---

## 1. The honest answer first

**The model gap has mostly closed. Pepper's gap is the pipeline around the
model.**

- As of September 2026, **MiniMax H3**, an open-weights model released on
  3 August, is **#2 of all image-to-video models** on the Artificial Analysis
  arena (Elo 1181), above Seedance 2.0 (1176), Wan 3.0 (1164) and Veo 3.1
  (1082). In text-to-video it is #3 (1138), ahead of Kling 3.0 Pro (1015).
  Five weeks earlier no open model came close.
- Pepper already installs H3 through stable-diffusion.cpp. The results feel
  mediocre because of *how* it runs, not because of the model:

  | What Pepper does today | What the arena score assumes |
  | --- | --- |
  | Q4_K_M pruned transformer (11 GB) | bf16 or INT8 |
  | Q4_K_M 32B text encoder | bf16 |
  | 864×480 | 768p native (1344×768), with a 2K regeneration stage on top |
  | Ref2VA checkpoint as shipped | Ref2VA has a known training-quality defect (§5.1) |
  | One 5-second take, no retakes | A reviewer's best take |
  | No refine pass or finishing | 2K regeneration, then MiniMax's own post-processing |

  Pepper's image screens hit the same problem and its fix is already written
  down in `ARCHITECTURE.md` ("Image quality comes from precision and a second
  pass"): Q4 weights plus no second pass gives soft, generic output. That
  finding now needs applying to video.
- The system RAM ceiling (46 GB on the usual 4090 pod) is what forced the Q4
  choices. **That one hardware decision costs more quality than any model
  choice**, and it is cheap to lift (§8).
- The other half of the gap is **workflow**. What the paid tools sell is
  mostly *direction*, not better pixels: reference slots, first and last
  frames, audio-driven shots, retakes, multi-shot continuity, and a
  project that holds all of it together. Pepper generates single clips.
  Chinese short-drama teams make 75-episode series with 3 people in 5 days
  because their tools are organised around the **script → assets → shots →
  takes → edit** flow, not around a prompt box.

**What won't reach parity, even with all of the below:**

- **Resolution.** H3's 2K regeneration stage has not been released (MiniMax
  says it will be, with no date). Locally you get 768p native, upscaled.
  That holds up well in a 9:16 phone feed and is visibly softer than
  Kling's native 1080p on a large screen.
- **Takes longer than 15 seconds.** They have to be chained. Chaining works
  (community workflows reach 90 s with lip-sync), but quality drops a little
  at every hop.
- **Lip-sync to your own audio.** It works, but is less dependable than the
  paid avatar products, especially with two or more speakers in one frame.
- **Licences.** H3's licence forbids use in the US, EU, UK and South Korea,
  and requires "MiniMax H3" to appear in the UI of any commercial product
  built on it. Krea 2 is free only under $1M in revenue. Qwen-Image 2.1 is
  research-only. See §9.

---

## 2. The open-weights landscape, September 2026

### 2.1 Video

| Model | Released | Size | Audio | Inputs | Arena (I2V / T2V) | Licence | In Pepper? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **MiniMax H3** (FL2VA + Ref2VA) | 3 Aug 2026 | 33B dense, Qwen3-VL-32B encoder | Native 32 kHz stereo, dialogue in 11 languages | T2V, first, last, first+last frame (FL2VA); up to 9 images, 3 videos, 3 audio clips (Ref2VA) | **1181 / 1138** | MiniMax H3 Community: under $20M revenue; excluded territories US/EU/UK/KR | Yes, Q4 at 480p |
| **MAGI-2 Preview** (Sand AI) | 5 Aug 2026 | 114B MoE, 6B active | Native | T2V, I2V; 512×896 preview, refiner to 1088×1920 | 1093 / – | Open weights (check the licence) | No. Too large for one 24 GB card for now |
| **LTX-2.5** (Lightricks) | 11 Aug 2026 | 22B, Gemma-4-12B encoder | Native | T2V, I2V, FLF, **audio-to-video**, V2V, native multishot, IC-LoRAs | 1038 (Fast) | LTX-2.x Community: under $10M | Yes (T2V, I2V; sd-cli has no A2V or IC-LoRA) |
| **Wan 2.2** A14B / S2V / Animate | Jul 2025 | 14B MoE | No (S2V: audio-driven) | T2V, I2V, FLF, VACE, S2V | not ranked | Apache-2.0 | I2V (Lightning), S2V |
| **HunyuanVideo 1.5** | late 2025 | 8.3B | No | T2V, I2V | not ranked | Tencent Hunyuan | Yes |
| **Wan-Dancer-14B** | 13 Jul 2026 | 14B | Music-driven | Reference image + music → dance, 720p/30 fps, over 1 minute | – | Apache-2.0 | No |
| **LongCat-Video-Avatar 1.5** (Meituan) | 21 May 2026 | ~14B | Speech/singing-driven | Image + 1..N audio tracks, multi-person, video continuation | – | MIT | No |
| **InfiniteTalk** (MeiGen) | Aug 2025 | Wan 2.1 14B + adapter | Speech-driven | Image or video + audio, 2 speakers with boxes, unlimited length | – | Apache-2.0 | No |
| **Wan-Animate-2 / Lite** | 7 Aug 2026 | reportedly 33.1B / 17.3B | – | Character image + driving video | – | Apache-2.0 | No |
| **SCAIL-2** (Zhipu) | 9 Jun 2026 | – | – | Character image + raw driving video (no skeleton) | – | Apache-2.0 | No |

Closed-only, for orientation: **Wan 2.5, 2.6, 2.7 and 3.0 were never released
as weights**; the last open Wan is 2.2. Several blogs say otherwise; they are
wrong. Seedance 2.x, Kling 3.x, Veo 3.1 and H3 Max are API-only.

What this means in practice:

- **H3 is the new default for anything with a face in it.** Community
  comparisons agree: H3 keeps the face, hairstyle and outfit from the
  reference, while LTX-2.5 drifts away from the input face over the clip.
  Reviewers also prefer H3's acting and reaction detail.
- **LTX-2.5 is the second engine, not a replacement.** It is faster and
  lip-syncs *supplied* audio better (a Japanese side-by-side found H3's
  lip-sync "lacking" while LTX-2.5's "match up nicely"). It is steadier on
  wide shots, vehicles and scenery, and runs up to 30 s in one pass for shots
  where faces don't matter.
- **Wan 2.2 is no longer the quality leader.** It is still the best
  Apache-licensed base, and a large ecosystem is built on it (Wan-Dancer,
  InfiniteTalk, VACE, ID-V2V). But for people shots, H3 replaces it.
- **The ecosystem moved to H3 within a month.** Dozens of H3 add-ons went
  through comfyui-wiki's release log in eight weeks: turbo LoRAs (2, 4, 8 steps), GGUF,
  INT8 and NVFP4 quants, a trained 2× latent upscaler, clip chaining, a
  ControlNet union, face and character swap LoRAs, camera-path editors,
  timeline storyboard editors, reference adapters. All of it is ComfyUI-only.

### 2.2 Images

| Model | Size | Strength | Licence (commercial?) | In sd-cli |
| --- | --- | --- | --- | --- |
| **Krea 2** (Raw + Turbo, 23 Jun 2026) | 12B | #1 independent-lab model on the Artificial Analysis T2I board, #6 overall. Photoreal skin, fabric and hair, film look | Community licence: **free under $1M revenue** | Yes |
| **Qwen-Image 2.1** (20 Sep 2026) | 7B | T2I + edit in one model, up to **10 reference images**, RGBA output, text | **Qwen Research License**: not for commercial use (2.0 was Apache) | Yes (in Pepper) |
| **Z-Image Turbo / Base** | 6B | Fast photoreal, bilingual text | Apache-2.0 | Yes (in Pepper) |
| **FLUX.2 klein 4B / 9B** | 4B / 9B | Fast edit, multi-reference | 4B Apache; 9B non-commercial | Yes (in Pepper) |
| **Mage-Flow / Edit** | 4B | Native resolution to 2048 px, multi-reference edit | MIT | Yes (in Pepper) |
| **SenseNova U1.5** | large | Native 4K T2I and editing, text | check | Yes |
| **HunyuanImage 3.0 Instruct** | 80B MoE | #1 open model on the image-editing arena (Elo 1223) | Tencent | No, too large |

User comparisons put Krea 2 clearly ahead of Z-Image Base on skin, fabric,
hair and prompt adherence, and ahead of Qwen-Image 2.1 on anatomy and faces.
Qwen-Image 2.1 is the best *editor* (10 references, masks, RGBA), but its
licence makes it a personal and prototyping tool.

---

## 3. The paid-tool features, and how to get each one on open weights

| Feature on Kling / Seedance / Higgsfield | Open-weights route | Engine support today |
| --- | --- | --- |
| Image to video | H3 FL2VA (first frame); LTX-2.5 I2V | sd-cli ✓ |
| First + last frame | H3 FL2VA (first+last); LTX-2.5 FLF; Wan 2.2 FLF | sd-cli ✓ (H3, LTX) |
| Multi-reference ("elements", characters + product + location) | H3 Ref2VA: 9 images, 3 videos, 3 audio clips, bound to `<Subject n>` in the prompt | sd-cli ✓ (`--ref-image` ×n), quality defect unfixed |
| Dialogue with a chosen voice | H3 writes and voices the lines itself (quoted in the prompt) with a voice-timbre reference clip | sd-cli ✓ (`--ref-audio`) |
| **Image + your own audio → video** (lip-sync) | LTX-2.5 A2V (audio latent frozen); H3 with the audio latent pinned (LanPaint 2.0); InfiniteTalk; LongCat-Avatar 1.5; Wan 2.2 S2V | sd-cli: Wan S2V only. The rest need ComfyUI or Python |
| **First frame + audio**, first + last + audio | LTX-2.5 FLF with frozen audio; H3 FL2VA with pinned audio latent | ComfyUI only |
| Multi-person talking | H3 Ref2VA (per-subject voices); LongCat-Avatar 1.5 multi-stream; InfiniteTalk (2 speakers + boxes) | ComfyUI / Python |
| Long takes, "extend" | H3 Motion Context chaining (22 context frames + 1 s of audio carried in latent); LTX extend; InfiniteTalk | ComfyUI only |
| Multi-shot in one generation | LTX-2.5 native multishot; H3 cinematic-coverage workflows | ComfyUI only |
| Motion transfer / character replacement | Wan-Animate-2, SCAIL-2, Viggle-Animate, H3 Character Swap LoRA | ComfyUI only |
| Dance to music | Wan-Dancer-14B | Python / ComfyUI |
| Camera control | H3 Camera path editor, CrossView LoRAs, LTX CrossView IC-LoRA, SCoPE for Wan 2.2 | ComfyUI only |
| Restyle or relight a clip, keeping the actor | ID-V2V (Wan 2.1 VACE based, SIGGRAPH Asia 2026) | ComfyUI only |
| 1080p / 4K finish | SeedVR2 (7B, or 1.4B distilled), VOSR 2.0 one-step, H3 trained 2× latent upscaler, LTX latent upscaler | SeedVR2 ✓ (Pepper runner) |
| Retake part of a clip | H3 Director "Retake Stitch", LTX retake mode | ComfyUI only |

**Every row that matters for the four targets is either ComfyUI-only today,
or supported by sd-cli without the fix that makes it look good.** That is the
central architectural fact (§7).

---

## 4. Recipes for the four targets

Each recipe assumes the engine and hardware changes in §7 and §8. Settings
come from the cited community runs; each needs validating on Pepper before
it becomes a catalogue default.

### 4.1 Short-form drama (duǎnjù, 9:16)

This is the target the Chinese scene has industrialised. Their pipeline,
consistent across the Sohu write-up, the free "绘影" (Huiying) desktop app
and the "短剧导演台" (short-drama director's desk) ComfyUI suite now at V7, is:

> script breakdown → asset extraction → asset design → asset images →
> storyboard → per-shot video prompt → video → dub → edit

1. **Script → shot list (LLM).** Claude over MCP plays the role DeepSeek or
   Qwen play in the Chinese stacks: a structured JSON shot list (shot id,
   duration, framing, characters present, dialogue lines with speaker,
   camera move, sound). The 导演台 splits one story into N independent
   clips of 15 s or less, each with an H3-format Ref2VA prompt and a note
   of which reference materials it uses (up to 24 images, 8 videos, 8 audio
   clips per project, scheduled per shot).
2. **Assets.** One sheet per character (Pepper's Character Studio already
   does this), plus locations and props. Generate with **Krea 2** for
   realism, or Z-Image for Apache-licensed work, with the hires pass. Lock
   identity for the whole series using either:
   - an **H3 RefMod**: 8–16 photos encoded once into a 1–1.6 MB file that
     loads like a LoRA and feeds H3's reference path. No training run. Or
   - a **character LoRA** (the Chinese standard is 30–50 images; AI Toolkit
     trains H3 and Krea 2 LoRAs).
3. **Keyframes (optional, for hero shots).** Qwen-Image 2.1 or Mage-Flow Edit
   composes "character A in location B holding prop C" from several
   references. A 2×2 storyboard grid (四宫格) per scene is the popular way to
   lock the blocking before paying for video.
4. **Shots.**
   - Dialogue scenes: **H3 Ref2VA with the hybrid weights** (§5.1). Put
     the characters in `<Subject n>` slots, give a voice-timbre clip per
     speaker, and write the lines in quotes: `<Subject 1> says exactly this
     "…".` Add an `overall_soundscape` or `Sound:` clause so silent stretches
     don't mumble. About a sentence or two per 5 s.
   - Action or establishing shots: H3 FL2VA from a keyframe, or LTX-2.5 for
     wide and scenery shots.
   - Draft every shot with a 4–8-step turbo LoRA at about 0.4 MP, audition
     seeds, then render the chosen seed at 768p and 2× latent-upscale.
5. **Voice.** H3's in-model voice is good enough for drafts. For a
   consistent series voice, render lines with Pepper's TTS (Qwen3-TTS,
   IndexTTS-2.5, Chatterbox) and drive the shot from that audio (§4.2).
6. **Edit.** Concatenate with short audio crossfades, add a BGM bed (ACE-Step
   or MiniMax Music 3), and burn in subtitles. Export 1080×1920.

Output quality to expect: arena-level 768p, upscaled to 1080×1920. That is
the resolution short-drama platforms deliver at anyway.

### 4.2 Talking videos, one or more people

There are two different products here, and they need different models.

**(a) The model writes and voices the lines** (a scene, a skit): H3 Ref2VA as
in §4.1. Two or three people in one shot work (a 5090 blog series found
Ref2VA "handles multiple characters in a single shot with strong dialogue
accuracy"). This is the most natural-looking option, but you don't control
the exact audio.

**(b) Lip-sync to your own audio** (a podcast, an explainer, a dub): the
audio track is fixed and the video follows it.

| Option | Quality | Length | Multi-person | Cost on the card | Notes |
| --- | --- | --- | --- | --- | --- |
| **LTX-2.5 A2V** | Good lip-sync, weaker identity hold | 2–20 s per pass; extend | Prompted | Fits 24 GB (INT8 / GGUF) | Freeze the supplied audio latent in both stages. Letting the model "improve" the audio breaks the sync |
| **H3 with pinned audio latent** | Best face and acting; sync can drift on dense lines | ≤15 s per pass; Motion Context chains to 90 s+ | Yes, per subject | 12 GB+ with INT8 (slow); comfortable at 32 GB+ | The newest route. LanPaint 2.0 does H3 audio and video inpainting |
| **InfiniteTalk** | Very reliable sync, older Wan 2.1 look | Unlimited (streamed) | 2 speakers with bounding boxes | 24 GB with GGUF | Audio CFG 3–5; 6–12 steps on GGUF. More steps adds jitter |
| **LongCat-Video-Avatar 1.5** | Best long-form identity (82 s held); singing | Minutes, segmented | Yes, each mouth driven by its own track | ~40 GB with INT8 + 8-step distill; ~44 GPU-seconds per second of video on an A800 | MIT. Waxy without a reference photo |
| Wan 2.2 S2V (current) | Weaker expression transitions | Pepper chunks it | No | 24 GB | Keep as the fallback |

Recommended default: **(a) H3 for scenes, (b) LTX-2.5 A2V for fast
single-speaker lip-sync, and LongCat-Avatar 1.5 on a 48 GB+ pod for long,
premium talking-head and multi-speaker work.** Pepper's existing S2V
chunk-and-stitch logic (`services/s2v.ts`) is the right shape for all of
them. Generalise it from "slice audio into Wan windows" to "slice audio
into engine-sized windows, carry context, stitch, re-mux the original
audio".

Two techniques apply whichever model you use:

- **Separate the vocals first.** Drive the lip-sync from the isolated vocal
  stem (Demucs or MelBand-RoFormer), then mux the full mix back on. The
  LongCat hands-on write-up calls vocal separation its first setup trap.
  Music under speech makes mouths chew.
- **Pick a reference image with the mouth closed and the face frontal or
  3/4.** Every avatar model degrades from a profile or open-mouth reference.

### 4.3 Fashion and product: photos and videos

**Photos.**
- Base model: Krea 2 (editorial and campaign look; the community's "Famegrid"
  editorial-portrait workflows use it) or Z-Image for Apache-licensed work.
  Always use the hires pass.
- Consistent model and outfit across a lookbook: the "Photoshoot" pattern
  (ComfyUI-Photoshoot). Define the person once (44 structured fields: body,
  face, hair, make-up, clothing), then vary six axes per frame: framing,
  pose, placement, expression, focus, aspect ratio. Pepper's Character
  Studio is halfway there. Add the shot-variation grid.
- Virtual try-on: a multi-reference edit, "model image + garment image →
  model wearing garment". Qwen-Image 2.1 with its 10 references does it
  best, but it is research-licensed. The commercial routes are FLUX.2 klein
  4B (Apache) or Mage-Flow Edit (MIT), with a try-on LoRA where one exists.
- Packshots: RGBA output (Qwen-Image 2.1) or background removal, then
  composite. Text and logos must be checked by eye: generation still warps
  small type. Composite the real logo on in post rather than trusting the
  model.

**Videos.**
- Product B-roll: H3 FL2VA from the packshot as the first frame. The **360
  Orbit LoRA** (one photo to a full orbit) and camera-path tools cover the
  turntable and push-in moves ads use. MiniMax pitches H3 for advertising
  and e-commerce, but its "preserves small text and brand marks" claim is
  about the unreleased 2K stage, so check labels locally. LTX-2.5 suits
  macro and texture shots.
- On-model video: generate the try-on still, then H3 FL2VA (walk, turn,
  fabric motion). For a runway walk from a reference clip, use Wan-Animate-2
  or SCAIL-2 (SCAIL for precise limbs, Wan-Animate for lighting and mood).
- Restyle a real shoot (new location or lighting, same model and
  performance): ID-V2V.

### 4.4 AI character performing music (audio + character reference → video)

This is the hardest target, because it combines long duration, lip-sync to
singing, and full-body and instrument motion.

1. **Stems.** Separate vocals from the backing track, and detect beats and
   sections (librosa). Everything downstream keys off these.
2. **Performance shots (singing to camera).** Drive the singer from the
   **vocal stem** with LongCat-Avatar 1.5 (singing was a tested case, and
   identity held over 82 s) or H3 with the pinned audio latent and Motion
   Context chaining. Mux the *original full mix* back on at the end, as
   Pepper's S2V path already does.
3. **Dance or body shots.** Wan-Dancer-14B: reference image + music →
   720p/30 fps dance synced to the rhythm for over a minute, in five genres
   (K-pop, street, Latin, tap, Chinese classical). Apache-2.0.
4. **Instrument and B-roll shots.** H3 Ref2VA or LTX-2.5 A2V with the backing
   track as audio: guitar strums and drum hits land on the beat. The "H3
   MultiRef" workflow suite has a dedicated music-video mode.
5. **Edit on the beat.** Cut between performance, dance and B-roll on the
   detected downbeats. The cutting, more than any single shot, is what makes
   AI music videos look produced. It is plain ffmpeg work Pepper can
   automate.

Paid tools don't do step 5 for you either. A beat-aware assembly step would
put Pepper *ahead* of them for this use case.

---

## 5. Techniques that separate "mediocre" from "production"

These are the practices the community converged on in August and September
2026. Most are small, and none are visible in a model card.

### 5.1 Fix Ref2VA with the hybrid merge

MiniMax confirmed a training-quality issue in the Ref2VA checkpoint. Over 97%
of its weights match FL2VA's; the difference is in the AdaLN modulation
projections that route the reference modalities. The fix
(`ComfyUI_MinimaxH3HybridLoader`) loads **FL2VA as the base and overlays
only Ref2VA's AdaLN weights for blocks 25–49** (of 50). This restores
FL2VA's picture quality and keeps reference conditioning.

This is a weight-level merge, so **Pepper can ship it without ComfyUI**:
merge once offline, quantize, and publish the merged file as the Ref2VA
checkpoint in the catalogue. It is the single cheapest quality win available.

### 5.2 Precision before steps

Pepper's own image finding applies to video. Measured community setups:

- 24 GB card: INT8 transformer (19.5–21 GB) + INT8 text encoder (25 GB) needs
  **64 GB of system RAM**, about 2 min per 5 s clip (Chinese GPU guide).
- 32 GB (5090): 15 s at native 1344×768 in 518 s, or 1080p in 314 s with
  SageAttention and a hardware VSR finish.
- 96 GB (RTX PRO 6000): a 4-step 1152×640, 10 s single-reference clip with
  audio in 76 s.

Q2 text encoders "visibly degrade prompt following", and Pepper's own
catalogue notes Q4 as the floor. The text encoder matters as much as the
transformer: H3's 32B encoder is what reads your shot direction. `ClipProj`
swaps it for a 4B one to save memory; that is a draft-only trade.

### 5.3 Draft cheap, finish expensive

Every serious local workflow now works in two tiers:

1. **Audition** at about 0.4 MP with a turbo LoRA (4–8 steps), 4–8 seeds
   (the ComfyUI-H3-SeedScout pattern). Seconds to a minute each.
2. **Finish** the chosen seed at 768p with full steps, or the turbo at 8,
   then the **trained 2× latent upscaler** and a short refine pass (audio
   locked, `audio_denoise 0`). Community: 10 s at 1344×768 in 150–180 s.
   Alternatively, draft with H3 at 672×384 and refine the keeper with
   LTX-2.5 (NVIDIA's hybrid pipeline).
3. **Master:** SeedVR2 (the 7B for hero shots, the 1.4B distill is 1.6× faster
   at 4.6 GB peak) or VOSR 2.0 to 1080p/4K.

Pepper today renders one final-quality take and hopes. Retakes are where the
paid tools' "consistency" really comes from: their users reroll too.

### 5.4 Turbo LoRAs are for drafts; don't stack them with refinement

Pepper already learned this on images (turbo + hires overcooks). The same
holds for video: community reports tie turbo LoRAs and caches (EasyCache,
Spectrum) to smeary motion, a slow-motion feel, and degraded music audio.
Use them to find the shot, not to finish it. The current
`wan2.2-i2v-a14b` entry, with Lightning merged into *both* experts at 2+2
steps, is the video version of this mistake. Community practice for Wan 2.2
keeps the high-noise expert undistilled with real CFG, because that expert
decides the motion.

### 5.5 Prompt like the model was trained

H3 was trained on structured prompts. MiniMax publishes an official prompt
skill and a local 8B prompt-rewriter LoRA. The patterns that matter:

- `<Subject n>` bindings for every reference, and `<Audio n> is the
  voice-timbre reference for <Subject n>`.
- Dialogue as `says exactly this "…"`, ending with a full stop.
- A closing `Sound:` clause (ambience, music genre, tempo, instruments;
  never an artist or song name), and effects tied to actions ("pops exactly
  as the cork flies").
- Short references work better: trimmed 2–5 s voice clips, and `match` rather
  than `max` image sizing.

Pepper's LLM (or Claude) should write these prompts from a shot spec. People
shouldn't have to.

### 5.6 Continuity is carried in latents, not frames

Pepper's S2V seeds each window with the previous window's last *frame*.
H3 Motion Context carries 22 frames of *latent* context plus exactly 1 s
(24 frames, on H3's 40 Hz audio grid) of audio latent into the next clip,
then dissolves the overlap. Latent carry avoids a VAE round-trip every hop,
which is where chained clips lose sharpness and audio loses its top end. The
community recommends 20 s chunks.

### 5.7 Finishing

- Upscale (above). H3 is already 24 fps, so no frame interpolation is
  needed. Wan's 16 fps output needs RIFE or GIMM to reach 24/30.
- Audio: loudness-normalise (EBU R128, −14 LUFS for social), and crossfade
  at every join.
- Grade: one LUT per project, applied to every shot, hides the
  shot-to-shot colour drift that makes AI edits look stitched together.
- Provenance: a C2PA node exists. Some platforms and the Krea licence require
  AI disclosure.

---

## 6. The product: a project workflow, not another node graph

The user's instinct matches what won in China: **ComfyUI is the engine
everyone uses and the interface almost nobody wants.** The tools that ship
series (绘影, 短剧导演台, H3 Director, AI Movie Studio 2, the
Photoshoot nodes) all put a *domain* model on top of the graph: a person,
a shot, a timeline. Pepper should be that layer, with Claude as the
director.

### 6.1 Data model

```
project ── style (look LUT, aspect, fps, target platform, licence mode)
  ├─ assets
  │    ├─ character (exists: description, sheet, portraits, voice)
  │    │     + identity pack: RefMod file / LoRA / chosen reference set
  │    ├─ location, prop, product (reference images, description)
  │    └─ audio (voice lines, songs, stems, beat map)
  ├─ script (text; Claude-editable)
  ├─ scenes → shots
  │    shot: kind (dialogue | action | talking-audio | performance | b-roll | product)
  │          duration, aspect, framing, camera move, assets[], dialogue[{speaker, line}],
  │          keyframes {first?, last?}, audio {driving? | generated}, engine recipe
  │    └─ takes: job id, seed, draft|final, score, chosen
  └─ cut: ordered chosen takes + transitions + music bed + subtitles → export
```

This extends Character Studio's principle ("characters are data the other
screens read, not a generation mode") to everything else. A shot is data,
and the engine recipe turns it into a job.

### 6.2 Screens

1. **Project**: script, style, assets.
2. **Storyboard**: a grid of shots. Each card shows its keyframe, dialogue
   and assets, with a "draft ×4" button that renders four cheap takes.
3. **Shot**: take comparison, pick one, "finish" (full render + upscale),
   and retake a time range.
4. **Cut**: a timeline of chosen takes with music bed, beat markers and
   subtitles, then export.

### 6.3 MCP

Keep the tool count small (the CLAUDE.md rule). Three tools cover it:

- `plan_project`: script in, shot list out (or edits to it).
- `render_shots`: shot ids plus draft or final; returns job ids.
- `get_project`: shots, takes and their states, and the cut.

Claude writes the script, breaks it into shots, writes H3-format prompts,
reviews the drafts (the media view already shows results in the chat), and
asks for retakes. ComfyUI's own "Comfy MCP" (June–August 2026) shows the
demand for agent-driven production, but it hands the agent a graph. Pepper
would hand it a story.

---

## 7. Engine strategy: add ComfyUI as a headless video engine

### 7.1 Why sd-cli alone cannot get there

stable-diffusion.cpp has been impressively fast at adding models: H3 on day 1,
LTX-2.5 nine days after release, Krea 2 and Qwen-Image 2.1 too. Keep it for
images and for simple T2V/I2V/FLF. But its own docs list what it does not do:

- LTX-2.x: no audio-to-video, no IC-LoRA, no multishot, no temporal
  upscaler, no diffusion decoder (conv VAE only), no duration head.
- H3: none of the community pieces: hybrid loading, latent upscaler,
  motion-context chaining, audio-latent pinning, turbo LoRA stacks, sparse
  attention, retake stitching.
- Runtime LoRAs don't work on the Wan 2.2 two-expert model, which is why
  Lightning had to be merged (§5.4).

Each of these is days of work in C++/ggml. Together they are a moving target:
dozens of H3 add-ons in eight weeks. **Porting the ecosystem to sd-cli is a race
Pepper cannot win**, and the Python runners (`pepper_runner`) have the same
problem more slowly: each one reimplements a pipeline that already exists as
a ComfyUI graph.

### 7.2 The proposal

Run **ComfyUI as a managed, headless backend**, only for the video
recipes that need it. Pepper already reserves this shape: `backends/python.ts`
supports resident Python servers and names ComfyUI as the intended case,
with `/system_stats` as its health check.

- **Pepper owns the graphs.** Versioned API-format workflow templates live
  in the repo (`server/comfy/workflows/<recipe>.json`), each with a small
  parameter map (prompt, refs, seed, size, frames, audio, steps). Users
  never see a node graph. A catalogue entry names `engine: comfy` and a
  recipe id.
- **One model store.** An `extra_model_paths.yaml` points ComfyUI at
  Pepper's bundle directories, so the download manager, the catalogue and
  the storage quota remain the single source of truth.
- **Pinned custom nodes.** Every custom node is installed at a commit hash
  in the Dockerfile's Python layer, like the SeedVR2 package already is
  (`python-packages.ts`). No ComfyUI-Manager and no runtime installs. That
  is both the supply-chain control and the reproducibility guarantee.
- **Jobs stay Pepper jobs.** Submit via `POST /prompt`, stream progress over
  the websocket into the job's `StepProgress`, cancel via `/interrupt`, and
  collect outputs from the history API into Pepper's outputs. The job
  queue, retention, MCP and media view don't change.
- **Memory discipline.** ComfyUI caches models between runs, which breaks
  Pepper's "nothing resident between jobs" rule. `BackendManager` should
  treat it like llama.cpp: stop it (or call `/free`) before an sd-cli or
  runner job, and stop the others before a Comfy job. On a 96 GB card,
  keeping H3 warm between takes is the point, so make it a setting.

What this costs: a large Python dependency set (already baked into the
image for the runners), graph JSON that breaks when node packs change (hence
pinning and a smoke test per recipe), and a second code path for video. What
it buys: new techniques reach Pepper when the community ships them, as
a template-and-pin change of a few lines instead of a port.

### 7.3 Which engine for what

| Work | Engine |
| --- | --- |
| All image generation and editing, hires pass | sd-cli (as now) |
| H3 / LTX T2V, I2V, FLF drafts | sd-cli (as now), or Comfy once templates exist |
| H3 Ref2VA hybrid, turbo drafts, latent upscale, chaining, pinned-audio lip-sync | **ComfyUI** |
| LTX-2.5 A2V, multishot, IC-LoRA, extend | **ComfyUI** |
| Wan-Animate-2, SCAIL-2, ID-V2V, InfiniteTalk, Wan-Dancer | **ComfyUI** (native or Kijai nodes) |
| LongCat-Avatar 1.5 | ComfyUI-LongCat-Avatar, or a Python runner |
| SeedVR2, spandrel upscalers, YuE2 | Python runners (as now) |
| Assembly, audio mix, subtitles, LUT, export | ffmpeg (`util/ffmpeg.ts`) |

---

## 8. Hardware: lift the RAM ceiling

RunPod prices, mid-2026 (community cloud unless noted):

| GPU | VRAM | ~$/h | What it enables |
| --- | --- | --- | --- |
| RTX 4090 | 24 GB | 0.34 (0.69 secure) | Images; H3 at INT8 **only with a 64 GB+ RAM host** (`--min-ram 64`); LTX-2.5 at INT8/Q6 |
| RTX 5090 | 32 GB | 0.69 | H3 INT8 comfortably, NVFP4 kernels; community's reference card for H3 |
| L40S / A6000 | 48 GB | 0.79 / 0.86 | LongCat-Avatar 1.5 (INT8); H3 INT8 with the encoder resident |
| RTX PRO 6000 | 96 GB | 2.09 | H3 fully resident, no offload; the fastest iteration loop |
| H100 80 GB | 80 GB | 1.99 | Same class; better for MAGI-2 experiments |

A rough cost for a finished 10-second shot on an RTX PRO 6000, from the
76 s-per-take community figure: four 4-step drafts plus one final and
upscale comes to about 6–8 minutes, or **$0.20–0.30**. Kling 3.0 is about
$0.075 per second, **$0.75 per 10 s before any rerolls**. Local wins on cost
by a wide margin once the pod is warm. It loses on convenience: model
downloads, idle shutdown and cold starts, which Pepper already manages.

**Recommendation:** make the RTX 5090 (32 GB) or a 64 GB-RAM 4090 host the
default video tier, and a 96 GB card the "finishing session" tier. Keep the
46 GB-RAM 4090 for images and drafts. Put the tier in the launcher
(`--gpu`, `--min-ram`) and in each catalogue recipe ("needs ≥ 64 GB RAM"),
so an install never lands a model on a host that will force Q4.

---

## 9. Licences, at a glance

| Model | Commercial use | Watch out for |
| --- | --- | --- |
| MiniMax H3 | Under $20M revenue | **Not usable in the US, EU, UK or South Korea, outputs included.** A commercial product must show "MiniMax H3" in its UI. Comfy is the official reseller of commercial licences |
| LTX-2.5 | Under $10M revenue | – |
| Wan 2.2 family, Wan-Dancer, Wan-Animate-2, InfiniteTalk, SCAIL-2 | Apache-2.0 | – |
| LongCat-Video-Avatar 1.5 | MIT | – |
| Krea 2 | Under $1M revenue | Content filtering and AI disclosure required; the licence ends if you sue Krea |
| Qwen-Image 2.1 | **Research only** | The catalogue entry doesn't say so. It should |
| FLUX.2 klein 9B (and True-V2 fine-tune) | Non-commercial | – |
| Z-Image, FLUX.2 klein 4B, Mage-Flow | Apache-2.0 / MIT | The safe commercial image stack |

Pepper should add a **licence mode** (personal / commercial) to Preferences
and to each project, and filter recipes accordingly. An H3-based project
should say, at export, where its output can legally be used.

---

## 10. Roadmap

### Phase 0: quick wins, no new architecture (days)

1. **Ship the H3 hybrid Ref2VA** as a merged, quantized file (§5.1).
2. **Render H3 at native 768p** (1344×768, and 768×1344 for 9:16) instead of
   864×480. The model was trained there.
3. **Precision tier:** add INT8/Q8 H3 recipes marked "needs ≥ 64 GB RAM",
   and make the launcher able to ask for that host.
4. **Takes:** a "×4 drafts" option on the video screen (seed sweep at low
   resolution), and "finish this seed" (full resolution + SeedVR2).
5. **Wan 2.2 I2V:** an entry that keeps the high-noise expert undistilled
   (real CFG) and Lightning only on low noise, if sd-cli's MoE path allows
   per-expert steps (it already takes `high_noise` settings). Otherwise
   demote Wan for people shots and point to H3.
6. **Catalogue honesty:** licence notes for Qwen-Image 2.1 and H3, and the
   Ref2VA description corrected. Audio conditions voice timbre, and quoted
   lines are voiced by the model.
7. **Add Krea 2** (sd-cli supports it) as the photoreal image default for
   personal / small-business mode.

### Phase 1: ComfyUI engine and the first video recipes (2–3 weeks)

1. Comfy backend: template + parameter map, progress, cancel, outputs, shared
   model paths, pinned nodes, a smoke test per template.
2. Recipes: H3 hybrid Ref2VA draft/final with the trained latent upscaler;
   H3 FL2VA first/last; **LTX-2.5 A2V (image + audio → video, first frame +
   audio)**; H3 Motion Context chaining for long takes.
3. Generalise `s2v.ts` chunking into an engine-agnostic long-audio driver
   (vocal separation → windows → latent carry → stitch → original-audio mux).

### Phase 2: Projects (3–4 weeks)

1. Data model (§6.1), storyboard and shot screens, takes, the cut timeline,
   ffmpeg export (crossfades, loudness, LUT, subtitles, 9:16).
2. The MCP trio (`plan_project`, `render_shots`, `get_project`) and an
   H3-format prompt writer.
3. Identity packs: build a RefMod or LoRA from a Character Studio sheet with
   one button.

### Phase 3: specialists and evaluation

1. Talking: LongCat-Avatar 1.5 (48 GB tier), InfiniteTalk (24 GB).
2. Music: Wan-Dancer, beat detection, beat-cut assembly.
3. Fashion: try-on recipe (commercial-safe edit model), the Photoshoot
   variation grid, the orbit LoRA, Wan-Animate-2 / SCAIL-2 motion transfer.
4. **Golden-shot evaluation.** A fixed set of ~20 shots across the four
   targets (a two-person dialogue, a singing close-up, a product orbit, a
   lookbook turn, a wide action shot), rendered by every recipe change and
   shown side by side with blind A/B picks. Without it, "better" stays a
   feeling. Pepper's image work became measurable the same way (fixed seeds,
   the striping spectrum); video needs the same discipline.

### Watchlist

- **H3-Regenerate-2K** and H3 sparse-attention code (promised, undated).
  Native 2K would close the last visible gap to Kling.
- **MAGI-2** beyond preview: 1088×1920 native vertical output, but 114B
  total parameters.
- **Wan 3.0 weights**: API-only today. Alibaba open-sourced 2.1 and 2.2
  months after their launches, but has not done so for 2.5–3.0.
- **DreamX-Creator 1.0** (7B joint audio-video at 2K, 3 Sep 2026): small
  enough for 24 GB if the quality holds up.
- **FLUX 3** (BFL's multimodal video+audio+image, July 2026): check whether
  and how weights are released.

---

## Sources

Leaderboards and model cards
- [Artificial Analysis: image-to-video](https://artificialanalysis.ai/video/leaderboard/image-to-video), [open weights](https://artificialanalysis.ai/video/leaderboard/image-to-video/open-weights), [text-to-video](https://artificialanalysis.ai/video/leaderboard/text-to-video)
- [MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3), [licence](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE), [audio-to-subject binding discussion](https://huggingface.co/MiniMaxAI/MiniMax-H3/discussions/64)
- [RunPod: MiniMax H3 and what it takes to run](https://www.runpod.io/blog/minimax-h3-the-open-weight-omni-modal-video-model-and-what-it-takes-to-run-it)
- [H3 2K regeneration release plans](https://runtimewire.com/article/minimax-h3-2k-regeneration-open-release)
- [Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5), [LTX-2.5 release notes](https://comfyui-wiki.com/en/news/2026-08-11-ltx-2-5-open-weights-release)
- [MAGI-2 Preview](https://comfyui-wiki.com/en/news/2026-08-05-magi-2-preview)
- [Wan 2.7 open-weight status](https://wan27.org/blog/wan-2-7-open-source-guide), [Wan 3.0 status](https://wavespeed.ai/blog/video-model-access/is-wan-3-0-open-source/)
- [Wan-Dancer-14B](https://comfyui-wiki.com/en/news/2026-07-13-wan-dancer-14b-music-to-dance)
- [LongCat-Video-Avatar 1.5 hands-on](https://www.visionstory.ai/open-source/longcat-video-avatar), [model](https://huggingface.co/meituan-longcat/LongCat-Video-Avatar)
- [InfiniteTalk](https://github.com/MeiGen-AI/InfiniteTalk), [MultiTalk / InfiniteTalk / S2V comparison](https://zanno.se/lets-talk-multitalk-infinitetalk-wan-s2v/)
- [Avatar-Forever](https://comfyui-wiki.com/en/news/2026-08-23-avatarforever-real-time-avatars)
- [Wan-Animate-2](https://blog.comfy.org/p/wan-animate-2-is-now-available-in), [SCAIL-2 vs Wan Animate](https://floyo.ai/comparison/scail-2-vs-wan-2-2-animate), [Viggle-Animate](https://comfyui-wiki.com/en/news/2026-09-05-viggle-animate)
- [ID-V2V](https://comfyui-wiki.com/en/news/2026-07-29-id-v2v-comfyui-support)
- [SeedVR2-1.4B](https://comfyui-wiki.com/en/news/2026-07-29-seedvr2-1-4b-distilled-upscaler), [VOSR 2.0](https://comfyui-wiki.com/en/news/2026-09-19-comfyui-vosr2)

Images
- [Krea 2 open source](https://www.krea.ai/krea-2-open-source), [Krea 2 licensing](https://www.krea.ai/krea-2-licensing), [Qwen-Image 2.1 vs Krea 2](https://myaiforce.com/qwen-image-2-1/)
- [Qwen-Image 2.1 model card](https://huggingface.co/Qwen/Qwen-Image-2.1), [release summary](https://www.besthub.dev/articles/qwen-image-2-1-7b-dit-unifies-text-to-image-editing-transparent-output-e996130a4afc)
- [Flux2-Klein-9B-True-V2](https://comfyui-wiki.com/en/news/2026-07-01-flux2-klein-9b-true-v2-news)
- [ComfyUI Photoshoot](https://comfyui-wiki.com/en/news/2026-08-25-comfyui-photoshoot)
- [Qwen Edit try-on LoRA](https://huggingface.co/FoxBaze/Try_On_Qwen_Edit_Lora_Alpha), [OpenTryOn](https://github.com/tryonlabs/opentryon)

Techniques and community measurements
- [H3 hybrid loader (Ref2VA fix)](https://github.com/scottmudge/ComfyUI_MinimaxH3HybridLoader)
- [H3 Motion Context](https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context), [Auto-Chain](https://comfyui-wiki.com/en/news/2026-08-25-h3-motion-context-auto-chain), [Endless MiniMax H3](https://comfyui-wiki.com/en/news/2026-09-03-endless-minimax-h3)
- [H3 trained 2× latent upscaler](https://comfyui-wiki.com/en/news/2026-08-17-minimax-h3-trained-latent-upscaler)
- [Fizgig RefMods](https://comfyui-wiki.com/en/news/2026-09-17-fizgig-v6-refmods), [H3 RefMods](https://comfyui-wiki.com/en/news/2026-09-07-minimax-h3-refmods)
- [MiniMax H3 Director](https://comfyui-wiki.com/en/news/2026-08-18-minimax-h3-director)
- [MiniMax H3 on RTX 5090 series](https://ai-muninn.com/en/blog/series/minimax-h3-on-rtx-5090)
- [H3 Reddit review round-up](https://www.virse.ai/blog/minimax-h3-reddit-review), [H3 vs LTX-2.5 side by side](https://note.com/ai_creative_log/n/na1cc9e9d7cd7?hl=en)
- [H3 GPU requirements by tier (Chinese)](https://www.ai-indeed.com/encyclopedia/29268.html)
- [H3 sound and voice prompting](https://runware.ai/docs/models/minimax-h3/guides/sound-and-voice)
- [LTX-2.5 custom-audio discussion](https://huggingface.co/Lightricks/LTX-2.5/discussions/44), [LTX-2.5 INT8 workflows](https://huggingface.co/javawock7618/comfy-ltx-2.x-workflows)
- [comfyui-wiki news log, Jul–Sep 2026](https://comfyui-wiki.com/en/news)
- stable-diffusion.cpp [README](https://github.com/leejet/stable-diffusion.cpp), [MiniMax-H3 doc](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/minimax_h3.md), [LTX-2 doc](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/ltx2.md)

Chinese short-drama production
- [2026 big-studio AI 漫剧 workflow (Sohu)](https://www.sohu.com/a/1044709605_121123989)
- [短剧导演台 V7 (Bilibili)](https://www.bilibili.com/video/BV1stYu6DE5j/), [H3 short-drama full pipeline, 绘影 (Bilibili)](https://www.bilibili.com/video/BV1s8Yu6JEwF/), [Ref2VA hybrid quality test (Bilibili)](https://www.bilibili.com/video/BV1fLuq6FEmF/), [script → 四宫格 storyboard → LTX (Bilibili)](https://www.bilibili.com/video/BV1TrXVB7Euy/)
- [H3 short drama search round-up (Bilibili)](https://www.bilibili.com/video/BV1gPb963EJb/)

Pricing and reference target
- [RunPod pricing](https://www.runpod.io/gpu-cloud/pricing), [2026 summary](https://diyai.io/ai-tools/hosting/runpod-pricing/)
- [creatorflow: AI influencers on Instagram](https://creatorflow.so/blog/ai-influencers-instagram/)
