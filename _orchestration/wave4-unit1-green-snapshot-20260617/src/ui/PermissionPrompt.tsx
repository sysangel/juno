import { Box, Text, useInput } from 'ink';
import { useRef } from 'react';
import type { ReactElement } from 'react';
import type { PermissionDecision, RiskLevel } from '../core/events';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

export interface PermissionRequest {
  toolCallId: string;
  name: string;
  args: unknown;
  risk: RiskLevel;
}

export interface PermissionPromptProps {
  request: PermissionRequest;
  onDecision: (d: PermissionDecision) => void;
}

/** Risk -> tint token. Exhaustive over RiskLevel ('safe' | 'risky' | 'dangerous'). */
function riskToken(risk: RiskLevel): FlatTokenName {
  switch (risk) {
    case 'safe':
      return 'success';
    case 'risky':
      return 'warning';
    case 'dangerous':
      return 'error';
  }
}

/** Narrow `unknown` args to a compact one-line string for display. */
function compact(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const s = JSON.stringify(value) ?? '[unserializable]';
    return s;
  } catch {
    return '[unserializable]';
  }
}

/** Map a keystroke to a decision, or null if it is not a binding. */
function keyToDecision(input: string): PermissionDecision | null {
  switch (input) {
    case 'y':
      return 'allow-once';
    case 'a':
      return 'always-allow-pattern';
    case 'd':
      return 'deny';
    case '!':
      return 'dangerous-bypass';
    default:
      return null;
  }
}

export function PermissionPrompt({ request, onDecision }: PermissionPromptProps): ReactElement {
  const decidedRef = useRef(false);

  useInput((input) => {
    if (decidedRef.current) return;
    const decision = keyToDecision(input);
    if (decision !== null) {
      decidedRef.current = true;
      onDecision(decision);
    }
  });

  const color = token(riskToken(request.risk), DEPTH);
  const args = compact(request.args);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingLeft={1} paddingRight={1}>
      <Text color={color} bold>
        ⚠ permission required
      </Text>
      <Box gap={1}>
        <Text color={token('text', DEPTH)} bold>
          {request.name}
        </Text>
        <Text color={token('textDim', DEPTH)}>risk:</Text>
        <Text color={color} bold>
          {request.risk}
        </Text>
      </Box>
      {args.length > 0 ? <Text color={token('textDim', DEPTH)}>{args}</Text> : null}
      <Text color={token('text', DEPTH)}>
        [y] allow once   [a] always allow   [d] deny   [!] dangerous bypass
      </Text>
    </Box>
  );
}
