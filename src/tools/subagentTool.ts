// src/tools/subagentTool.ts
// Wave 3 — the portable `spawn_subagent` tool for the raw-API backends. (On the
// claude-cli backend the CLI runs sub-agents natively and juno never executes
// tools, so this tool's run() is only ever reached on a raw-API turn.)
//
// Wave 7 — juno-side subagent ORCHESTRATOR: as the nested turn streams, every
// child TOOL event (tool-call / tool-call-delta / tool-status) is re-emitted into
// the PARENT event stream via `ctx.emit`, stamped with `parentToolUseId` = this
// call's tool-use id (`ctx.toolCallId`) and a namespaced child id. The reducer
// then nests the child's tool cards under this call, so nested rendering works
// identically to the claude-cli native `parent_tool_use_id` path — on EVERY child
// provider (raw-API or codex), including cross-provider children. Child text /
// thinking stays OUT of the parent transcript (it only feeds the returned
// summary), matching the claude-cli path.
//
// It runs a FRESH, isolated nested turn via runTurn and returns a final summary
// string — a clean fresh-context worker. Isolation/safety:
//   - own AbortController; parent-abort cascades to the child (one-way), but the
//     child finishing never aborts the parent.
//   - fresh PermissionRegistry; the SHARED policy (remembered allow-patterns
//     still apply). There is no UI to resolve a nested prompt, so a nested
//     `prompt` decision resolves to 'deny' — sub-agents are read-only-safe by
//     default unless the user has a remembered always-allow pattern.
//   - DEPTH 1: the child toolset is the parent's base tools, which structurally
//     EXCLUDE spawn_subagent — a sub-agent cannot spawn a sub-agent.
//
// A module-level factory (createSubagentTool) — NO change to the frozen ToolCtx /
// Tool contract; everything it needs is closed over here.
import type {
  ModelClient,
  Tool,
  ToolCtx,
  ToolResult,
  ToolSpec,
} from '../core/contracts';
import type { AgentEvent } from '../core/events';
import type { Action } from '../core/reducer';
import { SUBAGENT_ABORTED } from '../core/abort';
import { createPermissionRegistry } from '../agent/eventBus';
import { runTurn } from '../agent/turnRunner';
import { createToolExecutor } from '../tools/executor';
import { createHookDispatcher } from '../tools/hookDispatcher';
import type { PermissionPolicy } from '../core/contracts';
import type { ModelCatalog, ModelEntry } from '../services/catalog';
import type { AgentDefinition } from '../services/agents';
import type { HooksSettings } from '../services/config';
import type { BackgroundAgentRunner } from '../services/backgroundAgents';

export interface SubagentDeps {
  /** Build a ModelClient for a catalog entry (same factory App/cli use). The optional
   * second arg (Wave 13 retry-ui transport-retry observer) is accepted for signature
   * parity with the parent factory, but subagents NEVER pass it — a child's internal
   * transport retries are intentionally NOT surfaced on the parent status line. */
  readonly createClient: (
    entry: ModelEntry,
    onRetry?: (attempt: number, max: number, delayMs: number) => void,
  ) => ModelClient;
  readonly catalog: ModelCatalog;
  /** SHARED permission policy (remembered patterns persist into sub-agents). */
  readonly policy: PermissionPolicy;
  /** The tools a sub-agent inherits by default (parent base, MUST NOT include spawn). */
  readonly childTools: ReadonlyArray<Tool>;
  /** Default model id/alias when neither the call nor the agent def specifies one. */
  readonly defaultModel?: string;
  /** Named agent definitions (from .claude/agents/), keyed by name. */
  readonly agents?: Record<string, AgentDefinition>;
  /**
   * The NON-BLOCKING background runner (Wave 13). When present AND this call has a
   * real tool-use id (`ctx.toolCallId`), run() hands the resolved spawn off to the
   * runner and returns a handle SYNCHRONOUSLY — the parent turn is never pinned on
   * the child. Absent (or a hand-built test ToolCtx with no `toolCallId`) ⇒ run()
   * degrades to the original blocking path that awaits the child's whole turn.
   */
  readonly runner?: BackgroundAgentRunner;
  /**
   * Config-driven tool-call hooks (config.json `hooks` block). For gate PARITY, the
   * sub-agent applies the PreToolUse groups too (it already shares the parent's
   * policy) — a hook that denies a tool for the parent denies it for a sub-agent as
   * well. PostToolUse (reminder-append) is deliberately NOT applied to sub-agent
   * calls: a sub-agent returns only a summary, so appending model-facing reminders
   * to its internal tool results has no consumer. Absent => no hook gate.
   */
  readonly hooks?: HooksSettings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The `spawn_subagent` tool spec — the SINGLE source of truth for the tool's
 * name + JSON-Schema input shape. Exported so the codex spawn bridge (which offers
 * the SAME tool to a codex parent over MCP) advertises an identical schema. */
export const spawnSubagentSpec: ToolSpec = {
  name: 'spawn_subagent',
  description:
    'Delegate a self-contained task to a fresh, isolated sub-agent. It works in a NEW context (it does NOT see this conversation) and returns ONLY a final summary. Put everything it needs in `task`. Sub-agents cannot spawn further sub-agents.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      task: {
        type: 'string',
        description: 'The complete, self-contained task. Include all context the sub-agent needs.',
      },
      agent: {
        type: 'string',
        description: 'Optional named agent definition (from .claude/agents/) to use.',
      },
      model: {
        type: 'string',
        description: 'Optional model id/alias for the sub-agent; defaults to the configured default.',
      },
    },
    required: ['task'],
  },
};

// Deterministic ids (no Date.now / Math.random — keeps tests reproducible).
let nestedTurnCounter = 0;
function nestedTurnId(): string {
  nestedTurnCounter += 1;
  return `subagent-turn-${nestedTurnCounter}`;
}

/** Resolve the child toolset: a per-definition allow-list (intersected with the
 * inherited base) or the full base. spawn_subagent is always stripped (depth 1). */
function selectChildTools(
  base: ReadonlyArray<Tool>,
  allow: ReadonlyArray<string> | undefined,
): Tool[] {
  const inherited = base.filter((tool) => tool.name !== 'spawn_subagent');
  if (allow === undefined) {
    return inherited;
  }
  const wanted = new Set(allow);
  return inherited.filter((tool) => wanted.has(tool.name));
}

/** Build the portable `spawn_subagent` tool over its deps. */
export function createSubagentTool(deps: SubagentDeps): Tool {
  return {
    name: 'spawn_subagent',
    risk: 'risky', // spawning hits the permission gate in the PARENT turn.
    spec: spawnSubagentSpec,
    async run(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) {
        return { ok: false, error: 'invalid args' };
      }
      const task = stringProp(args, 'task');
      if (task === undefined) {
        return { ok: false, error: 'invalid args' };
      }
      const agentName = stringProp(args, 'agent');
      const modelArg = stringProp(args, 'model');

      const agentDef = agentName !== undefined ? deps.agents?.[agentName] : undefined;
      if (agentName !== undefined && agentDef === undefined) {
        const known = Object.keys(deps.agents ?? {}).join(', ');
        return { ok: false, error: `unknown agent: ${agentName}. Available: ${known || '(none)'}` };
      }

      const modelId = modelArg ?? agentDef?.model ?? deps.defaultModel;
      const entry = modelId !== undefined ? deps.catalog.resolve(modelId) : deps.catalog.default();
      if (entry === undefined) {
        return { ok: false, error: `unknown model: ${modelId ?? '(default)'}` };
      }

      const childTools = selectChildTools(deps.childTools, agentDef?.tools);

      // The agent-definition system prompt (empty/absent ⇒ none), computed once and
      // shared by BOTH the background handoff and the blocking fallback below.
      const systemPrompt =
        agentDef?.prompt !== undefined && agentDef.prompt.length > 0 ? agentDef.prompt : undefined;

      // --- NON-BLOCKING background path (Wave 13) ---------------------------
      // With a real tool-use id (the spawn card) AND a runner, hand the RESOLVED
      // spawn (entry captured NOW — the {provider, model} pin) to the runner and
      // return a handle SYNCHRONOUSLY. The runner kicks the child on a detached
      // loop; the parent turn settles to idle right after spawning, killing the
      // spinner. Fallback to the blocking path when either is missing (hand-built
      // test ToolCtx with no toolCallId, or a build with no runner wired).
      if (ctx.toolCallId !== undefined && deps.runner !== undefined) {
        const { taskId } = deps.runner.spawn({
          spawnCardId: ctx.toolCallId,
          task,
          entry,
          ...(agentDef !== undefined ? { agentDef } : {}),
          childTools,
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        });
        return {
          ok: true,
          data: {
            taskId,
            status: 'spawned',
            model: entry.id,
            provider: entry.provider,
            ...(agentName !== undefined ? { agent: agentName } : {}),
          },
          promptText: `Background agent ${taskId} started on ${entry.id}. It runs independently; you'll be notified on completion. Continue or end your turn.`,
        };
      }

      // --- BLOCKING fallback (test ToolCtx / no runner) --------------------
      // --- isolation -------------------------------------------------------
      const childRegistry = createPermissionRegistry();
      const childController = new AbortController();
      if (ctx.signal.aborted) {
        childController.abort();
      }
      const onParentAbort = (): void => childController.abort();
      ctx.signal.addEventListener('abort', onParentAbort);

      // --- orchestrator: surface child TOOL activity into the PARENT stream ----
      // The spawning tool-use id (this call's id). Every child tool card is nested
      // under it via `parentToolUseId`, so nested rendering (Message.tsx grouping +
      // SubagentStatusRow selectors) works IDENTICALLY to the claude-cli native
      // `parent_tool_use_id` path — for EVERY child provider (raw-API or codex),
      // making cross-provider children render too. Absent id (hand-built ToolCtx in
      // tests) → degrade to the old summary-only behaviour (no surfacing).
      const parentToolUseId = ctx.toolCallId;
      // Namespace child tool-call ids under the parent so two subagents' children
      // (or a child id that collides with a live parent id) never clash in the
      // parent's single `state.tools` map. Applied consistently to tool-call /
      // tool-call-delta / tool-status AND to any inner parent id the child carried,
      // so a child's own nesting is preserved beneath our card. The renderer clamps
      // absolute depth via MAX_NEST_DEPTH; no depth counting is needed here.
      const ns = (childId: string): string => `${parentToolUseId}::${childId}`;

      // Child text/thinking is deliberately NOT spliced into the parent live turn
      // (matches the claude-cli path — child prose stays in the summary, out of the
      // parent transcript). Only tool-call / tool-call-delta / tool-status are
      // surfaced, as nested cards. Permission events stay internal (the child's
      // executor auto-denies interactive prompts; re-emitting them would hijack the
      // PARENT permission overlay).
      const surfaceChildEvent = (action: Action): void => {
        if (parentToolUseId === undefined) return;
        let event: AgentEvent | undefined;
        switch (action.t) {
          case 'tool-call':
            event = {
              type: 'tool-call',
              id: parentToolUseId,
              toolCallId: ns(action.toolCallId),
              name: action.name,
              args: action.args,
              // Preserve a child's OWN nesting (a grandchild) by namespacing its
              // parent too; a top-level child (no parent) hangs off our card.
              parentToolUseId:
                action.parentToolUseId !== undefined
                  ? ns(action.parentToolUseId)
                  : parentToolUseId,
            };
            break;
          case 'tool-call-delta':
            event = {
              type: 'tool-call-delta',
              toolCallId: ns(action.toolCallId),
              argsDelta: action.argsDelta,
            };
            break;
          case 'tool-status':
            event = {
              type: 'tool-status',
              toolCallId: ns(action.toolCallId),
              status: action.status,
              ...(action.result !== undefined ? { result: action.result } : {}),
              ...(action.error !== undefined ? { error: action.error } : {}),
            };
            break;
          case 'usage':
            // Bubble the child's token spend to the PARENT so it isn't silently
            // dropped (codexSpawnBridge's "silent token spend"). Stamp parentToolUseId
            // (= this spawn call's id) so the reducer folds it into the cost meter
            // ONLY — never into the parent's context-window occupancy. Child
            // contextTokens are deliberately NOT forwarded (meaningless for the parent
            // window); the parentToolUseId guard is the real protection.
            event = {
              type: 'usage',
              tokensIn: action.tokensIn,
              tokensOut: action.tokensOut,
              parentToolUseId,
            };
            break;
          default:
            break;
        }
        if (event !== undefined) ctx.emit(event);
      };

      // --- summary accumulator (per assistant turn; last completed wins) ----
      let currentText = '';
      let finalText = '';
      let errorMessage: string | null = null;
      const dispatch = (action: Action): void => {
        surfaceChildEvent(action);
        switch (action.t) {
          case 'assistant-start':
            currentText = '';
            break;
          case 'text-delta':
            currentText += action.delta;
            break;
          case 'assistant-done':
            finalText = currentText;
            break;
          case 'error':
            errorMessage = action.message;
            break;
          default:
            break;
        }
      };

      // Gate parity: build a PreToolUse-ONLY dispatcher over the CHILD signal so a
      // hook that blocks a tool for the parent blocks it for a sub-agent too. Only
      // built when PreToolUse groups exist (else the nested executor stays
      // hooks-less). PostToolUse is intentionally omitted (sub-agent tool results
      // reach no model as re-entry content — only its final summary is returned).
      const childHooks =
        deps.hooks?.PreToolUse !== undefined && deps.hooks.PreToolUse.length > 0
          ? createHookDispatcher(
              { PreToolUse: deps.hooks.PreToolUse },
              { signal: childController.signal },
            )
          : undefined;

      const executor = createToolExecutor({
        tools: childTools,
        policy: deps.policy,
        cwd: ctx.cwd,
        signal: childController.signal,
        getState: () => ctx.state,
        // No UI for nested prompts → deny. The shared policy still auto-allows
        // safe tools and any remembered always-allow patterns before we get here.
        awaitPermission: async () => 'deny',
        hooks: childHooks,
      });

      try {
        await runTurn(
          {
            id: nestedTurnId(),
            messages: [{ role: 'user', content: task }],
            model: entry.id,
            cwd: ctx.cwd,
            ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          },
          {
            client: deps.createClient(entry),
            executor,
            specs: childTools.map((tool) => tool.spec),
            dispatch,
            signal: childController.signal,
            registry: childRegistry,
          },
        );
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        ctx.signal.removeEventListener('abort', onParentAbort);
        childRegistry.drainDeny();
      }

      if (childController.signal.aborted) {
        return { ok: false, error: SUBAGENT_ABORTED };
      }
      if (errorMessage !== null) {
        return { ok: false, error: `sub-agent error: ${errorMessage}` };
      }
      const summary = (finalText.length > 0 ? finalText : currentText).trim();
      return {
        ok: true,
        data: {
          summary,
          model: entry.id,
          // The child's RESOLVED backend (decision d). Stamped HERE at the spawn source —
          // the one place that has resolved the child's catalog entry — so the recorder can
          // persist it (via the settled spawn card's result) and a resumed session can tag
          // the subagent with the provider it ACTUALLY ran on, even when that differs from
          // the parent turn's backend (cross-provider children). The render edge unwraps
          // `{ summary }` (ToolCallCard.toDisplay), so this extra field is display-invisible.
          provider: entry.provider,
          ...(agentName !== undefined ? { agent: agentName } : {}),
        },
      };
    },
  };
}
