import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { token } from './theme';

export interface CrashBoundaryProps {
  readonly children: ReactNode;
  readonly onError: (error: Error) => void;
}

interface CrashBoundaryState {
  readonly error?: Error;
}

/**
 * Last-resort containment for render/lifecycle failures. The callback owns
 * terminal restoration and process teardown; this fallback merely gives Ink a
 * valid final tree while that synchronous restore begins.
 */
export class CrashBoundary extends Component<CrashBoundaryProps, CrashBoundaryState> {
  override state: CrashBoundaryState = {};

  static getDerivedStateFromError(error: Error): CrashBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError(error);
  }

  override render(): ReactNode {
    if (this.state.error !== undefined) {
      return (
        <Box flexDirection="column">
          <Text color={token('toolError')}>juno encountered a fatal error</Text>
          <Text color={token('textDim')}>{this.state.error.message}</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
