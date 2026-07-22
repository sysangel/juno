import { Box, Static, Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

function Surface(props: { phase: 'chat' | 'workspace'; tick: number }) {
  const churn = Array.from({ length: 40 }, (_, index) => props.tick * 40 + index);
  return (
    <Box flexDirection="column">
      {props.phase === 'chat' ? (
        <Static items={[{ id: 'session', text: 'ready' }]}>
          {(item) => <Text key={item.id}>{item.text}</Text>}
        </Static>
      ) : null}
      {churn.map((value) => <Text key={value}>{`node-${value}`}</Text>)}
    </Box>
  );
}

describe('Ink Static/Yoga transition safety', () => {
  it('can churn, unmount chat Static for Observatory, and keep rendering', () => {
    const screen = render(<Surface phase="chat" tick={0} />);
    for (let tick = 1; tick <= 40; tick += 1) {
      screen.rerender(<Surface phase="chat" tick={tick} />);
    }
    // This exact transition hit Ink's freed rootNode.staticNode in older releases:
    // the next getComputedWidth/getComputedHeight could OOM or trap Yoga WASM.
    screen.rerender(<Surface phase="workspace" tick={41} />);
    for (let tick = 42; tick <= 80; tick += 1) {
      screen.rerender(<Surface phase="workspace" tick={tick} />);
    }
    expect(screen.lastFrame()).toContain('node-3200');
    screen.unmount();
  });
});
