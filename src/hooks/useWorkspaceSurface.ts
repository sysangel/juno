import { useCallback, useEffect, useMemo, useState } from 'react';
import { createAlternateScreenController } from '../ui/alternateScreen';

export type WorkspaceSurfacePhase = 'chat' | 'entering' | 'workspace' | 'leaving';

export interface WorkspaceSurface {
  readonly phase: WorkspaceSurfacePhase;
  readonly blanking: boolean;
  readonly open: () => void;
  readonly close: () => void;
}

export interface WorkspaceSurfaceOptions {
  readonly write?: (data: string) => void;
  readonly isTTY?: boolean;
  /** One Ink render interval gives the blank frame time to physically flush. */
  readonly settleMs?: number;
}

const writeStdout = (data: string): void => {
  process.stdout.write(data);
};

/**
 * Route between persistent chat scrollback and the full-screen workspace.
 * Entering/leaving deliberately render a blank frame before the terminal buffer
 * switch; this resets Ink's cached last output on the buffer that is about to be
 * hidden and prevents chat/workspace frames leaking into one another.
 */
export function useWorkspaceSurface(options: WorkspaceSurfaceOptions = {}): WorkspaceSurface {
  const [phase, setPhase] = useState<WorkspaceSurfacePhase>('chat');
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;
  const write = options.write ?? writeStdout;
  const settleMs = options.settleMs ?? 40;
  const controller = useMemo(
    () => createAlternateScreenController(write, isTTY),
    [write, isTTY],
  );

  useEffect(() => {
    if (phase !== 'entering' && phase !== 'leaving') return;
    const timer = setTimeout(() => {
      if (phase === 'entering') {
        controller.enter();
        setPhase('workspace');
      } else {
        controller.exit();
        setPhase('chat');
      }
    }, isTTY ? settleMs : 0);
    return () => clearTimeout(timer);
  }, [controller, isTTY, phase, settleMs]);

  useEffect(() => () => controller.exit(), [controller]);

  const open = useCallback((): void => {
    setPhase((current) => current === 'chat' ? 'entering' : current);
  }, []);
  const close = useCallback((): void => {
    setPhase((current) => current === 'workspace' ? 'leaving' : current);
  }, []);

  return {
    phase,
    blanking: phase === 'entering' || phase === 'leaving',
    open,
    close,
  };
}
