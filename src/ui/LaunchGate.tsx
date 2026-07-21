import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { abbreviateHome } from './paths';
import { clipCells } from './clipText';
import { detectColorDepth, token, type ColorDepth } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

const ORBITS: ReadonlyArray<ReadonlyArray<string>> = [
  [
    '             o',
    '        .---------.',
    "    .--'           '--.",
    '  o       J U N O       .',
    "    '--.           .--'",
    "        '----.----'",
    '             .',
  ],
  [
    '             .',
    '        .---------o',
    "    .--'           '--.",
    '  .       J U N O       o',
    "    '--.           .--'",
    "        '----.----'",
    '             .',
  ],
  [
    '             .',
    '        .---------.',
    "    .--'           '--.",
    '  .       J U N O       .',
    "    '--.           .--'",
    "        o----.----'",
    '             .',
  ],
  [
    '             .',
    '        o---------.',
    "    .--'           '--.",
    '  .       J U N O       .',
    "    '--.           .--'",
    "        '----.----'",
    '             o',
  ],
];

export interface LaunchGateProps {
  readonly children?: ReactNode;
  readonly enabled: boolean;
  readonly version: string;
  readonly model: string;
  readonly cwd: string;
  readonly width?: number;
  readonly rows?: number;
  readonly durationMs?: number;
  readonly frameMs?: number;
  readonly depth?: ColorDepth;
}

/**
 * A short, skippable product-entry sequence. It mounts only after CLI setup has
 * genuinely completed, so every readiness label is a fact rather than simulated
 * progress. Any key enters immediately; Ctrl+C still exits instead of being eaten.
 */
export function LaunchGate(props: LaunchGateProps): ReactElement {
  const [entered, setEntered] = useState(!props.enabled);
  const [tick, setTick] = useState(0);
  const { exit } = useApp();
  const durationMs = props.durationMs ?? 620;
  const frameMs = props.frameMs ?? 90;

  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === '\u0003')) {
      exit();
      return;
    }
    setEntered(true);
  }, { isActive: props.enabled && !entered });

  useEffect(() => {
    if (!props.enabled || entered) return;
    const interval = setInterval(() => setTick((value) => value + 1), frameMs);
    const done = setTimeout(() => setEntered(true), durationMs);
    return () => {
      clearInterval(interval);
      clearTimeout(done);
    };
  }, [durationMs, entered, frameMs, props.enabled]);

  if (entered) return <>{props.children}</>;

  const depth = props.depth ?? DEPTH;
  const width = Math.max(1, props.width ?? process.stdout.columns ?? 80);
  const rows = Math.max(1, (props.rows ?? process.stdout.rows ?? 24) - 1);
  const contentWidth = Math.max(1, Math.min(width - 1, 64));
  const artWidth = Math.max(1, Math.min(contentWidth, 31));
  const artIndent = ' '.repeat(Math.max(0, Math.floor((contentWidth - artWidth) / 2)));
  const orbit = width >= 24 && rows >= 9
    ? ORBITS[tick % ORBITS.length] ?? ORBITS[0]!
    : [`${tick % 2 === 0 ? 'o' : '.'}  J U N O  ${tick % 2 === 0 ? '.' : 'o'}`];
  const readiness = [
    `workspace linked  ${abbreviateHome(props.cwd)}`,
    `model ready       ${props.model}`,
    'orchestration ready',
  ];
  const status = readiness[Math.floor(tick / 2) % readiness.length] ?? readiness[0]!;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={rows}
      justifyContent={rows >= 11 ? 'center' : 'flex-start'}
      alignItems="center"
      overflow="hidden"
    >
      <Box flexDirection="column" width={contentWidth}>
        {orbit.map((line, index) => (
          <Text
            key={`${index}:${line}`}
            color={line.includes('J U N O') ? token('accent', depth) : token('textDim', depth)}
          >
            {clipCells(`${artIndent}${line}`, contentWidth)}
          </Text>
        ))}
        <Text color={token('textDim', depth)}>{clipCells(`juno v${props.version}  /  ${status}`, contentWidth)}</Text>
        <Text color={token('textDim', depth)}>{clipCells('any key to enter', contentWidth)}</Text>
      </Box>
    </Box>
  );
}
