// src/tools/registry.ts
// W7 — the v1 tool registry. No bash/shell in v1.
import type { Tool, ToolSpec } from '../core/contracts';
import { createFileTools } from './fileTools';

/** All v1 tools, as fresh independent instances. */
export function createDefaultTools(): Tool[] {
  return createFileTools();
}

/** The JSON-schema specs for every built-in tool (handed to the model by W9/W6). */
export const BUILTIN_TOOL_SPECS: ToolSpec[] = createDefaultTools().map((tool) => tool.spec);
