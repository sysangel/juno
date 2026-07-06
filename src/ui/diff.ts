// src/ui/diff.ts
// Pure unified-diff builder for file-mutating tool calls (write_file / edit_file).
// Turns a permission request's args into typed diff lines so PermissionPrompt can
// render a colorized preview instead of a one-lined payload dump.
//
// NO I/O — it never reads the real file; it diffs ONLY what the args carry:
//   edit_file  -> oldString → newString (a real remove/add diff with context)
//   write_file -> the new content, shown as all-adds (args carry no prior content)

export type DiffLineKind = 'add' | 'remove' | 'context' | 'meta';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Line-level diff of two blocks: shared leading/trailing lines render as
 * `context`, the divergent middle as remove-then-add. Not a full LCS — exact
 * string-replacement edits are prefix/suffix-shaped, which this captures cleanly
 * and cheaply.
 */
function lineDiff(oldStr: string, newStr: string): DiffLine[] {
  const o = oldStr.split('\n');
  const n = newStr.split('\n');

  let start = 0;
  while (start < o.length && start < n.length && o[start] === n[start]) start++;

  let oEnd = o.length;
  let nEnd = n.length;
  while (oEnd > start && nEnd > start && o[oEnd - 1] === n[nEnd - 1]) {
    oEnd--;
    nEnd--;
  }

  const lines: DiffLine[] = [];
  for (let i = 0; i < start; i++) lines.push({ kind: 'context', text: o[i] });
  for (let i = start; i < oEnd; i++) lines.push({ kind: 'remove', text: o[i] });
  for (let i = start; i < nEnd; i++) lines.push({ kind: 'add', text: n[i] });
  for (let i = nEnd; i < n.length; i++) lines.push({ kind: 'context', text: n[i] });
  return lines;
}

/**
 * Build a diff preview for a file-mutating tool call, or `null` when the tool is
 * not a file mutation or its args are malformed (caller falls back to the
 * one-line arg summary). `edit_file` yields a real old→new diff; `write_file`
 * has no prior content in its args, so its content renders as an all-adds
 * "new content" view.
 */
export function buildDiff(name: string, args: unknown): DiffLine[] | null {
  if (!isRecord(args)) return null;
  const path = stringProp(args, 'path');
  if (path === undefined) return null;

  if (name === 'edit_file') {
    const oldString = stringProp(args, 'oldString');
    const newString = stringProp(args, 'newString');
    if (oldString === undefined || newString === undefined) return null;
    // replaceAll applies the shown replacement to EVERY occurrence — surface the
    // multiplier explicitly so the user does not under-approve the blast radius.
    const meta: DiffLine[] =
      args.replaceAll === true
        ? [
            { kind: 'meta', text: `edit ${path}` },
            { kind: 'meta', text: '(applies to all occurrences)' },
          ]
        : [{ kind: 'meta', text: `edit ${path}` }];
    return [...meta, ...lineDiff(oldString, newString)];
  }

  if (name === 'write_file') {
    const content = stringProp(args, 'content');
    if (content === undefined) return null;
    const added = content.split('\n').map((text): DiffLine => ({ kind: 'add', text }));
    return [{ kind: 'meta', text: `write ${path} (new content)` }, ...added];
  }

  return null;
}

/** The single-char gutter marker for a diff line kind. */
export function diffMarker(kind: DiffLineKind): string {
  switch (kind) {
    case 'add':
      return '+';
    case 'remove':
      return '-';
    case 'context':
      return ' ';
    case 'meta':
      return '@';
  }
}
