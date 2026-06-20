// src/services/sessionPersistence.ts
// Session Resume — PURE producer/formatting helpers (no React, no I/O, no clock).
// app.tsx owns the clock + generated ids and hands them in; these helpers only
// derive titles + shape palette entries so app.tsx stays thin and the formatting
// is unit-testable in isolation.
import type { Msg } from '../core/reducer';
import type { SessionMeta } from './sessions';
import type { SessionPaletteEntry } from '../ui/UnifiedCommandPalette';

/** Max title length before truncation (an ellipsis replaces the trailing overflow). */
const TITLE_MAX = 60;

/** Concatenate a message's text-block texts (tool blocks contribute nothing). */
function messageText(message: Msg): string {
  return message.blocks
    .map((block) => (block.kind === 'text' ? block.text : ''))
    .join('');
}

/**
 * Derive a human-readable session title from the FIRST `role === 'user'` message:
 * its concatenated text blocks, trimmed, sliced to ~60 chars (with a `…` ellipsis
 * when longer). Returns `undefined` when there is no user message or it is empty
 * after trimming. PURE.
 */
export function deriveSessionTitle(messages: ReadonlyArray<Msg>): string | undefined {
  const firstUser = messages.find((message) => message.role === 'user');
  if (firstUser === undefined) {
    return undefined;
  }

  const text = messageText(firstUser).trim();
  if (text.length === 0) {
    return undefined;
  }

  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
}

/**
 * Build a `SessionMeta` for a session, deriving `title` from the transcript. The
 * caller supplies `id`/`createdAt` (the clock lives in app.tsx, never here).
 * Optional fields (`model`, `cwd`, `title`) are OMITTED when absent so the meta
 * stays exact-optional clean. PURE.
 */
export function sessionMetaFor(input: {
  id: string;
  createdAt: string;
  model?: string;
  cwd?: string;
  messages: ReadonlyArray<Msg>;
}): SessionMeta {
  const title = deriveSessionTitle(input.messages);
  const meta: SessionMeta = { id: input.id, createdAt: input.createdAt };
  if (input.model !== undefined) {
    meta.model = input.model;
  }
  if (input.cwd !== undefined) {
    meta.cwd = input.cwd;
  }
  if (title !== undefined) {
    meta.title = title;
  }
  return meta;
}

/**
 * Map session metas to palette entries (id, title ?? id, subtitle from createdAt).
 * Order is PRESERVED — the caller (store.list()) already sorts chronologically.
 */
export function toPaletteEntries(metas: ReadonlyArray<SessionMeta>): SessionPaletteEntry[] {
  return metas.map((meta) => ({
    id: meta.id,
    title: meta.title ?? meta.id,
    subtitle: meta.createdAt,
  }));
}
