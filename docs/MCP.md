# Pepper Pro over MCP

Pepper Pro's MCP endpoint lets any MCP client generate images, video,
speech and music on your own GPU pod. Claude Code, claude.ai, Cursor and
another project's agent all work, the same way as a hosted service like
Higgsfield. Pick a model or let Pepper pick one, give a prompt and media by
URL, get a job id back, and collect a download link when it finishes.

## Connect

The endpoint is `https://<PEPPER_HOSTNAME>/mcp`. It accepts the API token
(`PEPPER_API_TOKEN`) in either of two ways:

- **A Bearer header**, for clients that can send headers:

  ```bash
  claude mcp add --transport http pepper-pro https://<PEPPER_HOSTNAME>/mcp \
    --header "Authorization: Bearer $PEPPER_API_TOKEN"
  ```

  or in a project's `.mcp.json`:

  ```json
  {
    "mcpServers": {
      "pepper-pro": {
        "type": "http",
        "url": "https://<PEPPER_HOSTNAME>/mcp",
        "headers": { "Authorization": "Bearer ${PEPPER_API_TOKEN}" }
      }
    }
  }
  ```

- **In the path**, `https://<PEPPER_HOSTNAME>/mcp/<token>`, for clients with
  no header field, such as a claude.ai custom connector. The token is redacted
  from every log line.

The server only answers while a pod is running:
`uv run deploy/runpod/launch.py up --product pro`. A pod stops itself after
30 idle minutes, and a running generation counts as activity.

## Tools

| Tool | What it does |
| --- | --- |
| `list_models` | Every model: what it takes (`prompt`, `image`, `end_image`, `reference_images`, `audio`, `audio_2`, `video`, `voice_reference`, `voice`, `lyrics`, each required or optional), duration range, aspect ratios, qualities, licence, whether it is installed, and measured seconds per output where it has been verified on a GPU |
| `generate_image` | Text to image, or an edit or try-on when `image` (and `reference_images`) are given |
| `generate_video` | Text or image to video: start and end frames, reference images for a consistent cast, audio to lip-sync or perform to, a driving video for motion transfer |
| `generate_audio` | Speech (`audio_type: "speech"`: a line in a cloned, preset or described voice) or music (`"music"`: style, lyrics, length) |
| `get_job` | Waits up to 50 s for one job (`id`) or several (`ids`), and returns their status and `download_url` |
| `list_jobs`, `cancel_job` | Recent jobs; stop one |
| `install_model` | Downloads a model's files. It is refused when the volume has no room |
| `add_input` | Uploads a file from base64 bytes, for a client with local files and no URL |
| `plan_project`, `render_shots`, `get_project` | Projects: scenes of shots, draft and final takes, long takes, retakes, and a cut |
| `analyze` | Beats, stems, Whisper transcription, a vision check of a take |
| `pro_status`, `get_logs` | Status: the GPU, the queue, installed models; and the logs |

Without `model`, Pepper uses the best installed model that takes every input
given, preferring models verified on a GPU. For example, reference images
choose H3 with references, and an image plus two voices choose two-person
InfiniteTalk.

## A video, end to end

1. `list_models` with `kind: "video"`, if you want to choose.
2. `generate_video`:

   ```json
   {
     "prompt": "A woman in a red coat walks along a seaside promenade toward the camera; waves, gulls.",
     "image": "https://example.com/start-frame.png",
     "duration": 8,
     "aspect_ratio": "9:16",
     "quality": "draft"
   }
   ```

   It returns at once with `model`, `quality` and the job (`id`, `status: "queued"`).
3. `get_job` with `ids: ["…"]`, repeated until `status` is `completed`. A
   5 s H3 draft takes about 8 minutes on a 32 GB card.
4. Fetch the finished job's `download_url`. It needs no token and is valid
   for 7 days, but outputs are deleted after 24 hours
   (`OUTPUT_RETENTION_MS`), so copy them out promptly.

Media inputs take a public URL, a `data:` URI, a previous job's
`output_name`, or an upload name from `add_input`. Use `quality: "draft"` to
try an idea, then `"final"` with the draft's `seed` to finish it.

Each model has a length limit (`duration` in `list_models`; H3 renders up to
15 s at once). A longer clip is a project shot: `render_shots` chains
segments into one long take.

## Without MCP

The tools wrap the HTTP API, so a program can call it directly with the
same Bearer token:

- `GET /v1/models?kind=video`
- `POST /v1/generate`: `{ "kind": "video", "prompt": …, "image": …, "duration": … }`.
  Answers `202 { model, quality, jobs: [...] }`.
- `GET /v1/jobs/:id`, or the server-sent events at `GET /v1/jobs/:id/stream`.
- `GET /v1/outputs/:name`.

`/docs` has the full API.
