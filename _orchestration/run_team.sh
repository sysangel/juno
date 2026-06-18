#!/usr/bin/env bash
# run_team.sh — fire two independent code writers in parallel for one work unit.
#   Writer A: GLM 5.2  via OpenRouter, routed ONLY through DeepInfra (Western, no-train) — privacy screen.
#   Writer B: Codex 5.5 via the codex CLI (gpt-5.5).
# Each writer's draft is written to disk; an Opus synthesizer (spawned separately) merges them.
#
# Usage: run_team.sh <BRIEF_FILE> <OUT_DIR>
set -uo pipefail

BRIEF_FILE="$1"
OUT_DIR="$2"
mkdir -p "$OUT_DIR"

ENV_FILE="C:/Users/Core/src/loopy-engine/.env"
OPENROUTER_API_KEY="$(grep -E '^OPENROUTER_API_KEY=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '\r"'"'"'' )"
if [ -z "${OPENROUTER_API_KEY:-}" ]; then echo "FATAL: no OPENROUTER_API_KEY in $ENV_FILE" >&2; exit 1; fi

GLM_OUT="$OUT_DIR/draft_glm.md"
CODEX_OUT="$OUT_DIR/draft_codex.md"
JUNO_DIR="C:/Users/Core/src/juno"

echo ">> launching Codex 5.5 (gpt-5.5) in background..."
( codex exec --skip-git-repo-check -C "$JUNO_DIR" -s read-only -m gpt-5.5 \
    -o "$CODEX_OUT" "$(cat "$BRIEF_FILE")" ) >"$OUT_DIR/codex.log" 2>&1 &
CODEX_PID=$!

# GLM 5.2 routed ONLY through Western providers (DeepInfra/Cloudflare), data_collection:deny
# enforced so OpenRouter still excludes any provider that trains on inputs. Fallback + retry
# absorb the shared-pool 429s seen on a single provider.
echo ">> calling GLM 5.2 (z-ai/glm-5.2 via Western allowlist, data_collection:deny)..."
# Privacy policy = NO-TRAIN ONLY (account-side + data_collection:deny belt-and-suspenders).
# Geographic/Western-only screen retired 2026-06-16 — any no-train provider is fine, so we
# drop the `only` allowlist and enable fallbacks (DeepInfra/Z.AI/Novita) for reliability.
# GLM 5.2 is a REASONING model: max_tokens must cover the reasoning trace + answer or content is null.
jq -n --rawfile p "$BRIEF_FILE" \
  '{model:"z-ai/glm-5.2",
    messages:[{role:"user",content:$p}],
    max_tokens:48000,
    temperature:0.2,
    provider:{data_collection:"deny",allow_fallbacks:true}}' \
  > "$OUT_DIR/glm_req.json"

GLM_OK=0
for attempt in 1 2 3 4 5; do
  curl -sS --max-time 600 https://openrouter.ai/api/v1/chat/completions \
    -H "Authorization: Bearer $OPENROUTER_API_KEY" \
    -H "Content-Type: application/json" \
    -H "HTTP-Referer: https://github.com/angelsystems/agent-loop" \
    -H "X-Title: juno-rewrite-orchestration" \
    -d @"$OUT_DIR/glm_req.json" > "$OUT_DIR/glm_raw.json" 2>"$OUT_DIR/glm_curl.log"
  if jq -e '.choices[0].message.content' "$OUT_DIR/glm_raw.json" >/dev/null 2>&1; then
    jq -r '.choices[0].message.content' "$OUT_DIR/glm_raw.json" > "$GLM_OUT"
    echo ">> GLM provider: $(jq -r '.provider // "?"' "$OUT_DIR/glm_raw.json") (attempt $attempt)"
    GLM_OK=1; break
  fi
  echo ">> GLM attempt $attempt failed: $(jq -rc '.error.metadata.raw // .error.message // "empty-content"' "$OUT_DIR/glm_raw.json" 2>/dev/null) — backing off..."
  sleep 20
done
if [ "$GLM_OK" -ne 1 ]; then
  { echo "GLM_ERROR — last raw response:"; cat "$OUT_DIR/glm_raw.json"; } > "$GLM_OUT"
fi

echo ">> waiting for Codex..."
wait "$CODEX_PID"; CODEX_RC=$?

GLM_BYTES=$(wc -c < "$GLM_OUT" 2>/dev/null || echo 0)
CODEX_BYTES=$(wc -c < "$CODEX_OUT" 2>/dev/null || echo 0)
echo "============================================"
echo "GLM   -> $GLM_OUT   (${GLM_BYTES} bytes)"
echo "CODEX -> $CODEX_OUT (${CODEX_BYTES} bytes, rc=$CODEX_RC)"
echo "============================================"
if [ "$GLM_OK" -eq 1 ] && [ "$GLM_BYTES" -gt 50 ] && [ "$CODEX_BYTES" -gt 50 ] && [ "$CODEX_RC" -eq 0 ]; then
  echo "TEAM_OK"
else
  echo "TEAM_DEGRADED (glm_ok=$GLM_OK glm_bytes=$GLM_BYTES codex_bytes=$CODEX_BYTES codex_rc=$CODEX_RC)"
fi
