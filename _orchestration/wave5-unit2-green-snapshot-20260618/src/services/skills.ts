// src/services/skills.ts
// Wave 3 — skills discovery + on-demand body loading (progressive disclosure).
//
// Discovers SKILL.md files under ~/.claude/skills/ (user) and <cwd>/.claude/skills/
// (project) — the SAME dirs Claude Code uses — parses the YAML frontmatter
// (name + description, tolerant of missing fields and both block-scalar styles),
// and exposes:
//   - list()         : skill metadata (name + description) for system-prompt injection
//   - get(name)      : one skill's metadata
//   - loadBody(name) : the full SKILL.md instructions, read LAZILY on invoke
//
// Progressive disclosure: only names + descriptions are injected into the system
// prompt every turn (cheap); the full body is read off disk ONLY when the model
// calls the `load_skill` tool — so we never re-bill all skill bodies per turn.
//
// Dependency-free (juno keeps deps minimal — no YAML lib): a small frontmatter
// extractor handles exactly the fields v1 honors (name, description, version).
// Never throws on missing dirs or malformed files — bad entries are skipped.
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { normalizeWs, parseScalars, splitFrontmatter } from './frontmatter';

export interface Skill {
  /** Skill name (frontmatter `name`, else the directory name). */
  name: string;
  /** One-line description (frontmatter `description`), whitespace-normalized. */
  description: string;
  /** Optional semver from frontmatter `version`. */
  version?: string;
  /** Absolute path to the SKILL.md file (read lazily by loadBody). */
  path: string;
  /** Which root it came from. User-home wins on a name collision. */
  source: 'user' | 'project';
}

export interface SkillsService {
  /** All discovered skills, de-duplicated by name (user wins), name-sorted. */
  list(): ReadonlyArray<Skill>;
  /** One skill's metadata, or undefined if unknown. */
  get(name: string): Skill | undefined;
  /** The full SKILL.md instruction body (after the frontmatter), read lazily. */
  loadBody(name: string): string | undefined;
}

// --- discovery ----------------------------------------------------------------

function discoverInRoot(root: string, source: 'user' | 'project'): Skill[] {
  let dirNames: string[];
  try {
    dirNames = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return []; // missing dir is normal — degrade to no skills, never throw.
  }

  const skills: Skill[] = [];
  for (const dirName of dirNames) {
    const file = path.join(root, dirName, 'SKILL.md');
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue; // dir without a SKILL.md — skip.
    }
    const { frontmatter } = splitFrontmatter(raw);
    const fields = frontmatter === null ? {} : parseScalars(frontmatter);
    // normalizeWs (not just trim): a block-scalar `name:` can carry embedded
    // newlines that would otherwise inject extra lines into the assembled system
    // prompt (one-entry-per-line) — a supply-chain prompt-injection vector.
    const name = normalizeWs(fields.name ?? dirName);
    if (name.length === 0) {
      continue;
    }
    const skill: Skill = {
      name,
      description: normalizeWs(fields.description ?? ''),
      path: file,
      source,
    };
    if (fields.version !== undefined && fields.version.length > 0) {
      skill.version = fields.version;
    }
    skills.push(skill);
  }
  return skills;
}

/**
 * Build a skills service over the real filesystem. Scans the user root first,
 * then the project root, so a user-level skill wins on a name collision (tests
 * point homeDir/cwd at temp dirs for determinism).
 */
export function createSkillsService(opts?: {
  homeDir?: string;
  cwd?: string;
}): SkillsService {
  const homeDir = opts?.homeDir ?? os.homedir();
  const cwd = opts?.cwd ?? process.cwd();
  const roots: ReadonlyArray<{ dir: string; source: 'user' | 'project' }> = [
    { dir: path.join(homeDir, '.claude', 'skills'), source: 'user' },
    { dir: path.join(cwd, '.claude', 'skills'), source: 'project' },
  ];

  const byName = new Map<string, Skill>();
  for (const { dir, source } of roots) {
    for (const skill of discoverInRoot(dir, source)) {
      if (!byName.has(skill.name)) {
        byName.set(skill.name, skill); // first seen (user root) wins.
      }
    }
  }
  const sorted = [...byName.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  return {
    list(): ReadonlyArray<Skill> {
      return sorted;
    },
    get(name: string): Skill | undefined {
      return byName.get(name);
    },
    loadBody(name: string): string | undefined {
      const skill = byName.get(name);
      if (skill === undefined) {
        return undefined;
      }
      try {
        const raw = readFileSync(skill.path, 'utf8');
        return splitFrontmatter(raw).body.trim();
      } catch {
        return undefined;
      }
    },
  };
}

/** Deterministic, file-free service over literal skills (tests/fakes). */
export function createFakeSkillsService(
  skills: ReadonlyArray<Skill>,
  bodies: Record<string, string> = {},
): SkillsService {
  const byName = new Map(skills.map((skill) => [skill.name, skill] as const));
  const sorted = [...skills].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    list(): ReadonlyArray<Skill> {
      return sorted;
    },
    get(name: string): Skill | undefined {
      return byName.get(name);
    },
    loadBody(name: string): string | undefined {
      return byName.has(name) ? (bodies[name] ?? '') : undefined;
    },
  };
}

// --- system-prompt assembly ---------------------------------------------------

/**
 * Build the progressive-disclosure skills system prompt: names + descriptions
 * only, plus the instruction to call `load_skill` for the full body. Returns
 * undefined when there are no skills (so juno sends no system prompt at all,
 * preserving prior behavior). Pure — safe to unit-test.
 */
export function assembleSystemPrompt(skills: ReadonlyArray<Skill>): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }
  const entries = skills.map((skill) =>
    skill.description.length > 0 ? `- ${skill.name}: ${skill.description}` : `- ${skill.name}`,
  );
  return [
    'You have access to SKILLS — reusable expertise packaged as instructions.',
    'When a task matches one of the skills below, call the `load_skill` tool with',
    "that skill's exact name to load its full instructions, then follow them.",
    '',
    'Available skills:',
    ...entries,
  ].join('\n');
}
