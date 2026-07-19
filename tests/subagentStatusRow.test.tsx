// tests/subagentStatusRow.test.tsx
// LANE B (wave-8 agent-ui) — the per-agent status row that replaced the dim `↓ agents`
// pointer, plus the condensed Agent card + content-block result unwrap. Render tests assert
// the clean presentation AND, critically, that NO raw JSON blob leaks into a frame.
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { SubagentStatusRow, subagentRowTokens } from '../src/ui/SubagentStatusRow';
import { ABORTED } from '../src/ui/glyphs';
import { ToolCallCard, humanizeArgs, resultTail, toDisplay } from '../src/ui/ToolCallCard';
import type { ToolState } from '../src/core/reducer';
import { setActiveTheme } from '../src/ui/theme';

afterEach(() => setActiveTheme('dark'));

const THEMES = ['dark', 'light'] as const;

// ---------------------------------------------------------------------------
// SubagentStatusRow — the three lifecycle states
// ---------------------------------------------------------------------------

describe('SubagentStatusRow', () => {
  it.each(THEMES)('[%s] running: spinner + description + model + elapsed, no settled glyph', (bg) => {
    setActiveTheme(bg);
    const frame =
      render(
        <SubagentStatusRow
          status="running"
          description="crunch the repo"
          model="fable-mini"
          nestDepth={1}
          depth="ansi16"
          now={() => 1000}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('crunch the repo');
    expect(frame).toContain('fable-mini');
    // A fixed clock pins elapsed at 0s (deterministic).
    expect(frame).toContain('0s');
    // Running carries neither the done check nor the error cross.
    expect(frame).not.toContain('✓');
    expect(frame).not.toContain('✗');
  });

  it.each(THEMES)('[%s] done: check + description + outcome hint, no elapsed clock', (bg) => {
    setActiveTheme(bg);
    const frame =
      render(
        <SubagentStatusRow
          status="done"
          description="crunch the repo"
          model="fable-mini"
          outcomeHint="all clear"
          nestDepth={1}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('✓');
    expect(frame).toContain('crunch the repo');
    expect(frame).toContain('all clear');
    expect(frame).not.toContain('✗');
    // A settled row has no running clock.
    expect(frame).not.toMatch(/\d+s/);
  });

  it.each(THEMES)('[%s] error: cross + description + reason', (bg) => {
    setActiveTheme(bg);
    const frame =
      render(
        <SubagentStatusRow
          status="error"
          description="crunch the repo"
          reason="spawn failed"
          nestDepth={1}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('✗');
    expect(frame).toContain('crunch the repo');
    expect(frame).toContain('spawn failed');
    expect(frame).not.toContain('✓');
  });

  it.each(THEMES)('[%s] aborted: neutral ⊘ glyph (NOT the ✗ FAIL) + reason, a cancel not a failure', (bg) => {
    setActiveTheme(bg);
    const frame =
      render(
        <SubagentStatusRow
          status="aborted"
          description="crunch the repo"
          reason="interrupted"
          nestDepth={1}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    // The cancel glyph, distinct from the failure cross and the success check.
    expect(frame).toContain(ABORTED);
    expect(ABORTED).toBe('⊘');
    expect(frame).not.toContain('✗');
    expect(frame).not.toContain('✓');
    expect(frame).toContain('crunch the repo');
    // An aborted row still carries WHY-ish text (the abort marker), not a blank.
    expect(frame).toContain('interrupted');
  });

  it('queued: a STATIC ● mark (no spinner, no ticking clock) — a pending spawn is not "running" (item 2)', () => {
    const frame =
      render(
        <SubagentStatusRow
          status="queued"
          description="crunch the repo"
          model="fable-mini"
          nestDepth={1}
          depth="ansi16"
          now={() => 1000}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('●'); // static queued mark
    expect(frame).toContain('crunch the repo');
    // Never the running affordances: no elapsed `· Ns` clock, no settled glyphs.
    expect(frame).not.toMatch(/·\s*\d+s/);
    expect(frame).not.toContain('✓');
    expect(frame).not.toContain('✗');
  });

  it('waiting: amber ◌ + "waiting on permission", no clock (item 2 — gated, not running)', () => {
    const frame =
      render(
        <SubagentStatusRow
          status="waiting"
          description="crunch the repo"
          nestDepth={1}
          depth="ansi16"
          now={() => 1000}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('◌');
    expect(frame).toContain('waiting on permission');
    expect(frame).not.toMatch(/·\s*\d+s/);
    expect(frame).not.toContain('✗');
  });

  it('declined: amber ⊘ + reason (a permission deny — not a failure, not a neutral cancel)', () => {
    const frame =
      render(
        <SubagentStatusRow
          status="declined"
          description="crunch the repo"
          reason="denied"
          nestDepth={1}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain(ABORTED); // ⊘ — glyph shared with aborted; the COLOR (amber) differs
    expect(frame).toContain('denied');
    expect(frame).not.toContain('✗');
    expect(frame).not.toContain('✓');
  });

  it('omits the model / hint / reason segments when they are absent', () => {
    const frame =
      render(
        <SubagentStatusRow status="done" description="bare" nestDepth={1} depth="ansi16" />,
      ).lastFrame() ?? '';
    expect(frame).toContain('bare');
    // No trailing ` · ` separator when there is no model or outcome hint.
    expect(frame).not.toContain('·');
  });
});

// ---------------------------------------------------------------------------
// SubagentStatusRow — the aborted row is coloured a NEUTRAL hue, never the
// toolError red (a cancel must not read as a failure) nor the toolResult green
// (nor as a clean finish). Ink emits no SGR under the test env's supports-color 0,
// so the colour DECISION is asserted at the source: the pure `subagentRowTokens`
// mapping the component renders through.
// ---------------------------------------------------------------------------

describe('SubagentStatusRow — subagentRowTokens (colour decision)', () => {
  it('aborted maps BOTH glyph and text to the neutral textDim — never toolError or toolResult', () => {
    const aborted = subagentRowTokens('aborted');
    expect(aborted).toEqual({ glyph: 'textDim', text: 'textDim' });
    // The whole point: a cancel is not the failure red…
    expect(aborted.glyph).not.toBe('toolError');
    expect(aborted.text).not.toBe('toolError');
    // …and not the success green either.
    expect(aborted.glyph).not.toBe('toolResult');
  });

  it('error still tints the whole line toolError; done keeps the green glyph — regression guard', () => {
    expect(subagentRowTokens('error')).toEqual({ glyph: 'toolError', text: 'toolError' });
    expect(subagentRowTokens('done').glyph).toBe('toolResult');
    // Only the error row is fully red; aborted must differ from it.
    expect(subagentRowTokens('aborted').glyph).not.toBe(subagentRowTokens('error').glyph);
  });

  it('running keeps its cyan glyph over dim text — byte-for-byte with the old hand-rolled map', () => {
    // The wrapper is behaviour-preserving for all four original states.
    expect(subagentRowTokens('running')).toEqual({ glyph: 'toolRunning', text: 'textDim' });
    expect(subagentRowTokens('done')).toEqual({ glyph: 'toolResult', text: 'textDim' });
  });

  it('the three NEW states map correctly: waiting=amber whole-line, queued=pending glyph, declined=amber whole-line', () => {
    // waiting SHOUTS amber across the whole line; queued is a dim pending glyph. `declined` is
    // UNREACHABLE for a subagent row (a spawn card's error is always a genuine failure or an
    // abort marker — never a deny), so this only asserts the shared seam's totality: a deny is
    // amber (`warning`), distinct from a dim abort — never folded into the neutral cancel family.
    expect(subagentRowTokens('waiting')).toEqual({ glyph: 'warning', text: 'warning' });
    expect(subagentRowTokens('queued')).toEqual({ glyph: 'toolPending', text: 'textDim' });
    expect(subagentRowTokens('declined')).toEqual({ glyph: 'warning', text: 'warning' });
  });
});

// ---------------------------------------------------------------------------
// Condensed Agent card — description only, NEVER a raw JSON blob
// ---------------------------------------------------------------------------

describe('ToolCallCard — condensed Agent args (no raw JSON)', () => {
  const agentTool: ToolState = {
    status: 'result',
    name: 'Agent',
    args: {
      description: 'Test subagent spawn',
      prompt: 'You are a subagent. Do a very long thing that must never appear on the card.',
      subagent_type: 'reviewer',
    },
    result: 'ok',
  };

  it('shows only the description field: `Agent(Test subagent spawn)`', () => {
    const frame = render(<ToolCallCard tool={agentTool} depth="ansi16" />).lastFrame() ?? '';
    expect(frame).toContain('Agent(Test subagent spawn)');
    // The prompt / subagent_type / a JSON blob must NOT leak onto the call line.
    expect(frame).not.toContain('prompt');
    expect(frame).not.toContain('very long thing');
    expect(frame).not.toContain('{');
    expect(frame).not.toContain('"description"');
  });

  it('humanizeArgs picks description for Agent/Task/spawn_subagent, falling back task→prompt', () => {
    expect(humanizeArgs('Agent', { description: 'd', prompt: 'p' })).toBe('d');
    expect(humanizeArgs('Task', { prompt: 'only prompt' })).toBe('only prompt');
    expect(humanizeArgs('spawn_subagent', { task: 'do it', model: 'm' })).toBe('do it');
  });
});

// ---------------------------------------------------------------------------
// Content-block result unwrap — clean first line, not `[{"type":"text",…}]`
// ---------------------------------------------------------------------------

describe('resultTail / toDisplay — content-block unwrap', () => {
  it('unwraps a content-block array to its plain text before tailing', () => {
    const value = [{ type: 'text', text: 'Launched agent alpha.\nWaiting on it.' }];
    const { text, hidden } = resultTail(value);
    expect(text).toBe('Launched agent alpha.');
    expect(hidden).toBe(1);
    // No JSON structure anywhere in the display string.
    const display = toDisplay(value);
    expect(display).toBe('Launched agent alpha.\nWaiting on it.');
    expect(display).not.toContain('type');
    expect(display).not.toContain('[{');
  });

  it('joins multiple text blocks with newlines', () => {
    const value = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ];
    expect(toDisplay(value)).toBe('first\nsecond');
  });

  it('leaves a non-content-block array as structured JSON (fallback intact)', () => {
    expect(toDisplay(['a.ts', 'b.ts'])).toBe('["a.ts","b.ts"]');
  });

  it('keeps a subagent content-block result OFF the spawn card (the status row owns it), never as JSON', () => {
    // Contract (finding 1): the spawn card carries NO inline result/error tail — the
    // per-agent SubagentStatusRow beneath it owns the outcome, so the result is never
    // duplicated across two lines nor pushed past the terminal width by the `· via cli`
    // suffix. The card stays a bare `● Agent(spawn)`, and a content-block result never
    // leaks as a `[{"type":…}]` blob onto it.
    const tool: ToolState = {
      status: 'result',
      name: 'Agent',
      args: { description: 'spawn' },
      result: [{ type: 'text', text: 'Launched agent. Report follows.' }],
    };
    const card = render(<ToolCallCard tool={tool} depth="ansi16" />).lastFrame() ?? '';
    expect(card).toContain('Agent(spawn)');
    expect(card).not.toContain('Launched agent. Report follows.'); // carried by the status row, not the card
    expect(card).not.toContain('[{');
    expect(card).not.toContain('"type"');

    // The status row surfaces the SAME content-block result as clean unwrapped text (via
    // resultTail, exactly as Message.tsx wires its outcomeHint) — never a JSON blob.
    const row =
      render(
        <SubagentStatusRow
          status="done"
          description="spawn"
          outcomeHint={resultTail(tool.result).text}
          nestDepth={1}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    expect(row).toContain('Launched agent. Report follows.');
    expect(row).not.toContain('[{');
    expect(row).not.toContain('"type"');
  });
});
