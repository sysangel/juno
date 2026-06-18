// src/services/frontmatter.ts
// Wave 3 — a tiny, dependency-free YAML-frontmatter reader shared by the skills
// and agents loaders. Handles exactly what those loaders need: inline scalars,
// literal (`|`) and folded (`>`) block scalars, and simple list fields. It is
// deliberately NOT a general YAML parser (juno keeps deps minimal); unknown /
// nested shapes are skipped rather than errored.

/** Split a markdown file into its leading `--- ... ---` frontmatter and body. */
export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(raw);
  if (match === null) {
    return { frontmatter: null, body: raw };
  }
  return { frontmatter: match[1] ?? '', body: match[2] ?? '' };
}

/** Collapse all whitespace runs to single spaces. */
export function normalizeWs(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Parse top-level SCALAR fields. Inline (`name: x`), literal block (`key: |`),
 * and folded block (`key: >`) are supported; list / nested fields are skipped.
 */
export function parseScalars(fm: string): Record<string, string> {
  const lines = fm.split(/\r?\n/);
  const out: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (match === null || /^\s/.test(line)) {
      i++;
      continue;
    }
    const key = match[1] ?? '';
    const value = (match[2] ?? '').trim();

    if (/^[|>][+-]?$/.test(value)) {
      const folded = value.startsWith('>');
      const collected: string[] = [];
      i++;
      while (i < lines.length) {
        const cur = lines[i] ?? '';
        if (cur.trim() === '') {
          collected.push('');
          i++;
          continue;
        }
        if (/^[ \t]/.test(cur)) {
          collected.push(cur.replace(/^[ \t]+/, ''));
          i++;
          continue;
        }
        break;
      }
      while (collected.length > 0 && collected[collected.length - 1] === '') {
        collected.pop();
      }
      out[key] = collected.join(folded ? ' ' : '\n');
      continue;
    }

    if (value === '') {
      // nested block / list — skip its indented / `- ` continuation lines.
      i++;
      while (i < lines.length) {
        const cur = lines[i] ?? '';
        if (cur.trim() === '' || /^[ \t]/.test(cur) || /^-[ \t]/.test(cur)) {
          i++;
          continue;
        }
        break;
      }
      continue;
    }

    out[key] = value.replace(/^["']|["']$/g, '');
    i++;
  }
  return out;
}

/**
 * Extract a list field as string[]: inline `key: a, b`, inline `key: [a, b]`, or
 * a block list of `- item` lines. Returns undefined if the key is absent.
 */
export function extractList(fm: string, key: string): string[] | undefined {
  const lines = fm.split(/\r?\n/);
  const keyPattern = new RegExp(`^${key}:[ \\t]*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s/.test(line)) {
      continue;
    }
    const match = keyPattern.exec(line);
    if (match === null) {
      continue;
    }
    const inline = (match[1] ?? '').trim();
    if (inline.length > 0) {
      const body = inline.replace(/^\[/, '').replace(/\]$/, '');
      return body
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter((item) => item.length > 0);
    }
    // block list: gather following `- item` lines.
    const items: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const cur = (lines[j] ?? '').trim();
      if (cur === '') {
        j++;
        continue;
      }
      const itemMatch = /^-[ \t]+(.*)$/.exec(cur);
      if (itemMatch === null) {
        break;
      }
      items.push((itemMatch[1] ?? '').trim().replace(/^["']|["']$/g, ''));
      j++;
    }
    return items;
  }
  return undefined;
}
