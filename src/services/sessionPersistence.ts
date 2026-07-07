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

/** Lowercase three-letter month abbreviations for the absolute-date fallback. */
const MONTH_ABBR = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Human-relative label for a past timestamp (F: sessions picker readability).
 * `then`/`now` are epoch-ms. Buckets: `just now` (<1m), `Nm ago` (<1h),
 * `Nh ago` (<24h), `yesterday` (<48h), else a lowercase `mon d` absolute date
 * (e.g. `jul 6`). A non-finite `then` (unparseable createdAt) or a future `then`
 * clamps to `just now`. PURE — the caller supplies `now`.
 */
export function formatRelativeTime(then: number, now: number): string {
  if (!Number.isFinite(then)) {
    return 'just now';
  }
  const diff = now - then;
  if (diff < MINUTE_MS) {
    return 'just now';
  }
  if (diff < HOUR_MS) {
    return `${Math.floor(diff / MINUTE_MS)}m ago`;
  }
  if (diff < DAY_MS) {
    return `${Math.floor(diff / HOUR_MS)}h ago`;
  }
  if (diff < 2 * DAY_MS) {
    return 'yesterday';
  }
  const date = new Date(then);
  return `${MONTH_ABBR[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Map session metas to palette entries (id, title ?? id, subtitle = relative time),
 * sorted NEWEST-FIRST (F). `store.list()` returns chronological order; this reverses
 * it and formats each `createdAt` relative to `now` (defaults to the wall clock so
 * existing callers keep working; injected in tests for determinism). An unparseable
 * `createdAt` sorts oldest and shows its raw string.
 */
export function toPaletteEntries(
  metas: ReadonlyArray<SessionMeta>,
  now: number = Date.now(),
): SessionPaletteEntry[] {
  const withTime = metas.map((meta) => ({ meta, ms: Date.parse(meta.createdAt) }));
  withTime.sort((a, b) => {
    const at = Number.isFinite(a.ms) ? a.ms : Number.NEGATIVE_INFINITY;
    const bt = Number.isFinite(b.ms) ? b.ms : Number.NEGATIVE_INFINITY;
    if (bt !== at) {
      return bt - at; // newest first
    }
    return a.meta.id.localeCompare(b.meta.id); // stable tie-break
  });
  return withTime.map(({ meta, ms }) => ({
    id: meta.id,
    title: meta.title ?? meta.id,
    subtitle: Number.isFinite(ms) ? formatRelativeTime(ms, now) : meta.createdAt,
  }));
}
