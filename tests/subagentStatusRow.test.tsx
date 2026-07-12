// tests/subagentStatusRow.test.tsx
// LANE B (wave-8 agent-ui) — the per-agent status row that replaced the dim `↓ agents`
// pointer, plus the condensed Agent card + content-block result unwrap. Render tests assert
// the clean presentation AND, critically, that NO raw JSON blob leaks into a frame.
import { render } from 'ink-testing-library';
import { describe, expect, it, afterEach } from 'vitest';
import { SubagentStatusRow } from '../src/ui/SubagentStatusRow';
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
