// src/services/agents.ts
// Wave 3 — sub-agent definition discovery. Reads `.claude/agents/*.md` from the
// user home and project (the dirs Claude Code uses; neither need exist). Each
// file's frontmatter supplies name/description and the OPTIONAL per-definition
// overrides (model, tools); the markdown body is the agent's system prompt.
//
// Used by the portable `spawn_subagent` tool: a named agent overrides the model,
// the inherited toolset, and the system prompt. Absent dirs degrade to {} — the
// tool then just runs the default (inherit-parent-minus-spawn) sub-agent.
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { extractList, normalizeWs, parseScalars, splitFrontmatter } from './frontmatter';

export interface AgentDefinition {
  /** Agent name (frontmatter `name`, else the file stem). */
  name: string;
  /** One-line description of when to use this agent. */
  description: string;
  /** The agent's system prompt (the markdown body after the frontmatter). */
  prompt: string;
  /** Optional model id/alias override. */
  model?: string;
  /** Optional explicit toolset (by tool name); when absent, inherit parent-minus-spawn. */
  tools?: string[];
  source: 'user' | 'project';
}

function discoverInRoot(root: string, source: 'user' | 'project'): AgentDefinition[] {
  let fileNames: string[];
  try {
    fileNames = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const defs: AgentDefinition[] = [];
  for (const fileName of fileNames) {
    const file = path.join(root, fileName);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { frontmatter, body } = splitFrontmatter(raw);
    const fields = frontmatter === null ? {} : parseScalars(frontmatter);
    const stem = fileName.replace(/\.md$/, '');
    // normalizeWs (not just trim): a block-scalar `name:` can carry embedded
    // newlines (consistency with skills.ts; agent names appear in tool errors).
    const name = normalizeWs(fields.name ?? stem);
    if (name.length === 0) {
      continue;
    }
    const def: AgentDefinition = {
      name,
      description: normalizeWs(fields.description ?? ''),
      prompt: body.trim(),
      source,
    };
    if (fields.model !== undefined && fields.model.length > 0) {
      def.model = fields.model;
    }
    const tools = frontmatter === null ? undefined : extractList(frontmatter, 'tools');
    if (tools !== undefined && tools.length > 0) {
      def.tools = tools;
    }
    defs.push(def);
  }
  return defs;
}

/** Load agent definitions keyed by name (user root wins a collision). */
export function loadAgentDefinitions(opts?: {
  homeDir?: string;
  cwd?: string;
}): Record<string, AgentDefinition> {
  const homeDir = opts?.homeDir ?? os.homedir();
  const cwd = opts?.cwd ?? process.cwd();
  const roots: ReadonlyArray<{ dir: string; source: 'user' | 'project' }> = [
    { dir: path.join(homeDir, '.claude', 'agents'), source: 'user' },
    { dir: path.join(cwd, '.claude', 'agents'), source: 'project' },
  ];

  const byName: Record<string, AgentDefinition> = {};
  for (const { dir, source } of roots) {
    for (const def of discoverInRoot(dir, source)) {
      if (byName[def.name] === undefined) {
        byName[def.name] = def;
      }
    }
  }
  return byName;
}
