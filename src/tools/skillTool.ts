// src/tools/skillTool.ts
// Wave 3 — the `load_skill` tool: on-demand (progressive-disclosure) loader for
// a named skill's full SKILL.md instructions. risk:'safe' (read-only). A module-
// level factory over a SkillsService — NO change to the frozen ToolCtx / Tool
// contract (the executor still owns the permission gate).
import type { Tool, ToolCtx, ToolResult, ToolSpec } from '../core/contracts';
import type { SkillsService } from '../services/skills';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const loadSkillSpec: ToolSpec = {
  name: 'load_skill',
  description:
    "Load a named skill's full instructions on demand. Pass `name` exactly as listed in the available-skills section of the system prompt. Returns the skill's instruction body to read and follow.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { name: { type: 'string', description: 'The skill name to load.' } },
    required: ['name'],
  },
};

/** Build the `load_skill` tool over a SkillsService. */
export function createSkillTool(skills: SkillsService): Tool {
  return {
    name: 'load_skill',
    risk: 'safe',
    spec: loadSkillSpec,
    async run(args: unknown, _ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) {
        return { ok: false, error: 'invalid args' };
      }
      const name = typeof args.name === 'string' ? args.name : undefined;
      if (name === undefined || name.length === 0) {
        return { ok: false, error: 'invalid args' };
      }
      const skill = skills.get(name);
      if (skill === undefined) {
        const known = skills.list().map((entry) => entry.name).join(', ');
        return { ok: false, error: `unknown skill: ${name}. Available: ${known || '(none)'}` };
      }
      const body = skills.loadBody(name);
      if (body === undefined || body.length === 0) {
        return { ok: false, error: `skill "${name}" has no loadable instructions` };
      }
      return { ok: true, data: { name, description: skill.description, body } };
    },
  };
}
