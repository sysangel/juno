# SEAMS — Wave 4 Unit 2: nested subagent render on claude-cli

**Status:** PINNED FROM LIVE CAPTURE (2026-06-17). Gate baseline: `cd C:/Users/Core/src/juno && npx tsc --noEmit && npx vitest run` → tsc 0, **vitest 307/307**.
**Capture (ground truth):** `_orchestration/wave4-unit2-capture/capture-parallel-01.ndjson` (57 records; a real `claude -p` run where the parent spawned TWO subagents in parallel via the native `Agent` tool, each child running its own `Bash`).

This doc OVERRIDES SEAMS_W4.md §5 wherever the capture contradicts its assumptions. The locked DECISIONS (Option A drop child text; committed-only nesting; the stopReason invariant; additive-only `parentToolUseId?` on the frozen seam; `contracts.ts` untouched) all stand — only the *implementation surface* shrank.

---

## 1. Capture ground truth (what the real stream does)

Two custom agents (`file-counter`, `word-finder`) spawned in parallel. Key facts, each verified against the NDJSON:

1. **`parent_tool_use_id` is a TOP-LEVEL field on the record wrapper** (sibling of `type`/`message`/`event`), NOT inside `.message`. It is `null` for the parent turn and a **string** for child (subagent) turns. The string value **equals the parent's `Agent` tool_use id**. → This is the nesting key: `child.parent_tool_use_id === parentAgentToolCall.toolCallId`. Verified: child assistant `parent_tool_use_id = toolu_01RAUgw19iSBoqRcANjMaPGy`; parent `Agent` tool_use `id = toolu_01RAUgw19iSBoqRcANjMaPGy`. Exact match.

2. **Children NEVER stream token deltas.** All 32 `stream_event` records carry `parent_tool_use_id: null` (the parent's partial messages only). Subagent internal turns surface ONLY as **complete block-mode `assistant`/`user` message records** (plus `system` lifecycle events). → The `emitFromStreamEvent` `Map<number,ToolAccumulator>` is NEVER populated by children. **The delta-Map partition SEAMS_W4.md §5 called "mandatory" is unnecessary and is NOT being built.**

3. **Child assistant messages carry `message.stop_reason: null`.** Only the parent's `message_delta` events carry a stop_reason. The parent emits TWO message_deltas in one turn: `tool_use` (after spawning the Agents) → then `end_turn`. Terminal `result.stop_reason = end_turn`. → Children structurally cannot move the terminal stopReason; the re-spawn interlock is safe as long as the child path does not synthesize a `tool_use` stop.

4. **Child tool_use blocks carry a COMPLETE `input` object** (delivered inside the complete child assistant message — there is no `input_json_delta` for children). → The child emitter needs NO numeric-index accumulator; it emits a `tool-call` keyed by the globally-unique `block.id`.

5. **Child tool_results** arrive as `user` records with `parent_tool_use_id` set and `message.content[].tool_use_id` = the child's own tool id (e.g. the child `Bash` id). The parent's `Agent` tool_results arrive as `user` records with `parent_tool_use_id: null` and `tool_use_id` = the `Agent` id.

### Canonical record shapes (verbatim shape, values illustrative)
```jsonc
// CHILD assistant (the subagent's tool call):
{ "type":"assistant", "parent_tool_use_id":"toolu_AGENT", "subagent_type":"file-counter",
  "task_description":"Count lines in data1.txt",
  "message": { "role":"assistant", "stop_reason": null,
               "content": [ { "type":"tool_use", "id":"toolu_CHILD", "name":"Bash", "input": { "command":"wc -l data1.txt" } } ] } }

// CHILD tool_result:
{ "type":"user", "parent_tool_use_id":"toolu_AGENT",
  "message": { "content": [ { "type":"tool_result", "tool_use_id":"toolu_CHILD", "content":"8 data1.txt", "is_error": false } ] } }

// PARENT Agent tool_use (top-level turn):
{ "type":"assistant", "parent_tool_use_id": null,
  "message": { "stop_reason": null, "content": [ { "type":"tool_use", "id":"toolu_AGENT", "name":"Agent" } ] } }
```

### Ordered interleave (abridged)
```
parent: text("I'll delegate…")  → Agent#J (file-counter)  → Agent#Q (word-finder)   [parent stream + blocks]
child J: user(prompt)  → assistant(tool_use Bash#D)  → user(tool_result for#D)        [block mode, ptui=Agent#J]
child Q: user(prompt)  → assistant(tool_use Bash#A)  → user(tool_result for#A)        [block mode, ptui=Agent#Q]
parent: user(tool_result for#Agent#Q)  → user(tool_result for#Agent#J)                [ptui=null]
parent: text("file-counter: 8, word-finder: 5")  → message_delta(end_turn) → result   [parent]
```
Render target:
```
assistant
  text1
  ▸ Agent (file-counter)         ← parent card, top level
      └ Bash  [result] 8 …       ← child card, nested (indent + dim)
  ▸ Agent (word-finder)
      └ Bash  [result] 5 …
  text2 (summary)
```

---

## 2. Frozen-seam changes (additive-only; `contracts.ts` UNTOUCHED)

### `src/core/events.ts`
- Add optional `parentToolUseId?: string` to the **`tool-call`** AgentEvent variant ONLY:
  ```ts
  | { type: 'tool-call'; id: string; toolCallId: string; name: string; args: unknown; parentToolUseId?: string }
  ```
- Thread it in `eventToAction`'s `tool-call` case (the only line that changes):
  ```ts
  case 'tool-call':
    return { t: 'tool-call', toolCallId: e.toolCallId, name: e.name, args: e.args, parentToolUseId: e.parentToolUseId };
  ```
  (`exactOptionalPropertyTypes` is OFF → assigning `string | undefined` to `parentToolUseId?: string` is fine; `eventToAction` stays exhaustive — no new variant.)

### `src/core/reducer.ts`
- `Action` `tool-call` variant: add `parentToolUseId?: string`.
- `ToolState`: add `parentToolUseId?: string` (the linkage lives here; `Block` is UNCHANGED — `Message.tsx` reads `toolSnapshot[id].parentToolUseId`).
- `tool-call` reducer case: file it onto the new ToolState (conditionally, to avoid writing `undefined` keys):
  ```ts
  [action.toolCallId]: {
    status: 'pending', name: action.name, args: action.args,
    ...(action.parentToolUseId !== undefined ? { parentToolUseId: action.parentToolUseId } : {}),
  },
  ```
- `snapshotTools`: NO change — its `{ ...tool }` spread already carries `parentToolUseId` into `toolSnapshot`.

These are additive/optional everywhere; with the field unset (every existing caller) behavior is byte-identical → all 307 existing tests stay green.

---

## 3. Adapter change — `src/providers/claudeCliClient.ts`

Three drop guards exist today at the `assistant` (:154), `stream_event` (:173), and `user` (:193) cases. Per the capture:

### (a) `assistant` case — un-drop CHILD tool cards, drop child text (Option A)
Replace the current early `break` on non-null `parent_tool_use_id` with a dedicated child path that runs BEFORE stop-mining and BEFORE the `sawStreamEvent` short-circuit:
```ts
case 'assistant': {
  const message = asObject(evt.message);
  if (message === undefined) break;
  const parentToolUseId = stringField(evt, 'parent_tool_use_id');
  if (parentToolUseId !== undefined) {
    // CHILD (subagent) message. Render its TOOL cards nested under the parent
    // (stamped parentToolUseId); DROP child text/reasoning (Option A — the
    // parent's summary stays authoritative). Children carry stop_reason:null
    // (capture-parallel-01) and are NEVER in the delta stream, so we MUST emit
    // here (block mode is their sole source) and MUST return before the
    // stop-mining + sawStreamEvent guard so a child never touches `stopReason`.
    yield* emitChildToolCalls(message, input, parentToolUseId);
    break;
  }
  // ---- existing parent path unchanged below ----
  const stop = stringField(message, 'stop_reason');
  if (stop !== undefined && stop !== null) stopReason = stop;
  if (sawStreamEvent) break;
  yield* emitFromContentBlocks(message, input, toolCalls);
  break;
}
```
New helper (no accumulator, no index, no shared map):
```ts
function* emitChildToolCalls(message: JsonObject, input: TurnInput, parentToolUseId: string): Generator<AgentEvent> {
  const content = message.content;
  if (!Array.isArray(content)) return;
  for (const rawBlock of content) {
    const block = asObject(rawBlock);
    if (block === undefined) continue;
    if (stringField(block, 'type') !== 'tool_use') continue; // Option A: drop child text/thinking
    const id = stringField(block, 'id');
    const name = stringField(block, 'name');
    if (id !== undefined && name !== undefined) {
      yield { type: 'tool-call', id: input.id, toolCallId: id, name, args: asObject(block.input) ?? {}, parentToolUseId };
    }
  }
}
```

### (b) `stream_event` case — LEAVE the child guard intact
Keep dropping non-null-`parent_tool_use_id` stream events. Add a comment citing the capture:
```ts
// Children NEVER stream deltas (capture-parallel-01: every stream_event carries
// parent_tool_use_id:null; subagent internal turns surface only as complete
// block-mode assistant/user messages). This guard is retained as defense-in-depth;
// un-dropping it would require partitioning the index accumulator and is unnecessary.
if (evt.parent_tool_use_id !== null && evt.parent_tool_use_id !== undefined) break;
```
(No functional change here — purely the comment. Test `tests/claudeCliClient.test.ts:496` still passes.)

### (c) `user` case — un-drop CHILD tool_result echoes
Remove the `parent_tool_use_id` guard so a child's `tool_result` completes its nested card. `emitFromUserEcho` keys by the globally-unique `tool_use_id`, so child and parent results route correctly with no change to that function:
```ts
case 'user': {
  // tool_result echoes — parent AND child (subagent) results complete their cards.
  // Child results key by the same globally-unique tool_use_id, so emitFromUserEcho
  // routes them with no change. (Was dropped pre-Unit-2.)
  yield* emitFromUserEcho(evt);
  break;
}
```

**No other adapter change.** `cliStopReason`, `emitFromStreamEvent`, `emitFromContentBlocks`, the `toolCalls` Map, and the block-mode index counter are ALL untouched.

---

## 4. Renderer changes

### `src/ui/ToolCallCard.tsx`
Add an additive optional `nested?: boolean` prop (separate from `depth`, which is COLOR). When true, indent (`marginLeft`) and use a dimmer border token. Default false → byte-identical to today.

### `src/ui/Message.tsx`
Restructure the committed render so child tool cards nest under their parent. Committed-only (reads `msg.toolSnapshot`; live tool blocks still render as bare `[tool {id}]` — undefined snapshot — exactly as today). Algorithm:
```ts
const snap = msg.toolSnapshot;
const parentOf = (toolCallId: string): string | undefined => snap?.[toolCallId]?.parentToolUseId;
// group child tool blocks by their parent's toolCallId:
const childrenByParent = new Map<string, Block[]>();
for (const b of msg.blocks) {
  if (b.kind === 'tool') {
    const p = parentOf(b.toolCallId);
    if (p !== undefined) (childrenByParent.get(p) ?? childrenByParent.set(p, []).get(p)!).push(b);
  }
}
// render in block order; skip children (rendered under their parent); after each
// parent/standalone tool card, render its children with nested:
//   - text block → render text
//   - tool block whose parentOf(...) is set → skip (already nested)
//   - tool block (parent/standalone) → render card, then its children nested
// Fallback: a child whose parent block is absent renders at top level (never dropped).
```
Pass `nested` through to `ToolCallCard` for the grouped children.

---

## 5. Test plan (deterministic — fakes; the gate forbids live subprocess)

Reuse the existing `makeSpawn`/`drain` harness in `tests/claudeCliClient.test.ts`. Add a scripted **interleaved parent+child** fixture mirroring the capture (parent `Agent` tool_use via block + the child assistant `Bash` tool_use with `parent_tool_use_id` set + the child `tool_result`).

REQUIRED assertions:
1. **Child tool-call carries `parentToolUseId`** = the parent `Agent` id; parent's own tool-call has it `undefined`.
2. **stopReason INVARIANT (the single most important):** for the interleaved fixture (children bearing tool_use), `events.at(-1)` is `{ type:'assistant-done', id:'turn-1', stopReason:'end' }` — NEVER `'tool_use'`. Proves no re-spawn loop.
3. **Option A:** a child assistant message that ALSO contains a `text` block emits NO `text-delta` for that child text (parent answer uncorrupted).
4. **Child tool_result completes the card:** a child `tool_result` echo now emits a `tool-status` keyed by the child tool id. → **UPDATE the existing test `tests/claudeCliClient.test.ts:593`** ("ignores subagent tool_result echoes") to assert the result is now SURFACED (this is the one intentional behavior flip). Keep `:350` and `:496` (child text + child stream deltas still dropped).
5. **No cross-contamination / no double tool-call:** exactly one `tool-call` per distinct tool id; child args not merged into parent args.

Reducer test (`tests/reducer.test.ts`): a `tool-call` with `parentToolUseId` files it onto `ToolState`; `assistant-done` carries it into `toolSnapshot`.

Renderer test (`tests/components.test.tsx` or a new `tests/nestedRender.test.tsx`): a committed `Msg` with a parent tool + a child tool (`toolSnapshot[child].parentToolUseId === parentId`) renders the child indented under the parent (assert via the rendered frame / `nested` prop path). Note a fake committed test passes even if a LIVE stream still shows `[tool]` — so the LIVE verify (below) is the real proof, not this test.

Reconcile the test-count delta intentionally (one test updated at :593; several added).

---

## 6. Definition of done
tsc-0 + vitest green INCLUDING the stopReason invariant test; `contracts.ts` untouched; only additive `parentToolUseId?` on events.ts + reducer.ts. THEN (conductor, outside the gate): the MANDATORY live verify — replay `capture-parallel-01.ndjson` through the real adapter AND run a fresh live multi-subagent `claude -p`; confirm nested child cards render, no arg cross-contamination, no double-render, no re-execution, parent summary still lands.
