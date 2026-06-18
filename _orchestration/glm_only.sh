#!/usr/bin/env bash
# glm_only.sh — re-run ONLY the GLM 5.2 writer for a unit (Codex draft already exists).
# Usage: glm_only.sh <BRIEF_FILE> <OUT_DIR>
set -uo pipefail
BRIEF_FILE="$1"; OUT_DIR="$2"; mkdir -p "$OUT_DIR"
KEY="$(grep -E '^OPENROUTER_API_KEY=' C:/Users/Core/src/loopy-engine/.env | head -n1 | cut -d= -f2- | tr -d '\r"'"'"'')"
GLM_OUT="$OUT_DIR/draft_glm.md"
# Privacy = NO-TRAIN ONLY (data_collection:deny). Geographic/Western screen retired 2026-06-16,
# so no `only` allowlist; fallbacks enabled for reliability.
jq -n --rawfile p "$BRIEF_FILE" \
  '{model:"z-ai/glm-5.2",messages:[{role:"user",content:$p}],max_tokens:48000,temperature:0.2,
    provider:{data_collection:"deny",allow_fallbacks:true}}' > "$OUT_DIR/glm_req.json"
OK=0
for a in 1 2 3 4 5; do
  curl -sS --max-time 600 https://openrouter.ai/api/v1/chat/completions \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -H "HTTP-Referer: https://github.com/angelsystems/agent-loop" -H "X-Title: juno-rewrite-orchestration" \
    -d @"$OUT_DIR/glm_req.json" > "$OUT_DIR/glm_raw.json" 2>"$OUT_DIR/glm_curl.log"
  if jq -e '.choices[0].message.content' "$OUT_DIR/glm_raw.json" >/dev/null 2>&1; then
    jq -r '.choices[0].message.content' "$OUT_DIR/glm_raw.json" > "$GLM_OUT"
    echo "$(basename "$OUT_DIR"): GLM OK via $(jq -r '.provider // "?"' "$OUT_DIR/glm_raw.json") attempt $a, $(wc -c <"$GLM_OUT") bytes, $(grep -c '=== FILE:' "$GLM_OUT") files"
    OK=1; break
  fi
  echo "$(basename "$OUT_DIR"): GLM attempt $a -> $(jq -rc '.error.metadata.raw // .error.message // "empty-content"' "$OUT_DIR/glm_raw.json" 2>/dev/null); backoff"
  sleep 20
done
[ "$OK" -ne 1 ] && { echo "GLM_ERROR:"; cat "$OUT_DIR/glm_raw.json"; } > "$GLM_OUT"
