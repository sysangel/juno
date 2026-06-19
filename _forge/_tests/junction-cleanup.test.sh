#!/usr/bin/env bash
# Integration test: PROVE the junction-safe worktree cleanup does NOT wipe main's
# node_modules. Run from anywhere. Exit 0 = safe, non-zero = HAZARD (do not trust).
set -u

REPO="C:/Users/Core/src/juno"
NM="$REPO/node_modules"
SLUG="_cleanuptest"
W="C:/Users/Core/src/juno-forge-$SLUG"
BR="forge/$SLUG"

count() { find "$1" -mindepth 1 2>/dev/null | wc -l | tr -d ' '; }

echo "== BEFORE =="
BEFORE=$(count "$NM")
echo "main node_modules files BEFORE: $BEFORE"

WIN_W="$(cygpath -w "$W")"
WIN_NM="$(cygpath -w "$NM")"

# --- pre-clean any stale leftovers from a prior run -------------------------
[ -d "$W/node_modules" ] && MSYS_NO_PATHCONV=1 cmd /c rmdir "$WIN_W\\node_modules" 2>/dev/null
git -C "$REPO" worktree remove --force "$W" 2>/dev/null
git -C "$REPO" branch -D "$BR" 2>/dev/null
git -C "$REPO" worktree prune 2>/dev/null

# --- create throwaway worktree + junction (exactly as the build agent does) --
echo "== SETUP: worktree + junction =="
git -C "$REPO" worktree add "$W" -b "$BR" main || { echo "FAIL: worktree add"; exit 2; }
MSYS_NO_PATHCONV=1 cmd /c mklink /J "$WIN_W\\node_modules" "$WIN_NM" || { echo "FAIL: mklink"; exit 2; }
echo "junction node_modules (via link) files: $(count "$W/node_modules")"

# --- THE JUNCTION-SAFE REMOVAL (the incantation under test) -----------------
echo "== REMOVAL (junction-safe) =="
# 1. remove ONLY the junction reparse point first — plain rmdir, NO /S, guarded.
if [ -d "$W/node_modules" ]; then
  MSYS_NO_PATHCONV=1 cmd /c rmdir "$WIN_W\\node_modules" || { echo "FAIL: rmdir junction"; exit 2; }
fi
# 2. now safe to remove the worktree (no junction left to follow). KEEP the branch.
git -C "$REPO" worktree remove --force "$W" || { echo "FAIL: worktree remove"; exit 2; }

# --- ASSERTIONS -------------------------------------------------------------
echo "== AFTER =="
AFTER=$(count "$NM")
echo "main node_modules files AFTER: $AFTER"
RC=0
if [ "$AFTER" -lt $((BEFORE - 5)) ]; then echo "HAZARD: node_modules dropped $BEFORE -> $AFTER"; RC=1; else echo "OK(a): node_modules intact ($BEFORE -> $AFTER)"; fi
if [ -d "$W" ]; then echo "FAIL(b): worktree dir still present"; RC=1; else echo "OK(b): worktree dir gone"; fi
if git -C "$REPO" show-ref --verify --quiet "refs/heads/$BR"; then echo "OK(c): branch $BR survived"; else echo "FAIL(c): branch $BR missing"; RC=1; fi

# --- cleanup the test branch ------------------------------------------------
git -C "$REPO" branch -D "$BR" 2>/dev/null && echo "cleaned up test branch $BR"
git -C "$REPO" worktree prune 2>/dev/null

echo "== RESULT: $([ $RC -eq 0 ] && echo PASS || echo FAIL) =="
exit $RC
