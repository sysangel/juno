// tests/mcpPanel.test.tsx
// Wave 5 item 1 — the `/mcp` status overlay. Ink render tests (pattern
// tests/statusStrip.test.tsx) asserting the panel renders the fleet snapshot: the
// resolved per-server rows with risk-tagged tools, the mid-connect "connecting…"
// state (must NOT crash and must NOT show the premature all-failed rows), and the
// no-servers-configured empty state. A fixed color depth keeps the frame stable.
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import type { McpServerStatus } from '../src/services/mcpManager';
import { McpPanel } from '../src/ui/McpPanel';

const FLEET: McpServerStatus[] = [
  {
    server: 'brain',
    state: 'connected',
    toolCount: 3,
    tools: [
      { name: 'get_episode', risk: 'safe' },
      { name: 'recall', risk: 'safe' },
      { name: 'remember', risk: 'risky' },
    ],
  },
  { server: 'weather', state: 'failed', toolCount: 0, tools: [] },
];

describe('McpPanel (/mcp status overlay)', () => {
  it('renders each server with its state, tool count, and risk-tagged tools', () => {
    const frame = render(<McpPanel connectionState="partial" servers={FLEET} depth="truecolor" />).lastFrame() ?? '';
    expect(frame).toContain('mcp servers');
    // Connected server: name, connected label with tool count, and each tool + risk.
    expect(frame).toContain('brain');
    expect(frame).toContain('connected');
    expect(frame).toContain('3 tools');
    expect(frame).toContain('recall');
    expect(frame).toContain('get_episode');
    expect(frame).toContain('remember');
    expect(frame).toContain('safe');
    expect(frame).toContain('risky');
    // Failed server: name + failed label, no tools.
    expect(frame).toContain('weather');
    expect(frame).toContain('failed');
    // Markers for connected vs failed.
    expect(frame).toContain('✓');
    expect(frame).toContain('✗');
  });

  it('singularizes the tool-count label for a one-tool server', () => {
    const one: McpServerStatus[] = [
      { server: 'solo', state: 'connected', toolCount: 1, tools: [{ name: 'ping', risk: 'dangerous' }] },
    ];
    const frame = render(<McpPanel connectionState="ready" servers={one} depth="truecolor" />).lastFrame() ?? '';
    expect(frame).toContain('1 tool');
    expect(frame).not.toContain('1 tools');
  });

  it('shows a connecting state (not the premature failed rows) while the fleet connects', () => {
    // Mid-connect the manager snapshot reads all-failed; the panel must override that
    // with a connecting line and list the server names WITHOUT a failed label or tools.
    const connecting: McpServerStatus[] = [
      { server: 'brain', state: 'failed', toolCount: 0, tools: [] },
      { server: 'weather', state: 'failed', toolCount: 0, tools: [] },
    ];
    const frame = render(<McpPanel connectionState="connecting" servers={connecting} depth="truecolor" />).lastFrame() ?? '';
    expect(frame).toContain('mcp servers');
    expect(frame).toContain('connecting…');
    expect(frame).toContain('brain');
    expect(frame).toContain('weather');
    // No premature failure verdict, no ✗ marker mid-connect.
    expect(frame).not.toContain('failed');
    expect(frame).not.toContain('✗');
  });

  it('shows the empty state when no MCP servers are configured', () => {
    const frame = render(<McpPanel connectionState="none" servers={[]} depth="truecolor" />).lastFrame() ?? '';
    expect(frame).toContain('mcp servers');
    expect(frame).toContain('No MCP servers configured.');
  });
});
