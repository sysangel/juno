// tests/sessionPersistence.test.ts
// Session Resume — Unit 2C. Pure producer/formatting helpers: title derivation,
// SessionMeta building (exact-optional), and palette-entry mapping.
import { describe, it, expect } from 'vitest';
import type { Msg } from '../src/core/reducer';
import type { SessionMeta } from '../src/services/sessions';
import {
  deriveSessionTitle,
  sessionMetaFor,
  toPaletteEntries,
} from '../src/services/sessionPersistence';

function userMsg(text: string): Msg {
  return { id: 'u1', role: 'user', blocks: [{ kind: 'text', id: 'u1:block:1', text }], done: true };
}

function asstMsg(text: string): Msg {
  return { id: 'a1', role: 'assistant', blocks: [{ kind: 'text', id: 'a1:block:1', text }], done: true };
}

describe('deriveSessionTitle', () => {
  it('uses the first user message text', () => {
    expect(deriveSessionTitle([userMsg('refactor the parser')])).toBe('refactor the parser');
  });

  it('skips leading assistant/system messages and reads the first USER message', () => {
    expect(deriveSessionTitle([asstMsg('hi'), userMsg('the real question')])).toBe('the real question');
  });

  it('concatenates a user message’s multiple text blocks and trims', () => {
    const msg: Msg = {
      id: 'u1',
      role: 'user',
      blocks: [
        { kind: 'text', id: 'u1:block:1', text: '  hello ' },
        { kind: 'text', id: 'u1:block:2', text: 'world  ' },
      ],
      done: true,
    };
    expect(deriveSessionTitle([msg])).toBe('hello world');
  });

  it('truncates past 60 chars with an ellipsis', () => {
    const long = 'x'.repeat(80);
    const title = deriveSessionTitle([userMsg(long)]);
    expect(title).toBe(`${'x'.repeat(60)}…`);
    expect(title!.length).toBe(61); // 60 chars + the single ellipsis glyph
  });

  it('returns undefined when there is no user message', () => {
    expect(deriveSessionTitle([asstMsg('only assistant')])).toBeUndefined();
  });

  it('returns undefined when the first user message has no text (tool-only / empty)', () => {
    const toolOnly: Msg = {
      id: 'u1',
      role: 'user',
      blocks: [{ kind: 'tool', id: 'u1:block:1', toolCallId: 'tc1' }],
      done: true,
    };
    expect(deriveSessionTitle([toolOnly])).toBeUndefined();
    expect(deriveSessionTitle([userMsg('   ')])).toBeUndefined();
  });

  it('returns undefined for an empty transcript', () => {
    expect(deriveSessionTitle([])).toBeUndefined();
  });
});

describe('sessionMetaFor', () => {
  it('builds a full meta with derived title + optional model/cwd', () => {
    const meta = sessionMetaFor({
      id: 's1',
      createdAt: '2026-06-20T10:00:00.000Z',
      model: 'gpt-4.1',
      cwd: '/work',
      messages: [userMsg('do the thing')],
    });
    expect(meta).toEqual({
      id: 's1',
      createdAt: '2026-06-20T10:00:00.000Z',
      model: 'gpt-4.1',
      cwd: '/work',
      title: 'do the thing',
    });
  });

  it('omits title when none can be derived (exact-optional clean)', () => {
    const meta = sessionMetaFor({ id: 's2', createdAt: 'now', messages: [] });
    expect(meta).toEqual({ id: 's2', createdAt: 'now' });
    expect('title' in meta).toBe(false);
  });

  it('omits model/cwd when not supplied', () => {
    const meta = sessionMetaFor({ id: 's3', createdAt: 'now', messages: [userMsg('hi')] });
    expect('model' in meta).toBe(false);
    expect('cwd' in meta).toBe(false);
    expect(meta.title).toBe('hi');
  });
});

describe('toPaletteEntries', () => {
  it('maps metas to entries (title ?? id, subtitle = createdAt) preserving order', () => {
    const metas: SessionMeta[] = [
      { id: 'a', createdAt: '2026-06-20T09:00:00.000Z', title: 'First chat' },
      { id: 'b', createdAt: '2026-06-20T10:00:00.000Z' }, // no title → falls back to id
    ];
    expect(toPaletteEntries(metas)).toEqual([
      { id: 'a', title: 'First chat', subtitle: '2026-06-20T09:00:00.000Z' },
      { id: 'b', title: 'b', subtitle: '2026-06-20T10:00:00.000Z' },
    ]);
  });

  it('maps an empty list to an empty array', () => {
    expect(toPaletteEntries([])).toEqual([]);
  });
});
