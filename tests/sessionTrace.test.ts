import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TRACE_SCHEMA,
  TRACE_VERSION,
  createSessionTraceRecorder,
  readTraceNdjson,
  replayTraceNdjson,
  sanitizeTraceAction,
} from '../src/services/sessionTrace';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function line(seq: number, action: unknown): string {
  return JSON.stringify({
    schema: TRACE_SCHEMA,
    version: TRACE_VERSION,
    seq,
    timestamp: '2026-01-01T00:00:00.000Z',
    sessionId: 'session-a',
    turnId: 'turn-a',
    action,
  });
}

describe('session trace recorder', () => {
  it('queues ordered records with session/turn identity and redacts sensitive payloads', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'juno-trace-'));
    dirs.push(dir);
    let now = 0;
    const recorder = createSessionTraceRecorder({
      sessionId: 'session/a',
      dir,
      clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, now++)),
    });
    recorder.record({ t: 'user-submit', id: 'user-turn-a', text: 'do not persist me' });
    recorder.record({ t: 'turn-start' });
    recorder.record({ t: 'tool-call', toolCallId: 'tc', name: 'request', args: { apiKey: 'secret', query: 'ok' } });
    recorder.record({ t: 'turn-settle' });
    recorder.record({ t: 'notice', text: 'outside a turn' });
    await recorder.close();

    const parsed = readTraceNdjson(await readFile(recorder.path, 'utf8'));
    expect(parsed.issues).toEqual([]);
    expect(parsed.records.map((record) => record.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(parsed.records.map((record) => record.turnId)).toEqual([
      'user-turn-a', 'user-turn-a', 'user-turn-a', 'user-turn-a', null,
    ]);
    expect(JSON.stringify(parsed.records)).not.toContain('do not persist me');
    expect(JSON.stringify(parsed.records)).not.toContain('secret');
    expect(parsed.records[2]?.action).toMatchObject({ args: { apiKey: '[redacted]', query: 'ok' } });
  });

  it('bounds strings and strips resumed transcript payloads', () => {
    expect(sanitizeTraceAction({ t: 'text-delta', id: 'a', delta: 'x'.repeat(5_000) })).toMatchObject({ delta: expect.stringContaining('[truncated') });
    expect(sanitizeTraceAction({ t: 'resume-session', messages: [] })).toEqual({ t: 'resume-session', messages: [] });
  });
});

describe('trace reader and reducer replay', () => {
  it('replays a useful reducer sequence', () => {
    const result = replayTraceNdjson([
      line(0, { t: 'user-submit', id: 'u1', text: '[redacted prompt: 5 chars]' }),
      line(1, { t: 'turn-start' }),
      line(2, { t: 'assistant-start', id: 'a1' }),
      line(3, { t: 'text-delta', id: 'a1', delta: 'hello' }),
      line(4, { t: 'assistant-done', id: 'a1', stopReason: 'end' }),
      line(5, { t: 'turn-settle' }),
    ].join('\n'));
    expect(result.issues).toEqual([]);
    expect(result.applied).toBe(6);
    expect(result.state.phase).toBe('idle');
    expect(result.state.committed).toHaveLength(2);
  });

  it('separates trace corruption, action incompatibility, and reducer failures', () => {
    const result = replayTraceNdjson([
      '{broken',
      line(0, { t: 'future-action' }),
      line(1, { t: 'resume-session', messages: null }),
      line(2, { t: 'notice', text: 'still replays after failures' }),
    ].join('\n'));
    expect(result.issues.map((issue) => issue.kind)).toEqual(['trace', 'action', 'reducer']);
    expect(result.applied).toBe(1);
    expect(result.state.committed.at(-1)?.blocks[0]).toMatchObject({ text: 'still replays after failures' });
  });

  it('rejects non-monotonic records without hiding later valid lines', () => {
    const result = readTraceNdjson([
      line(1, { t: 'notice', text: 'one' }),
      line(1, { t: 'notice', text: 'duplicate' }),
      line(2, { t: 'notice', text: 'two' }),
    ].join('\n'));
    expect(result.records.map((record) => record.seq)).toEqual([1, 2]);
    expect(result.issues).toMatchObject([{ kind: 'trace', line: 2 }]);
  });
});
