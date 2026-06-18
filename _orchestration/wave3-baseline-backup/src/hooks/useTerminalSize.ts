// src/hooks/useTerminalSize.ts
// W6 — track the terminal dimensions via Ink's stdout, updating on 'resize'.
import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();

  const readSize = (): TerminalSize => ({
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  });

  const [size, setSize] = useState<TerminalSize>(() => readSize());

  useEffect(() => {
    const onResize = (): void => {
      setSize(readSize());
    };

    stdout.on('resize', onResize);
    onResize();

    return () => {
      stdout.off('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout]);

  return size;
}
