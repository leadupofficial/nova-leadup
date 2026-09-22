#!/usr/bin/env bash
# Runs the live voice-model matrix against each model in turn.
#
# The model under test is chosen by the API's own `ANTHROPIC_MODEL`, so the only
# honest way to compare them is to restart the API with a different value and
# re-observe — which is what this does. Exactly one API instance is alive at a
# time, because the API starts the retention sweep, the recording reaper and the
# follow-up engine on boot and two instances would double-run them.
#
# Usage: bash services/api/scripts/run-voice-model-matrix.sh <model> [model...]
set -u

REPO="/Volumes/External/github-projects/NOVA-Leadup"
API_DIR="$REPO/services/api"
BASE="http://127.0.0.1:3001"
OUT_DIR="${OUT_DIR:-/tmp/nova-model-matrix}"

mkdir -p "$OUT_DIR"

# The running command line is
#   node --require .../tsx/dist/preflight.cjs --import .../loader.mjs src/server.ts
# so a pattern containing `tsx src/server.ts` never matches it and the old server
# keeps the port. Matching `src/server.ts` is what actually kills it — the first
# version of this script silently measured the PREVIOUS model for two runs because
# the new process died with EADDRINUSE and the probe talked to the old one.
kill_api() {
  pkill -f "src/server.ts" 2>/dev/null
  for _ in $(seq 1 30); do
    pgrep -f "src/server.ts" >/dev/null || break
    sleep 0.5
  done
  if pgrep -f "src/server.ts" >/dev/null; then
    echo "### WARNING: an API process survived kill_api; the next run would measure the wrong model" >&2
    pkill -9 -f "src/server.ts" 2>/dev/null
    sleep 1
  fi
}

for MODEL in "$@"; do
  echo "=============================================================="
  echo "### starting API with ANTHROPIC_VOICE_MODEL=$MODEL (max output tokens: ${LLM_MAX_OUTPUT_TOKENS:-default})"
  kill_api
  LOG="$OUT_DIR/api-$MODEL.log"
  # `ANTHROPIC_VOICE_MODEL` is what `/voice/chat` actually resolves, so setting only
  # `ANTHROPIC_MODEL` measures nothing about the spoken path once the typed and
  # spoken tiers are split — the probe would silently report the *configured voice
  # model* for every candidate. Both are set so the label, the request and the
  # probe's own model-mismatch guard all agree.
  ( cd "$API_DIR" && ANTHROPIC_MODEL="$MODEL" ANTHROPIC_VOICE_MODEL="$MODEL" \
      LLM_MAX_OUTPUT_TOKENS="${LLM_MAX_OUTPUT_TOKENS:-}" ./node_modules/.bin/tsx src/server.ts ) >"$LOG" 2>&1 &
  SERVER_PID=$!

  ok=0
  for _ in $(seq 1 40); do
    code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$BASE/health" || true)
    if [ "$code" = "200" ]; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" != "1" ]; then
    echo "### API did not come up for $MODEL — see $LOG"
    tail -20 "$LOG"
    continue
  fi

  SUFFIX="${PROBE_SUFFIX:-}"
  PROBE_LABEL="$MODEL" PROBE_OUT="$OUT_DIR/matrix-$MODEL$SUFFIX.json" \
    NOVA_API_BASE="$BASE" node "$REPO/services/api/scripts/probe-voice-model-matrix.mjs"
  echo "### model $MODEL exit=$? log=$LOG"
done

kill_api
echo "### all models probed; artifacts in $OUT_DIR"
