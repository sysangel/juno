export const meta = {
  name: 'juno-cc-port-spec',
  description: 'Research + scope how to port Claude Code features (subscription-drive, effort control, subagents, skills) into the juno harness; produce a PORT SPEC',
  phases: [
    { title: 'Research', detail: 'parallel teams: CC feature inventory, endpoint capability matrix, juno seam map, subscription-drive' },
    { title: 'Synthesize', detail: 'merge research into a port spec + OoO-with-teams plan' },
    { title: 'Verify', detail: 'skeptical review of capability claims, then finalize + write the spec to disk' },
  ],
}

// ---- Shared context baked in (next session has a clean window) ----
const JUNO = [
  'juno = a TypeScript / Node 20 / React+Ink terminal agent app at C:\\Users\\Core\\src\\juno (a from-scratch rewrite of an old Python harness; currently 206/206 vitest green, tsc clean).',
  'CURRENT STATE (verified 2026-06-17): it talks to OpenAI / Anthropic / OpenRouter over RAW HTTP using API keys (env: OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY).',
  'Static 5-entry model catalog in src/services/catalog.ts (gpt-4.1, gpt-4.1-mini, claude-sonnet-4-20250514, openai/gpt-4.1, anthropic/claude-sonnet-4).',
  'Three execution modes normal|plan|ultracode (src/core/reducer.ts) that are CURRENTLY INERT: the value is plumbed to TurnInput.mode but NO adapter consumes it; it only colors a status-bar badge (src/ui/ModeBadge.tsx).',
  'A claude-cli provider entry exists but is marked deferred (src/providers/index.ts).',
  'Tools = 5 file tools only (read/list/grep/write/edit) in src/tools/; there is NO subagent/Task/spawn tool and NO skills loader.',
  'Known bug: the ModelClient is built once at startup (src/cli.ts) and the picker only swaps the model slug, so switching provider in the TUI sends a foreign slug to the wrong endpoint and 404s.',
].join(' ')

const INTENT = [
  "USER'S CORRECTED INTENT / GOAL for juno:",
  '(1) juno is meant to run through the TERMINAL version of Claude Code via the MAX SUBSCRIPTION, NOT via paid API. The primary backend should be Claude Code itself (the claude CLI / Claude Agent SDK), leveraging the subscription. This elevates the deferred claude-cli provider to primary.',
  '(2) The ultracode mode is meant to CHANGE THE EFFORT of the model (extended thinking / reasoning effort). Investigate whether a harness can control effort, and how.',
  '(3) Want SUBAGENT SPAWNING ported in.',
  '(4) Want SKILLS loading ported in.',
  '(5) Inventory the actual special things you can do in the Claude Code console (effort control, subagents, skills, plan mode, hooks, MCP, permission modes) and decide which are portable into juno.',
  '(6) Determine per-ENDPOINT whether each feature is even possible (especially change-effort): is it Anthropic-only, OpenAI-too, OpenRouter, or available when driving Claude Code via subscription? Maybe the raw API allows effort only on Anthropic + OpenAI. Map feature x endpoint -> feasible? + exact mechanism.',
].join(' ')

phase('Research')
const research = await parallel([
  () => agent(
    JUNO + '\n\n' + INTENT + '\n\n' +
    'YOUR TASK (Team A - Claude Code feature inventory): Produce a precise, CURRENT inventory of Claude Code (the CLI/console) special capabilities and EXACTLY how each is controlled/exposed. Cover at least: ' +
    '(a) EFFORT / thinking control - think vs ultrathink keywords, extended-thinking budgets, /fast mode, model effort, any reasoning-effort knob; ' +
    '(b) SUBAGENT spawning - the Task/Agent tool, fork vs fresh-context subagents, how invoked, how results return; ' +
    '(c) SKILLS - SKILL.md format, how skills are discovered/loaded/invoked (the Skill tool, plugin skills, slash commands); ' +
    '(d) PLAN MODE - what it gates; (e) HOOKS; (f) MCP servers; (g) permission modes. ' +
    'For EACH: what it does + the exact control surface (CLI flag, in-prompt keyword, settings.json, SDK option). Use web search / official docs and CITE. Flag anything subscription-specific vs API-specific. Return a structured findings doc.',
    { label: 'research:cc-features', phase: 'Research', agentType: 'claude-code-guide' }
  ),
  () => agent(
    JUNO + '\n\n' + INTENT + '\n\n' +
    'YOUR TASK (Team B - endpoint capability matrix): Build a FEATURE x ENDPOINT capability matrix for the endpoints juno could connect to: [Claude Code CLI / Agent SDK via Max subscription] x [Anthropic Messages API] x [OpenAI API] x [OpenRouter]. ' +
    'Feature rows: model effort/reasoning control, extended thinking, subagent spawning, skills, tool/function calling, MCP, streaming, system-prompt control, vision. ' +
    'For EACH cell: is the feature achievable on that endpoint, and via what EXACT mechanism/param? ' +
    'Pay special attention to CHANGE EFFORT: Anthropic = extended thinking (budget_tokens)? OpenAI = reasoning_effort (which models)? OpenRouter = reasoning passthrough? Claude Code subscription = ?? ' +
    'Be precise about which models support it and any subscription-vs-API differences. Use official docs (Anthropic, OpenAI, OpenRouter) via web and CITE. Where uncertain, say so explicitly. Return the matrix + notes.',
    { label: 'research:endpoint-matrix', phase: 'Research', agentType: 'claude-code-guide' }
  ),
  () => agent(
    JUNO + '\n\n' + INTENT + '\n\n' +
    'YOUR TASK (Team C - juno codebase seam map): READ-ONLY. Map juno current architecture and the EXACT seams where each target feature attaches. Read: src/core/{contracts,reducer,events,selectors}.ts, src/providers/{index,openaiCompatClient,anthropicClient}.ts (and any claude-cli stub), src/services/{config,catalog}.ts, src/agent/{turnRunner,eventBus}.ts, src/hooks/useStreamingTurn.ts, src/app.tsx, src/cli.ts, src/tools/{registry,fileTools,executor}.ts, README.md, docs/*. ' +
    'For each TARGET feature - (1) a Claude-Code-subscription provider (the deferred claude-cli), (2) effort control wired to ultracode mode, (3) subagent spawning, (4) skills loading, (5) making plan/ultracode modes actually do something - report the precise file(s) + the shape of the change + which existing contract it plugs into (ModelClient? ToolExecutor? TurnInput.mode? a new tool in the registry?). Quote the relevant interface lines (file:line). Return the seam map.',
    { label: 'research:juno-seams', phase: 'Research', agentType: 'general-purpose' }
  ),
  () => agent(
    JUNO + '\n\n' + INTENT + '\n\n' +
    'YOUR TASK (Team D - how to DRIVE Claude Code via subscription from a harness): This is the architecture crux. Research precisely HOW a TS/Node app could drive Claude Code using the user MAX SUBSCRIPTION (not API billing). Cover: ' +
    'the Claude Agent SDK (@anthropic-ai/claude-agent-sdk / the claude-code SDK) - does it use subscription auth or require an API key? ' +
    'the claude CLI headless mode (claude -p, --output-format stream-json, --model, allowed-tools / permission-mode flags, --append-system-prompt, MCP config) - what control surface does it expose (model choice, effort/thinking, subagents, skills, tools, permission mode)? ' +
    'How does auth work (does it reuse the logged-in Claude Code subscription session)? Can effort/thinking be controlled when driving it? Can subagents + skills be used through it? Cite official docs via web. Be explicit about what is and is not possible/supported. Return findings + a recommended integration approach for the juno provider layer.',
    { label: 'research:subscription-drive', phase: 'Research', agentType: 'claude-code-guide' }
  ),
])
const [features, matrix, seams, subdrive] = research.map(function (r) { return r || '(team returned no result)'; })

phase('Synthesize')
const specV1 = await agent(
  'You are the Opus SYNTHESIZER. Merge the four research outputs below into ONE rigorous, well-structured Markdown PORT SPEC for the juno team. Purpose: SCOPE (not yet implement) how to port Claude Code special features into juno, with the corrected architecture that juno drives Claude Code via the Max SUBSCRIPTION (not API). It will be executed by an Orchestrator-of-Orchestrators running multiple teams (the team-of-3 discipline used to build juno).\n\n' +
  JUNO + '\n\n' + INTENT + '\n\n' +
  '=== TEAM A: Claude Code feature inventory ===\n' + features + '\n\n' +
  '=== TEAM B: endpoint capability matrix ===\n' + matrix + '\n\n' +
  '=== TEAM C: juno seam map ===\n' + seams + '\n\n' +
  '=== TEAM D: subscription-drive ===\n' + subdrive + '\n\n' +
  'WRITE THE SPEC with these sections: ' +
  '1. Context and corrected architecture (juno today vs the subscription-driven target). ' +
  '2. Questions to investigate (the user questions, sharpened). ' +
  '3. Feature x endpoint capability matrix (cleaned, with the change-effort row called out and Anthropic-only / OpenAI-too / subscription-vs-API distinctions explicit; mark confidence + cite). ' +
  '4. Per-feature port design - for EACH (subscription/claude-cli provider, effort->ultracode wiring, subagent spawning, skills loading, plan/ultracode behavior): what it is, the endpoint mechanism, the juno seam (file + shape of change from Team C), open questions, risk. ' +
  '5. Next-session investigation plan (OoO-with-teams) - decompose into the team waves a later session should run to BUILD this (which teams investigate/build what, dependencies, what each verifies). ' +
  '6. Open questions and decisions needed from the user. ' +
  'Be precise; carry forward any uncertainty Teams flagged as open questions; DO NOT overclaim endpoint capabilities. Return ONLY the Markdown spec.',
  { label: 'synth:port-spec', phase: 'Synthesize' }
)

phase('Verify')
const critique = await agent(
  'You are a SKEPTICAL technical VERIFIER. Scrutinize the PORT SPEC below for: (a) UNSUPPORTED or likely-wrong capability claims (especially what each endpoint/subscription actually allows re effort/thinking, subagents, skills); (b) architecture errors (e.g. assuming the Agent SDK uses subscription auth when it may need an API key, or vice versa); (c) juno seam claims that do not match the described codebase; (d) gaps / missing features; (e) anything stated with false confidence that should be an open question. Be harsh and specific.\n\n=== SPEC ===\n' + specV1,
  { label: 'verify:spec', phase: 'Verify', schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      unsupportedClaims: { type: 'array', items: { type: 'string' } },
      architectureRisks: { type: 'array', items: { type: 'string' } },
      seamMismatches: { type: 'array', items: { type: 'string' } },
      gaps: { type: 'array', items: { type: 'string' } },
      mustBecomeOpenQuestions: { type: 'array', items: { type: 'string' } },
      overallVerdict: { type: 'string' },
    },
    required: ['unsupportedClaims', 'architectureRisks', 'seamMismatches', 'gaps', 'mustBecomeOpenQuestions', 'overallVerdict'],
  } }
)

const specFinal = await agent(
  'You are the Opus SYNTHESIZER, finalizing. Take the PORT SPEC and the skeptical VERIFIER findings and produce the FINAL spec: correct or soften every flagged claim, move false-confidence items into Open Questions, fix seam mismatches, add gaps. Keep the good structure. ' +
  'THEN WRITE the final Markdown to disk at C:\\Users\\Core\\src\\juno\\docs\\PORT_SPEC-claude-code-features.md (use the Write tool). ' +
  'Return a short confirmation: the path written, a 5-bullet executive summary, and the bulleted list of open questions for the user.\n\n' +
  '=== SPEC v1 ===\n' + specV1 + '\n\n' +
  '=== VERIFIER FINDINGS (JSON) ===\n' + JSON.stringify(critique) + '\n',
  { label: 'synth:final', phase: 'Verify' }
)

return specFinal
