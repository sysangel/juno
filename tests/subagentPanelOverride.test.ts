// tests/subagentPanelOverride.test.ts — Wave 13 (lane 1): the agents-panel
// status override. The non-blocking tool settles the spawn card to 'result'
// immediately, so selectSubagents rolls a still-running background agent up as
// 'done'; the runner's live task status is authoritative and overrides it — WITHOUT
// re-dispatching a 'running' tool-status (which would re-pin the spinner).
import { describe, expect, it } from 'vitest';
import { overrideSubagentStatus } from '../src/hooks/useSubagentPanel';
import type { SubagentEntry } from '../src/core/selectors';

function entry(id: string, status: SubagentEntry['status']): SubagentEntry {
  return {
    id,
    name: 'spawn_subagent',
    description: id,
    status,
    childCount: 0,
    runningLabel: 'working…',
  };
}

describe('overrideSubagentStatus', () => {
  it('overrides a settled entry to the runner status by matching id', () => {
    const entries = [entry('a', 'done'), entry('b', 'done')];
    const out = overrideSubagentStatus(entries, { a: 'running' });
    expect(out.find((e) => e.id === 'a')?.status).toBe('running');
    expect(out.find((e) => e.id === 'b')?.status).toBe('done'); // untouched
  });

  it('reflects a completed task (running → done/error) once the runner transitions', () => {
    const entries = [entry('a', 'done')];
    expect(overrideSubagentStatus(entries, { a: 'error' })[0]?.status).toBe('error');
    expect(overrideSubagentStatus(entries, { a: 'done' })[0]?.status).toBe('done');
  });

  it('returns the SAME array ref when nothing changes (memo bail-out preserved)', () => {
    const entries = [entry('a', 'running'), entry('b', 'done')];
    // undefined override, no matching id, and a same-status match all no-op.
    expect(overrideSubagentStatus(entries, undefined)).toBe(entries);
    expect(overrideSubagentStatus(entries, { z: 'running' })).toBe(entries);
    expect(overrideSubagentStatus(entries, { a: 'running', b: 'done' })).toBe(entries);
  });

  it('leaves entries with no runner task (native subagents) untouched', () => {
    const entries = [entry('native', 'done')];
    const out = overrideSubagentStatus(entries, { other: 'running' });
    expect(out).toBe(entries);
    expect(out[0]?.status).toBe('done');
  });

  it('folds runner timing into the same immutable projection', () => {
    const entries = [entry('timed', 'running')];
    const out = overrideSubagentStatus(entries, undefined, {
      timed: { startedAt: 1_000, lastActivityAt: 5_000 },
    });
    expect(out[0]).toMatchObject({ startedAt: 1_000, lastActivityAt: 5_000 });
    expect(overrideSubagentStatus(out, undefined, {
      timed: { startedAt: 1_000, lastActivityAt: 5_000 },
    })).toBe(out);
  });

  it('preserves references for entries absent from a partial timing snapshot', () => {
    const entries = [
      { ...entry('known', 'running'), startedAt: 1_000 },
      entry('other', 'running'),
    ];
    const out = overrideSubagentStatus(entries, undefined, {
      other: { startedAt: 2_000 },
    });
    expect(out[0]).toBe(entries[0]);
    expect(out[1]).not.toBe(entries[1]);
  });
});
