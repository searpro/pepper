#!/bin/sh
# claude-box.sh [claude args...] — Claude Code on the agent model of the home box's Pepper Pro.
#
# Pepper Pro serves Anthropic's Messages API at /v1/messages on its agent model (LLM_AGENT_MODEL, by
# default Qwen3.6-35B-A3B Q4_K_M with vision) and takes turns with the renders on the one 16 GB card:
# renders first, so a turn waits while any render is queued or running, and the model's processed
# conversation is saved before it is unloaded and restored after. Nothing to start or stop here.
#
# Only these sessions know about that: PEPPER_AGENT=local makes the pepper MCP bridge ask for notes on
# the GPU in job results, and the status line shows who holds the card. Claude Code on Anthropic's
# models is untouched. Web search goes through the box's SearXNG, since WebSearch is an Anthropic tool.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
HOST=${PEPPER_HOME_HOST:-lijin@lk-gpu-server}

# A worktree has no .env files of its own; they live in the main checkout.
MAIN=$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$ROOT/.git")")

# The hostname and token from the launchers' git-ignored .env files, as the MCP bridge reads them.
envval() {
  eval "v=\${$1:-}"
  [ -n "$v" ] && { echo "$v"; return 0; }
  for dir in "$ROOT" "$MAIN"; do
    for f in "$dir/deploy/home/.env" "$dir/deploy/runpod/.env" "$dir/deploy/vastai/.env" "$dir/deploy/kaggle/.env"; do
      [ -f "$f" ] && v=$(sed -n "s/^$1=//p" "$f" | head -n 1 | tr -d '"'"'") && [ -n "$v" ] && { echo "$v"; return 0; }
    done
  done
  return 0
}
HOSTNAME_=$(envval PEPPER_HOSTNAME)
URL=${PEPPER_URL:-https://${HOSTNAME_:-pepper.xltserver.com}}
TOKEN=$(envval PEPPER_API_TOKEN)

if ! curl -sf -o /dev/null -H "Authorization: Bearer $TOKEN" "$URL/v1/llm/gpu"; then
  echo "Pepper Pro at $URL is not answering /v1/llm/gpu (run: uv run deploy/home/launch.py up --product pro)." >&2
  exit 1
fi

MCP=$(printf '{"mcpServers":{"searxng":{"command":"node","args":["%s/searxng_mcp.mjs"],"env":{"SEARXNG_URL":"http://%s:8888"}},"pepper":{"command":"node","args":["%s/.claude/pepper-mcp.mjs"]}}}' \
  "$HERE" "${HOST#*@}" "$ROOT")
# What points this session at Pepper goes in a settings file passed with --settings, which outranks
# every project's settings: a folder whose .claude/settings*.json sets ANTHROPIC_BASE_URL (an older
# local setup, say) would otherwise beat the environment. A file rather than the argument, so the
# token is not on the command line; readable only by this user, and deleted when Claude Code exits.
SETTINGS=$(mktemp "${TMPDIR:-/tmp}/claude-box.XXXXXX")
trap 'rm -f "$SETTINGS"' EXIT INT TERM
chmod 600 "$SETTINGS"
URL="$URL" TOKEN="$TOKEN" STATUS="node $HERE/statusline.mjs" CTX="${AGENT_CTX:-98304}" node -e '
  const e = process.env;
  const env = {
    ANTHROPIC_BASE_URL: e.URL, ANTHROPIC_AUTH_TOKEN: e.TOKEN, ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: "agent", ANTHROPIC_DEFAULT_HAIKU_MODEL: "agent", ANTHROPIC_DEFAULT_SONNET_MODEL: "agent",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "agent", CLAUDE_CODE_SUBAGENT_MODEL: "agent",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0", CLAUDE_CODE_MAX_CONTEXT_TOKENS: e.CTX, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    API_TIMEOUT_MS: "3600000", PEPPER_URL: e.URL, PEPPER_API_TOKEN: e.TOKEN, PEPPER_AGENT: "local",
  };
  require("fs").writeFileSync(process.argv[1], JSON.stringify({ env, statusLine: { type: "command", command: e.STATUS } }));
' "$SETTINGS"

# A clean environment as well: Claude Code started from the desktop app passes on variables that change
# how a child `claude` behaves. Every model name maps to the agent model; Pepper rewrites it anyway.
# API_TIMEOUT_MS covers a turn queued behind renders (streamed turns get pings meanwhile).
env -i HOME="$HOME" PATH="$PATH" USER="$USER" LANG="${LANG:-en_US.UTF-8}" TERM="${TERM:-xterm-256color}" \
  ANTHROPIC_BASE_URL="$URL" ANTHROPIC_AUTH_TOKEN="$TOKEN" ANTHROPIC_API_KEY= \
  ANTHROPIC_MODEL=agent ANTHROPIC_DEFAULT_HAIKU_MODEL=agent ANTHROPIC_DEFAULT_SONNET_MODEL=agent ANTHROPIC_DEFAULT_OPUS_MODEL=agent \
  CLAUDE_CODE_ATTRIBUTION_HEADER=0 CLAUDE_CODE_MAX_CONTEXT_TOKENS=${AGENT_CTX:-98304} CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  API_TIMEOUT_MS=3600000 PEPPER_URL="$URL" PEPPER_API_TOKEN="$TOKEN" PEPPER_AGENT=local \
  claude --mcp-config "$MCP" --settings "$SETTINGS" --disallowedTools WebSearch "$@"
