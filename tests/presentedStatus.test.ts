// tests/presentedStatus.test.ts
// Wave-14 a1 (lifecycle-core): the ONE lifecycle classifier + its deny predicate + the
// single-status display vocabulary. Pure — no render. This is the regression floor for the
// abort/deny split and the waiting/queued precedence every surface now routes through.
import { describe, expect, it } from 'vitest';
import {
  presentedStatus,
  presentedStatusLabel,
  type PresentedStatus,
} from '../src/core/selectors';
import {
  isAbortReason,
  isDenyReason,
  ABORTED_NOTICE,
  DENIED,
  DENIED_BY_POLICY,
  INTERRUPTED_NOTICE,
  SUBAGENT_ABORTED,
} from '../src/core/abort';
import {
  presentedStatusToken,
  isWholeLinePresented,
} from '../src/ui/glyphs';
import type { ToolState } from '../src/core/reducer';

/** A minimal tool for the classifier (it reads only status + error). */
function t(status: ToolState['status'], error?: string): Pick<ToolState, 'status' | 'error'> {
  return error !== undefined ? { status, error } : { status };
}

describe('presentedStatus — the one lifecycle classifier', () => {
  it('maps the settled-ok / running / pending base cases without a flag', () => {
    expect(presentedStatus(t('result'))).toBe('done');
    expect(presentedStatus(t('running'))).toBe('running');
    expect(presentedStatus(t('pending'))).toBe('queued');
  });

  it('waiting precedence: an OPEN permission prompt turns pending AND running into waiting', () => {
    expect(presentedStatus(t('pending'), { waitingOnPermission: true })).toBe('waiting');
    expect(presentedStatus(t('running'), { waitingOnPermission: true })).toBe('waiting');
  });

  it('settled wins over a stale waiting flag (result/error never present as waiting)', () => {
    expect(presentedStatus(t('result'), { waitingOnPermission: true })).toBe('done');
    expect(presentedStatus(t('error', 'nope'), { waitingOnPermission: true })).toBe('error');
  });

  it('abort split: all three abort markers map error → aborted', () => {
    expect(presentedStatus(t('error', INTERRUPTED_NOTICE))).toBe('aborted');
    expect(presentedStatus(t('error', SUBAGENT_ABORTED))).toBe('aborted');
    // ABORTED_NOTICE ('aborted') is the EXECUTOR's own marker (emitAborted): an entry-gate /
    // mid-hook / post-permission abort persists as { error:'aborted' } (normalizeInterruptedTools
    // leaves a settled error tool untouched) and MUST classify neutral, not as a red failure.
    expect(isAbortReason(ABORTED_NOTICE)).toBe(true);
    expect(presentedStatus(t('error', ABORTED_NOTICE))).toBe('aborted');
    // Even with a trailing newline (normalized-error shape) it still classifies.
    expect(presentedStatus(t('error', `${INTERRUPTED_NOTICE}\n`))).toBe('aborted');
  });

  it('deny split: both deny markers map error → declined', () => {
    expect(presentedStatus(t('error', DENIED))).toBe('declined');
    expect(presentedStatus(t('error', DENIED_BY_POLICY))).toBe('declined');
  });

  it('a genuine failure stays error', () => {
    expect(presentedStatus(t('error', 'boom: connection refused'))).toBe('error');
    expect(presentedStatus(t('error'))).toBe('error');
    // "denied: access" is a genuine error whose text merely CONTAINS "denied" (exact-match guard).
    expect(presentedStatus(t('error', 'denied: access'))).toBe('error');
  });
});

describe('isDenyReason — exact first-line match, sibling of isAbortReason', () => {
  it('matches the two deny markers exactly', () => {
    expect(isDenyReason(DENIED)).toBe(true);
    expect(isDenyReason(DENIED_BY_POLICY)).toBe(true);
  });

  it('matches on the FIRST trimmed line only', () => {
    expect(isDenyReason('denied\nsome trailing detail')).toBe(true);
    expect(isDenyReason('  denied  ')).toBe(true);
  });

  it('undefined and non-deny text are false (never startsWith)', () => {
    expect(isDenyReason(undefined)).toBe(false);
    expect(isDenyReason('denied: access')).toBe(false);
    expect(isDenyReason('permission was denied')).toBe(false);
    expect(isDenyReason('interrupted')).toBe(false);
  });
});

describe('presentedStatusLabel — the single-status display vocabulary', () => {
  it('reads every member as its display word (error → "failed")', () => {
    const table: Record<PresentedStatus, string> = {
      queued: 'queued',
      waiting: 'waiting on permission',
      running: 'running',
      done: 'done',
      error: 'failed',
      aborted: 'aborted',
      declined: 'declined',
    };
    for (const [status, word] of Object.entries(table)) {
      expect(presentedStatusLabel(status as PresentedStatus)).toBe(word);
    }
  });
});

describe('the color/whole-line seam — a deny is amber, distinct from a red crash AND a dim cancel', () => {
  it('presentedStatusToken keeps the three cancel/deny/crash hues distinct', () => {
    // The item-3 core: three DIFFERENT costumes so a user can tell a deliberate deny from an
    // incidental abort from a genuine failure — never the shared red-crash costume they wore before.
    expect(presentedStatusToken('error')).toBe('toolError'); // red — a genuine failure
    expect(presentedStatusToken('aborted')).toBe('textDim'); // dim — an incidental cancel
    expect(presentedStatusToken('declined')).toBe('warning'); // amber — a deliberate deny
    expect(presentedStatusToken('declined')).not.toBe(presentedStatusToken('aborted'));
  });

  it('the full token table is exactly the wave-14 a1 spec', () => {
    const table: Record<PresentedStatus, string> = {
      queued: 'toolPending',
      waiting: 'warning',
      running: 'toolRunning',
      done: 'toolResult',
      error: 'toolError',
      aborted: 'textDim',
      declined: 'warning',
    };
    for (const [status, tk] of Object.entries(table)) {
      expect(presentedStatusToken(status as PresentedStatus)).toBe(tk);
    }
  });

  it('isWholeLinePresented is exactly {error, waiting, declined} — aborted stays NON-whole-line', () => {
    // error/waiting/declined carry their color across the whole row; aborted dims only its
    // glyph/detail and leaves the tool name in default text (it is NOT whole-line-colored).
    expect(isWholeLinePresented('error')).toBe(true);
    expect(isWholeLinePresented('waiting')).toBe(true);
    expect(isWholeLinePresented('declined')).toBe(true);
    expect(isWholeLinePresented('aborted')).toBe(false);
    expect(isWholeLinePresented('done')).toBe(false);
    expect(isWholeLinePresented('running')).toBe(false);
    expect(isWholeLinePresented('queued')).toBe(false);
  });
});
