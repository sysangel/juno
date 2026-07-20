// src/ui/McpPanel.tsx
// The `/mcp` status overlay (wave 5 item 1). A small READ-ONLY info panel — a
// sibling of the help cheatsheet, NOT another mode of UnifiedCommandPalette —
// that renders the MCP fleet: one row per configured server (connected/failed),
// each listing its discovered tools by name.
//
// The panel must survive being opened mid-connect: MCP `start()` resolves in a
// post-first-paint effect (app.tsx), so `connectionState` can be 'connecting'
// with the per-server rows not yet meaningful. In that window it shows a
// "connecting…" line (listing the configured server names) instead of the
// premature all-'failed' rows the manager snapshot would carry. 'none' (no
// servers configured, or no manager) shows a single empty-state line.
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { McpConnectionState } from '../core/selectors';
import type { McpServerStatus } from '../services/mcpManager';
import { detectColorDepth, token, type ColorDepth } from './theme';
import { OK, FAIL, BULLET } from './glyphs';

const DEPTH: ColorDepth = detectColorDepth();

export interface McpPanelProps {
  /** Overall fleet connection state (from the app's `mcpStatus`), or 'none' when
   * no MCP servers are configured / no manager exists. Drives the connecting and
   * empty states; the per-server rows render only once it has resolved. */
  readonly connectionState: McpConnectionState['state'] | 'none';
  /** Per-server snapshot from `manager.status()`. Empty when 'none'. */
  readonly servers: ReadonlyArray<McpServerStatus>;
  readonly depth?: ColorDepth;
}

export function McpPanel(props: McpPanelProps): ReactElement {
  const d = props.depth ?? DEPTH;
  const border = token('border', d);
  const dim = token('textDim', d);

  let body: ReactElement;
  if (props.connectionState === 'none') {
    body = (
      <Text color={dim}>
        No MCP servers configured.
      </Text>
    );
  } else if (props.connectionState === 'connecting') {
    // Mid-connect: the per-server states are not yet meaningful (all would read
    // 'failed'), so surface a connecting line + the configured server names only.
    const names = props.servers.map((s) => s.server);
    body = (
      <>
        <Text color={dim}>
          connecting…
        </Text>
        {names.map((name) => (
          <Box key={name} gap={1}>
            <Text color={token('warning', d)}>{BULLET}</Text>
            <Text color={token('text', d)}>{name}</Text>
          </Box>
        ))}
      </>
    );
  } else {
    body = (
      <>
        {props.servers.map((server) => {
          const connected = server.state === 'connected';
          return (
            <Box key={server.server} flexDirection="column">
              <Box gap={1}>
                <Text color={connected ? token('success', d) : token('error', d)}>
                  {connected ? OK : FAIL}
                </Text>
                <Text color={token('text', d)} bold>
                  {server.server}
                </Text>
                <Text color={dim}>
                  {connected ? `connected · ${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}` : 'failed'}
                </Text>
              </Box>
              {server.tools.map((tool) => (
                <Box key={tool.name} paddingLeft={2}>
                  <Text color={token('text', d)}>{tool.name}</Text>
                </Box>
              ))}
            </Box>
          );
        })}
      </>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={border} paddingLeft={1} paddingRight={1}>
      <Text color={dim}>mcp servers</Text>
      {body}
    </Box>
  );
}
