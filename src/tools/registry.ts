// src/tools/registry.ts
// W7 — the v1 tool registry. No bash/shell in v1.
import type { Tool, ToolSpec } from '../core/contracts';
import type { SkillsService } from '../services/skills';
import { createBrainRememberTool, type BrainRememberToolDeps } from './brainTool';
import { createBrainReadTools, type BrainReadToolsDeps } from './brainReadTools';
import { createFileTools } from './fileTools';
import { createMcpTools, type McpToolsDeps } from './mcpTools';
import { createMemoryTools, type MemoryToolsDeps } from './memoryTools';
import { createShellTool, type ShellToolDeps } from './shellTool';
import { createSkillTool } from './skillTool';
import { createSubagentTool, type SubagentDeps } from './subagentTool';

/** Optional capabilities layered onto the base file tools (Wave 3). */
export interface DefaultToolsOptions {
  /** When provided, registers the on-demand `load_skill` tool over these skills. */
  readonly skills?: SkillsService;
  /**
   * When provided, registers the portable `spawn_subagent` tool. `childTools` is
   * supplied by the registry (the base tools assembled here, which never include
   * spawn_subagent — that is what enforces depth-1), so the caller passes
   * everything EXCEPT childTools.
   */
  readonly subagent?: Omit<SubagentDeps, 'childTools'>;
  /**
   * When provided, registers the session-scratch memory tools (`remember_fact`
   * + `recall_facts`) for the PARENT agent — the bounded, evictable tier
   * (durable writes go through `brainRemember`). Pushed LAST (after subagent) so
   * they are NOT in the sub-agent's childTools snapshot — sub-agents do not
   * persist state.
   */
  readonly memory?: MemoryToolsDeps;
  /**
   * When provided, registers the durable-memory WRITE tool `brain_remember`
   * (risk:'risky' — it pushes to a private remote, so always prompt-gated).
   * Gated behind `brain.enabled` at the call site; the DURABLE tier of the
   * two-tier memory (native remember_fact/recall_facts are the session-scratch
   * tier). Pushed AFTER the subagent so it is NOT in the sub-agent's childTools
   * snapshot: brain writes are a depth-1, parent-agent-only capability, matching
   * how Claude Code sessions treat brain writes.
   */
  readonly brainRemember?: BrainRememberToolDeps;
  /**
   * When provided, registers the read-only brain tools `brain_recall` +
   * `brain_get` (risk:'safe' — reads only, like the file read tools). Gated
   * behind `brain.enabled` at the call site. Pushed AFTER the subagent so they
   * are NOT in the sub-agent's childTools snapshot: like the whole brain
   * integration, reads are a depth-1, parent-agent-only capability.
   */
  readonly brainRead?: BrainReadToolsDeps;
  /**
   * When provided, registers one `mcp__<server>__<tool>` tool per remote tool
   * discovered by the (already started) MCP manager. Risk is classified per tool
   * (config `toolRisk.<tool>` override, else the server-wide `risk`, else the
   * 'risky' default — remote tools are third-party code and are never auto-allowed
   * unless deliberately classified). Pushed AFTER the subagent so
   * MCP tools are NOT in the sub-agent's childTools snapshot: remote tool
   * access is a depth-1, parent-agent-only capability, matching brain/shell.
   */
  readonly mcp?: McpToolsDeps;
  /**
   * When provided, registers the `run_shell` tool (risk:'dangerous' — always
   * prompt-gated). Pushed AFTER the subagent so it is NOT in the sub-agent's
   * childTools snapshot: the shell is a depth-1, parent-agent-only capability,
   * mirroring the memory tools. `{}` accepts the defaults (120s timeout, etc.).
   */
  readonly shell?: ShellToolDeps;
}

/** All v1 tools, as fresh independent instances. With no opts this is exactly
 * the five file tools (so BUILTIN_TOOL_SPECS and the test fixtures are stable). */
export function createDefaultTools(opts?: DefaultToolsOptions): Tool[] {
  const tools = createFileTools();
  if (opts?.skills !== undefined) {
    tools.push(createSkillTool(opts.skills));
  }
  if (opts?.subagent !== undefined) {
    // The sub-agent inherits the base tools assembled SO FAR (file tools +
    // load_skill). That set excludes spawn_subagent itself → depth-1 by design.
    const childTools = [...tools];
    tools.push(createSubagentTool({ ...opts.subagent, childTools }));
  }
  if (opts?.shell !== undefined) {
    // AFTER the subagent push: the shell is the riskiest capability and is
    // parent-agent-only (not in the sub-agent's childTools snapshot).
    tools.push(createShellTool(opts.shell));
  }
  if (opts?.brainRead !== undefined) {
    // AFTER the subagent push: read-only, but kept parent-agent-only so the whole
    // brain integration stays a depth-1 capability (matches brain_remember).
    tools.push(...createBrainReadTools(opts.brainRead));
  }
  if (opts?.brainRemember !== undefined) {
    // AFTER the subagent push: brain writes are parent-agent-only (not in the
    // sub-agent's childTools snapshot), matching the memory + shell tiers.
    tools.push(createBrainRememberTool(opts.brainRemember));
  }
  if (opts?.mcp !== undefined) {
    // AFTER the subagent push: remote MCP tools are parent-agent-only (not in
    // the sub-agent's childTools snapshot), matching the brain + shell tiers.
    tools.push(...createMcpTools(opts.mcp));
  }
  if (opts?.memory !== undefined) {
    // AFTER the subagent push (LAST): keeps memory tools out of the sub-agent's
    // childTools snapshot, so only the depth-1 main agent owns persisted state.
    tools.push(...createMemoryTools(opts.memory));
  }
  return tools;
}

/** The JSON-schema specs for every built-in tool (handed to the model by W9/W6). */
export const BUILTIN_TOOL_SPECS: ToolSpec[] = createDefaultTools().map((tool) => tool.spec);
