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
import { createPermissionRegistry } from '../agent/eventBus';
import { runTurn } from '../agent/turnRunner';
import { createToolExecutor } from '../tools/executor';
import type { PermissionPolicy } from '../core/contracts';
import type { ModelCatalog, ModelEntry } from '../services/catalog';
import type { AgentDefinition } from '../services/agents';

export interface SubagentDeps {
  /** Build a ModelClient for a catalog entry (same factory App/cli use). */
  readonly createClient: (entry: ModelEntry) => ModelClient;
  readonly catalog: ModelCatalog;
  /** SHARED permission policy (remembered patterns persist into sub-agents). */
  readonly policy: PermissionPolicy;
  /** The tools a sub-agent inherits by default (parent base, MUST NOT include spawn). */
  readonly childTools: ReadonlyArray<Tool>;
  /** Default model id/alias when neither the call nor the agent def specifies one. */
  readonly defaultModel?: string;
  /** Named agent definitions (from .claude/agents/), keyed by name. */
  readonly agents?: Record<string, AgentDefinition>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const spawnSubagentSpec: ToolSpec = {
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

      const executor = createToolExecutor({
        tools: childTools,
        policy: deps.policy,
        cwd: ctx.cwd,
        signal: childController.signal,
        getState: () => ctx.state,
        // No UI for nested prompts → deny. The shared policy still auto-allows
        // safe tools and any remembered always-allow patterns before we get here.
        awaitPermission: async () => 'deny',
      });

      try {
        await runTurn(
          {
            id: nestedTurnId(),
            messages: [{ role: 'user', content: task }],
            model: entry.id,
            cwd: ctx.cwd,
            ...(agentDef?.prompt !== undefined && agentDef.prompt.length > 0
              ? { systemPrompt: agentDef.prompt }
              : {}),
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
        return { ok: false, error: 'sub-agent aborted' };
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
          ...(agentName !== undefined ? { agent: agentName } : {}),
        },
      };
    },
  };
}
