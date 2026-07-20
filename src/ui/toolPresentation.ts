import type { ToolState } from '../core/reducer';
import { isSubagentToolName } from '../core/selectors';

export type ToolFamily = 'read' | 'search' | 'write' | 'process' | 'test' | 'build' | 'mcp' | 'other' | 'agent';
export interface SemanticToolPresentation { readonly family: ToolFamily; readonly activity: string; readonly outcome: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function scalar(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}
function field(value: unknown, ...keys: string[]): string | undefined {
  const object = record(value);
  for (const key of keys) {
    const found = scalar(object?.[key]);
    if (found !== undefined && found.length > 0) return found;
  }
  return undefined;
}
function count(value: unknown, key: string): number | undefined {
  const found = record(value)?.[key];
  if (Array.isArray(found)) return found.length;
  return typeof found === 'number' && Number.isFinite(found) && found >= 0 ? found : undefined;
}
function noun(n: number, singular: string, plural = `${singular}s`): string { return `${n} ${n === 1 ? singular : plural}`; }
function commandKind(command: string): 'test' | 'build' | 'process' {
  const first = command.trim().split(/\s*(?:&&|;|\|\|)\s*/u)[0] ?? '';
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$)|^(?:pytest|vitest|jest|go test|cargo test|dotnet test)(?:\s|$)/iu.test(first)) return 'test';
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build(?:\s|$)|^(?:tsc|cargo build|go build|dotnet build)(?:\s|$)/iu.test(first)) return 'build';
  return 'process';
}
function navigationOutcome(name: string, result: unknown): string {
  if (['grep', 'search', 'rg'].includes(name)) {
    const matches = count(result, 'matches');
    return matches === undefined ? '' : noun(matches, 'match', 'matches');
  }
  const files = count(result, 'files');
  if (files !== undefined) return noun(files, 'file');
  const entries = count(result, 'entries');
  if (entries !== undefined) return noun(entries, 'entry', 'entries');
  if (Array.isArray(result)) return noun(result.length, 'item');
  return '';
}
function writeOutcome(name: string, result: unknown): string {
  const bytes = Number(field(result, 'bytesWritten'));
  if (Number.isFinite(bytes)) return noun(bytes, 'byte');
  const replacements = Number(field(result, 'replacements'));
  if (Number.isFinite(replacements)) return noun(replacements, 'replacement');
  if (name === 'apply_patch') {
    const changed = Number(field(result, 'filesChanged'));
    if (Number.isFinite(changed)) {
      const pieces = [noun(changed, 'file')];
      for (const [key, word] of [['created', 'created'], ['updated', 'updated'], ['deleted', 'deleted']] as const) {
        const n = count(result, key) ?? 0;
        if (n > 0) pieces.push(`${n} ${word}`);
      }
      return pieces.join(' · ');
    }
  }
  return '';
}
function processOutcome(family: ToolFamily, result: unknown): string {
  const exit = field(result, 'exitCode', 'exit_code');
  const duration = field(result, 'durationMs', 'duration_ms');
  const pieces: string[] = [];
  if (family === 'test' && exit === '0') pieces.push('tests passed');
  else if (family === 'build' && exit === '0') pieces.push('build completed');
  if (exit !== undefined) pieces.push(`exit ${exit}`);
  if (duration !== undefined) pieces.push(`${duration}ms`);
  return pieces.join(' · ');
}

/** Semantic default copy. Outcomes are emitted only from explicit result fields; Ctrl+O keeps raw truth. */
export function presentTool(tool: Pick<ToolState, 'name' | 'args' | 'result'>): SemanticToolPresentation {
  const lower = tool.name.toLowerCase();
  if (isSubagentToolName(tool.name)) return { family: 'agent', activity: tool.name, outcome: '' };
  const path = field(tool.args, 'path', 'file_path', 'dir') ?? '.';
  if (['read_file', 'read'].includes(lower)) {
    const outcome = typeof tool.result === 'string' && tool.result.length > 0
      ? noun(tool.result.split(/\r?\n/u).length, 'line')
      : '';
    return { family: 'read', activity: `Reading ${path}`, outcome };
  }
  if (['list_files', 'tree', 'glob_files', 'glob', 'ls'].includes(lower)) {
    const pattern = field(tool.args, 'pattern');
    return { family: 'read', activity: pattern === undefined ? `Exploring ${path}` : `Finding ${pattern}`, outcome: navigationOutcome(lower, tool.result) };
  }
  if (['grep', 'search', 'rg'].includes(lower)) {
    const pattern = field(tool.args, 'pattern', 'query') ?? 'text';
    return { family: 'search', activity: `Searching for “${pattern}”`, outcome: navigationOutcome(lower, tool.result) };
  }
  if (['write_file', 'write'].includes(lower)) return { family: 'write', activity: `Writing ${path}`, outcome: writeOutcome(lower, tool.result) };
  if (['edit_file', 'edit'].includes(lower)) return { family: 'write', activity: `Updating ${path}`, outcome: writeOutcome(lower, tool.result) };
  if (lower === 'apply_patch') {
    const operations = record(tool.args)?.operations;
    const paths = Array.isArray(operations) ? operations.map((op) => field(op, 'path')).filter((v): v is string => v !== undefined) : [];
    return { family: 'write', activity: `Applying patch to ${paths.length === 1 ? paths[0] : noun(paths.length, 'file')}`, outcome: writeOutcome(lower, tool.result) };
  }
  if (['run_shell', 'shell', 'bash', 'exec_command'].includes(lower)) {
    const command = field(tool.args, 'command', 'cmd') ?? 'command';
    const family = commandKind(command);
    const activity = family === 'test' ? 'Running tests' : family === 'build' ? 'Building project' : `Running ${command}`;
    return { family, activity, outcome: processOutcome(family, tool.result) };
  }
  if (lower.startsWith('mcp__')) {
    const parts = tool.name.split('__').filter(Boolean);
    const target = parts.length >= 2 ? `${parts.at(-2)}.${parts.at(-1)}` : tool.name;
    return { family: 'mcp', activity: `Calling ${target}`, outcome: navigationOutcome(lower, tool.result) };
  }
  return { family: 'other', activity: tool.name, outcome: '' };
}

export function batchOutcomeText(tools: readonly Pick<ToolState, 'name' | 'result'>[]): string {
  let files = 0; let matches = 0; let changes = 0; const exits: string[] = [];
  for (const tool of tools) {
    files += count(tool.result, 'files') ?? 0;
    matches += count(tool.result, 'matches') ?? 0;
    changes += Number(field(tool.result, 'filesChanged')) || 0;
    const exit = field(tool.result, 'exitCode', 'exit_code');
    if (exit !== undefined) exits.push(exit);
  }
  const parts: string[] = [];
  if (files > 0) parts.push(noun(files, 'file'));
  if (matches > 0) parts.push(noun(matches, 'match', 'matches'));
  if (changes > 0) parts.push(noun(changes, 'file') + ' changed');
  if (exits.length > 0 && new Set(exits).size === 1) parts.push(`exit ${exits[0]}`);
  return parts.join(' · ');
}
