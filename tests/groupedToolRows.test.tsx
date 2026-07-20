// tests/groupedToolRows.test.tsx
// Grouped-tool-rows — the live/condensed presentation of a concurrent tool batch. Render tests
// assert the two lifecycle forms (expanded live group vs. condensed committed line), the agents-
// panel glyph language, that a failure ALWAYS carries its reason, and — critically — that NO raw
// JSON blob leaks onto any row (args/results condensed exactly like every other tool card).
import { act } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, afterEach } from 'vitest';
import { GroupedToolRows, type GroupedToolEntry } from '../src/ui/GroupedToolRows';
import { Message } from '../src/ui/Message';
import { Transcript } from '../src/ui/Transcript';
import { initialState, reducer, type Msg, type ToolState } from '../src/core/reducer';
import { setActiveTheme } from '../src/ui/theme';
import { SPINNER_DOTS_FRAMES, TOOL_PENDING, RUNNING_HALF } from '../src/ui/glyphs';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
/** Let <Static>'s useLayoutEffect settle so the committed items are in the captured frame. */
async function flushStatic(): Promise<void> {
  await act(async () => {
    await tick();
  });
}

afterEach(() => setActiveTheme('dark'));

const THEMES = ['dark', 'light'] as const;
const CLOCK = () => 1000;

const entry = (
  toolCallId: string,
  name: string,
  status: ToolState['status'],
  over: Partial<ToolState> = {},
): GroupedToolEntry => ({
  toolCallId,
  tool: { status, name, args: {}, ...over },
});

// ---------------------------------------------------------------------------
// LIVE (expanded) — header + one status row per member
// ---------------------------------------------------------------------------

describe('GroupedToolRows — live/expanded', () => {
  it.each(THEMES)('[%s] shows a header count + a row per member while any run', (bg) => {
    setActiveTheme(bg);
    const entries = [
      entry('t1', 'grep', 'running', { args: { pattern: 'juno' } }),
      entry('t2', 'glob', 'pending', { args: { pattern: 'src/**' } }),
      entry('t3', 'read_file', 'result', { args: { path: 'app.tsx' }, result: 'export default App' }),
    ];
    const frame = render(<GroupedToolRows entries={entries} depth="ansi16" columns={100} now={CLOCK} />).lastFrame() ?? '';
    // Header: the batch count + TRUTHFUL buckets (not yet settled). The pending member is
    // `queued`, never folded into `running` — the rows below show 1 spinner + 1 pending glyph.
    expect(frame).toContain('3 tools');
    expect(frame).toContain('1 running, 1 queued, 1 done');
    // One row per member — condensed name(args), never a raw JSON args blob.
    expect(frame).toContain('Searching for “juno”');
    expect(frame).toContain('Finding src/**');
    expect(frame).toContain('Reading app.tsx');
    expect(frame).not.toContain('{"');
    expect(frame).not.toContain('"pattern"');
    // The settled member already shows its check; the batch is still live so no condensed line.
    expect(frame).toContain('✓');
    // The queued member (glob) renders the unified ● (TOOL_PENDING), NEVER the running ◐:
    // this lane dropped the surface's legacy ◐-for-queued override.
    const globRow = frame.split('\n').find((l) => l.includes('Finding src/**')) ?? '';
    expect(globRow).toContain(TOOL_PENDING); // ●
    expect(globRow).not.toContain(RUNNING_HALF); // not ◐
  });

  it('header reports the SEQUENTIAL-execution state truthfully: 1 running + 2 pending is never "3 running"', () => {
    // The raw-API executor runs a batch one call at a time after all land pending — the exact
    // state the old inFlight fold misreported as "3 running" over rows showing ONE spinner.
    const entries = [
      entry('t1', 'grep', 'running'),
      entry('t2', 'glob', 'pending'),
      entry('t3', 'read_file', 'pending'),
    ];
    const frame = render(<GroupedToolRows entries={entries} depth="ansi16" columns={100} now={CLOCK} />).lastFrame() ?? '';
    expect(frame).toContain('1 running, 2 queued');
    expect(frame).not.toContain('3 running');
    expect(frame).not.toContain('2 running');
  });

  it('a permission-gated member presents as waiting (amber ◌ + reason), never running or queued', () => {
    // Honest state mapping parity with the solo card (ToolCallCard renders a gated tool as
    // `waiting on permission`, never running): the grouped row and the header must agree.
    const entries = [
      entry('t1', 'grep', 'running'),
      entry('t2', 'glob', 'pending'),
      entry('t3', 'write_file', 'pending', { args: { path: 'x.txt' } }),
    ];
    const frame = render(
      <GroupedToolRows
        entries={entries}
        depth="ansi16"
        columns={100}
        pendingPermissionToolCallId="t3"
        now={CLOCK}
      />,
    ).lastFrame() ?? '';
    // Header: the gated member gets its own truthful bucket — not counted running, not queued.
    expect(frame).toContain('1 running, 1 queued, 1 waiting on permission');
    expect(frame).not.toContain('2 queued');
    expect(frame).not.toContain('2 running');
    // Row: the ◌ waiting glyph + the amber `waiting on permission` detail on the gated member.
    const row = frame.split('\n').find((line) => line.includes('Writing x.txt')) ?? '';
    expect(row).toContain('◌');
    expect(row).toContain('Writing x.txt');
    expect(row).toContain('waiting on permission');
  });

  it('shows elapsed on a running row (fixed clock ⇒ deterministic)', () => {
    const entries = [entry('t1', 'grep', 'running'), entry('t2', 'glob', 'running')];
    const frame = render(<GroupedToolRows entries={entries} depth="ansi16" columns={100} now={CLOCK} />).lastFrame() ?? '';
    expect(frame).toContain('0s');
    expect(frame).toContain('2 running');
  });

  it('surfaces a FAILED member row with its reason (agents-panel error idiom)', () => {
    const entries = [
      entry('t1', 'grep', 'running'),
      entry('t2', 'mcp__brain__recall', 'error', { args: { query: 'state' }, error: 'server unreachable' }),
    ];
    const frame = render(<GroupedToolRows entries={entries} depth="ansi16" columns={100} now={CLOCK} />).lastFrame() ?? '';
    expect(frame).toContain('Calling brain.recall');
    expect(frame).toContain('server unreachable');
    expect(frame).toContain('✗');
  });

  it('a mid-batch DECLINED member renders its own ⊘ row + a `declined` header bucket, never ✗ (item 1)', () => {
    // A policy-deny can land ONE member `declined` while a sibling still runs — it appears in the
    // expanded (not-yet-settled) view with the neutral ⊘, and the header counts it `declined`.
    const entries = [
      entry('t1', 'grep', 'running'),
      entry('t2', 'write_file', 'error', { args: { path: 'secret.txt' }, error: 'denied by policy' }),
    ];
    const frame = render(<GroupedToolRows entries={entries} depth="ansi16" columns={100} now={CLOCK} />).lastFrame() ?? '';
    expect(frame).toContain('Writing secret.txt');
    expect(frame).toContain('denied by policy');
    expect(frame).toContain('⊘');
    expect(frame).toContain('1 declined');
    // A decline is NOT a failure: no red cross, no "failed" count anywhere.
    expect(frame).not.toContain('✗');
    expect(frame).not.toContain('failed');
  });

  it('windows to the newest maxRows with an `↑ N earlier` head', () => {
    const entries = Array.from({ length: 6 }, (_, i) => entry(`t${i}`, `tool${i}`, 'running'));
    const frame = render(
      <GroupedToolRows entries={entries} depth="ansi16" columns={100} maxRows={3} now={CLOCK} />,
    ).lastFrame() ?? '';
    expect(frame).toContain('6 tools');
    expect(frame).toContain('↑ 3 earlier');
    // Newest three rows are shown; the oldest are behind the head.
    expect(frame).toContain('tool5');
    expect(frame).not.toContain('tool0(');
  });

  it('shows a STATIC ◌ header (no spinner) when nothing runs and the batch is blocked on a permission decision', () => {
    // Honest header glyph (parity with LiveTurn / the solo card): one member already settled,
    // the only non-terminal member is gated behind an open prompt — nothing is executing, so the
    // header must present the static amber ◌, never a spinner (which implies work in flight).
    const entries = [
      entry('t1', 'grep', 'result', { result: 'ok' }),
      entry('t2', 'write_file', 'pending', { args: { path: 'x.txt' } }),
    ];
    const frame = render(
      <GroupedToolRows
        entries={entries}
        depth="ansi16"
        columns={100}
        pendingPermissionToolCallId="t2"
        now={CLOCK}
      />,
    ).lastFrame() ?? '';
    const header = frame.split('\n')[0] ?? '';
    expect(header).toContain('◌');
    expect(header).toContain('2 tools');
    expect(header).toContain('1 waiting on permission');
    // A pure glyph swap: NO braille spinner frame anywhere in the group (header or rows).
    for (const f of SPINNER_DOTS_FRAMES) expect(frame).not.toContain(f);
  });

  it('keeps the static ◌ header when a member FAILED but the batch is still blocked on the user', () => {
    // Edge case: waiting > 0 alongside failed > 0 is still blocked on the user — static ◌,
    // never a spinner. (The header tint may be the error colour; the glyph is still the ◌.)
    const entries = [
      entry('t1', 'grep', 'error', { error: 'boom' }),
      entry('t2', 'write_file', 'pending', { args: { path: 'x.txt' } }),
    ];
    const frame = render(
      <GroupedToolRows
        entries={entries}
        depth="ansi16"
        columns={100}
        pendingPermissionToolCallId="t2"
        now={CLOCK}
      />,
    ).lastFrame() ?? '';
    const header = frame.split('\n')[0] ?? '';
    expect(header).toContain('◌');
    for (const f of SPINNER_DOTS_FRAMES) expect(frame).not.toContain(f);
  });

  it('keeps the SPINNER header while a member is actually running (even with a gated sibling)', () => {
    // The moment any member is running (or queued), work IS in flight — the header spins again,
    // and the ◌ belongs only to the gated member's own row, not the header.
    const entries = [
      entry('t1', 'grep', 'running'),
      entry('t2', 'write_file', 'pending', { args: { path: 'x.txt' } }),
    ];
    const frame = render(
      <GroupedToolRows
        entries={entries}
        depth="ansi16"
        columns={100}
        pendingPermissionToolCallId="t2"
        now={CLOCK}
      />,
    ).lastFrame() ?? '';
    const header = frame.split('\n')[0] ?? '';
    // The header carries a braille spinner frame, not the static ◌.
    expect(SPINNER_DOTS_FRAMES.some((f) => header.includes(f))).toBe(true);
    expect(header).not.toContain('◌');
    expect(header).toContain('1 running, 1 waiting on permission');
  });

  it('clips a member row to the terminal width (never wraps) at a narrow width', () => {
    const entries = [
      entry('t1', 'grep', 'running', { args: { pattern: 'a-very-long-search-pattern-that-would-overflow-a-narrow-pane' } }),
      entry('t2', 'glob', 'running'),
    ];
    const frame = render(<GroupedToolRows entries={entries} depth="ansi16" columns={28} now={CLOCK} />).lastFrame() ?? '';
    for (const line of frame.split('\n')) {
      // No row exceeds the 28-col pane (clipped in display cells, 1 col slack).
      expect(line.length).toBeLessThanOrEqual(28);
    }
  });
});

// ---------------------------------------------------------------------------
// SETTLED — one condensed committed line
// ---------------------------------------------------------------------------

describe('GroupedToolRows — settled/condensed', () => {
  it.each(THEMES)('[%s] condenses an all-ok batch to `✓ N tools · names`', (bg) => {
    setActiveTheme(bg);
    const entries = [
      entry('t1', 'grep', 'result', { result: 'ok' }),
      entry('t2', 'glob', 'result', { result: 'ok' }),
      entry('t3', 'read_file', 'result', { result: 'ok' }),
    ];
    const frame = render(<GroupedToolRows entries={entries} depth="ansi16" columns={100} now={CLOCK} />).lastFrame() ?? '';
    expect(frame).toContain('✓');
    expect(frame).toContain('3 tools');
    expect(frame).toContain('completed');
    // Condensed: NO spinner header line, no per-row detail flood.
    expect(frame).not.toContain('running');
  });

  it('condenses a batch WITH a failure to `✗ N tools · M failed · name: reason` (reason never dropped)', () => {
    const entries = [
      entry('t1', 'grep', 'result', { result: 'ok' }),
      entry('t2', 'mcp__brain__recall', 'error', { error: 'server unreachable' }),
    ];
    const frame = render(<GroupedToolRows entries={entries} depth="ansi16" columns={100} now={CLOCK} />).lastFrame() ?? '';
    expect(frame).toContain('✗');
    expect(frame).toContain('2 tools');
    expect(frame).toContain('1 failed');
    expect(frame).toContain('mcp__brain__recall');
    expect(frame).toContain('server unreachable');
  });

  it('tags the condensed line ` · via codex cli` for a codex-cli backend, never `via claude cli`', () => {
    // Via-CLI parity with the solo ToolCallCard: a delegate-CLI batch's condensed committed
    // line carries the truthful runtime tag; a codex batch is never misattributed to claude.
    const entries = [
      entry('t1', 'Grep', 'result', { result: 'ok' }),
      entry('t2', 'Read', 'result', { result: 'ok' }),
    ];
    const frame =
      render(
        <GroupedToolRows
          entries={entries}
          depth="ansi16"
          columns={100}
          providerKind="codex-cli"
          now={CLOCK}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('via codex cli');
    expect(frame).not.toContain('via claude cli');
    // Still the condensed committed form (not the expanded live one).
    expect(frame).toContain('✓');
    expect(frame).toContain('2 tools');
  });

  it('leaves the condensed line UNMARKED on the raw-API path (providerKind undefined)', () => {
    // `api`/undefined backends run juno's OWN executor — those tool lines are unmarked, so the
    // grouped condensed line must carry no `via … cli` tag (parity with the solo card).
    const entries = [
      entry('t1', 'grep', 'result', { result: 'ok' }),
      entry('t2', 'glob', 'result', { result: 'ok' }),
    ];
    const frame =
      render(<GroupedToolRows entries={entries} depth="ansi16" columns={100} now={CLOCK} />).lastFrame() ?? '';
    expect(frame).not.toContain('via');
    expect(frame).not.toContain('cli');
    expect(frame).toContain('2 tools');
  });

  it('condenses an ALL-ABORTED batch to `⊘ N tools · cancelled` — never ✗, never a failed count (item 1)', () => {
    const entries = [
      entry('t1', 'shell', 'error', { error: 'interrupted' }),
      entry('t2', 'grep', 'error', { error: 'interrupted' }),
      entry('t3', 'read_file', 'error', { error: 'interrupted' }),
    ];
    const frame = render(<GroupedToolRows entries={entries} depth="ansi16" columns={100} now={CLOCK} />).lastFrame() ?? '';
    expect(frame).toContain('⊘');
    expect(frame).toContain('3 tools');
    expect(frame).toContain('cancelled');
    // A cancelled batch is not a crash: never the red cross nor a "failed" count.
    expect(frame).not.toContain('✗');
    expect(frame).not.toContain('failed');
  });

  it('condenses an ALL-DECLINED batch with the `declined` word (all members neutral ⇒ bare word)', () => {
    const entries = [
      entry('t1', 'write_file', 'error', { error: 'denied' }),
      entry('t2', 'shell', 'error', { error: 'denied by policy' }),
    ];
    const frame = render(<GroupedToolRows entries={entries} depth="ansi16" columns={100} now={CLOCK} />).lastFrame() ?? '';
    expect(frame).toContain('⊘');
    expect(frame).toContain('2 tools');
    expect(frame).toContain('declined');
    expect(frame).not.toContain('✗');
    expect(frame).not.toContain('failed');
  });

  it('a mixed done + cancelled settled batch reads `⊘ N tools · M cancelled`, not ✗', () => {
    const entries = [
      entry('t1', 'read_file', 'result', { result: 'ok' }),
      entry('t2', 'shell', 'error', { error: 'interrupted' }),
    ];
    const frame = render(<GroupedToolRows entries={entries} depth="ansi16" columns={100} now={CLOCK} />).lastFrame() ?? '';
    expect(frame).toContain('⊘');
    expect(frame).toContain('2 tools');
    expect(frame).toContain('1 cancelled');
    expect(frame).not.toContain('✗');
  });

  it('a failure alongside a cancel STILL condenses to the red ✗ failure line (failure outranks cancel)', () => {
    const entries = [
      entry('t1', 'grep', 'error', { error: 'boom' }),
      entry('t2', 'shell', 'error', { error: 'interrupted' }),
    ];
    const frame = render(<GroupedToolRows entries={entries} depth="ansi16" columns={100} now={CLOCK} />).lastFrame() ?? '';
    expect(frame).toContain('✗');
    expect(frame).toContain('1 failed');
    expect(frame).toContain('boom');
  });

  it('renders nothing for an empty group (defensive)', () => {
    const frame = render(<GroupedToolRows entries={[]} depth="ansi16" columns={100} now={CLOCK} />).lastFrame() ?? '';
    expect(frame.trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// W5 item 2 — the COMMITTED condensed group clips at the columns threaded through
// <Transcript>, not a fixed FALLBACK_WIDTH. A group clipped LIVE at the real width
// must not re-clip (reflow) once committed to <Static> when the terminal is narrower
// than the 120-col fallback — the append-only invariant at the commit boundary.
// ---------------------------------------------------------------------------

/** A committed assistant message whose ONE block-group is a settled concurrent tool batch.
 *  Five distinct tool NAMES chosen so the condensed `✓ 5 tools · <names>` line (≈94 cells)
 *  OVERFLOWS the 90-col clip (its name list is dropped to fit) but sits well inside BOTH the
 *  120-col fallback AND ink-testing-library's 100-col render surface — so the fallback line is a
 *  single un-wrapped row, the exact regime the commit-boundary reflow bug lived in. */
function committedConcurrentGroup(): Msg {
  const names = [
    'grep_the_sources',
    'glob_all_files',
    'read_entrypoint',
    'list_directory',
    'search_the_docs',
  ];
  let s = initialState();
  s = reducer(s, { t: 'assistant-start', id: 'm1' });
  // All five issued BEFORE any settles → one concurrency batch (each later call sees the
  // earlier ones still non-terminal), and they are adjacent top-level plain tools → grouped.
  names.forEach((name, i) => {
    s = reducer(s, { t: 'tool-call', toolCallId: `tc${i}`, name, args: {} });
  });
  names.forEach((_, i) => {
    s = reducer(s, { t: 'tool-status', toolCallId: `tc${i}`, status: 'result', result: 'ok' });
  });
  s = reducer(s, { t: 'assistant-done', id: 'm1', stopReason: 'end' });
  return s.committed.at(-1)!;
}

/** The condensed group line (`✓ 5 tools · …`) out of a rendered frame. */
const groupLine = (frame: string): string => frame.split('\n').find((l) => l.includes('5 tools')) ?? '';

describe('GroupedToolRows — committed condensed line honors the threaded columns (item 2)', () => {
  it('clips IDENTICALLY on the Message and Transcript paths at columns=90 (no reflow at the commit boundary)', async () => {
    const msg = committedConcurrentGroup();
    const viaMessage = render(<Message msg={msg} depth="ansi16" columns={90} />).lastFrame() ?? '';
    const tr = render(<Transcript committed={[msg]} epoch={0} depth="ansi16" columns={90} />);
    await flushStatic();
    const viaTranscript = tr.lastFrame() ?? '';
    const mLine = groupLine(viaMessage);
    const tLine = groupLine(viaTranscript);
    expect(mLine).toContain('5 tools');
    expect(tLine).toContain('5 tools');
    // The committed Transcript line is byte-identical to the columns-threaded Message line.
    expect(tLine).toBe(mLine);
  });

  it('omitting columns on <Transcript> falls back to FALLBACK_WIDTH=120 — a different, wider clip (regression)', async () => {
    const msg = committedConcurrentGroup();
    const at90 = groupLine(render(<Message msg={msg} depth="ansi16" columns={90} />).lastFrame() ?? '');
    const at120 = groupLine(render(<Message msg={msg} depth="ansi16" columns={120} />).lastFrame() ?? '');
    const trNoCols = render(<Transcript committed={[msg]} epoch={0} depth="ansi16" />);
    await flushStatic();
    const fallback = groupLine(trNoCols.lastFrame() ?? '');
    // The width-less committed path uses the 120-col fallback (identical to a columns=120 render) …
    expect(fallback).toBe(at120);
    // … whose wider clip keeps the last name in full, where columns=90 drops it — proving the
    // threaded width actually tightened the committed clip (no silent 120-col re-clip).
    expect(fallback).toContain('completed');
    expect(at90).toContain('completed');
  });
});
