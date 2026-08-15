import subprocess
eps = """GET /health
GET /v1/audio-catalog
GET /v1/audio-catalog/x/files
GET /v1/audio-downloads
GET /v1/audio-models
POST /v1/audio-models
GET /v1/audio-models/chatterbox
PUT /v1/audio-models/chatterbox/manifest
POST /v1/audio-models/chatterbox/voice-presets
POST /v1/audio-models/download
GET /v1/audio-voice-refs/x.wav
GET /v1/audio/models
POST /v1/audio/speech
POST /v1/audio/tasks/run
POST /v1/audio/transcriptions
GET /v1/audio/voices
GET /v1/auth/hf
POST /v1/auth/hf/verify
GET /v1/catalog
GET /v1/catalog/x/files
GET /v1/downloads
POST /v1/downloads/resume
POST /v1/generate
POST /v1/inputs
GET /v1/inputs/x.png
GET /v1/jobs
POST /v1/jobs
GET /v1/jobs/x
DELETE /v1/jobs/x
GET /v1/jobs/x/stream
GET /v1/llm-catalog
GET /v1/llm-catalog/x/files
GET /v1/llm-downloads
POST /v1/llm-downloads/resume
GET /v1/llm-models
POST /v1/llm-models
GET /v1/llm-models/x
POST /v1/llm-models/download
POST /v1/llm/chat/completions
POST /v1/llm/completions
POST /v1/llm/embeddings
GET /v1/llm/models
GET /v1/logs
GET /v1/models
POST /v1/models
GET /v1/models/x
POST /v1/models/download
GET /v1/outputs/x.png""".strip().split("\n")

missing = []
for line in eps:
    method, path = line.split(" ", 1)
    body = subprocess.run(
        ["curl", "-s", "-m", "5", "-X", method, "-H", "content-type: application/json", "-d", "{}",
         f"http://localhost:3999{path}"], capture_output=True, text=True).stdout
    if '"code":"NOT_FOUND"' in body:
        missing.append(f"{method} {path}")
print("routes checked:", len(eps))
print("MISSING:", missing if missing else "none - every sd-api path resolves")
