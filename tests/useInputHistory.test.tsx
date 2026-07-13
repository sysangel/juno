// tests/useInputHistory.test.tsx
// W9 app-decompose — the composer history ring (useInputHistory), tested
// directly. The mounted-composer behavior (Up/Down key routing, the Down
// handoff to the agents panel) stays pinned by tests/composerInput.test.tsx;
// this file pins the ring semantics themselves:
//   - prev stashes the live draft on first Up, walks oldest-ward, clamps
//   - next walks newest-ward, restores the draft past the newest, and reports
//     consumption (false only at the live draft)
//   - push appends and resets navigation
//   - resetNavigation (typing) makes the edited text the new draft
import { useState } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { useInputHistory } from '../src/hooks/useInputHistory';
import type { InputHistory } from '../src/hooks/useInputHistory';
import { flushInk } from './helpers/ink';

interface HistoryProbe {
  out: () => InputHistory;
  value: () => string;
  setValue: (value: string) => void;
}

function mountHistory(): HistoryProbe {
  const holder: { current: InputHistory | null } = { current: null };
  const valueHolder = { current: '' };
  let setValueOuter!: (value: string) => void;

  function Probe(): ReturnType<typeof Text> {
    const [value, setValue] = useState('');
    valueHolder.current = value;
    setValueOuter = setValue;
    holder.current = useInputHistory({ value, setValue });
    return <Text>value:{value}</Text>;
  }

  render(<Probe />);
  return {
    out: () => {
      if (holder.current === null) throw new Error('hook return was not captured');
      return holder.current;
    },
    value: () => valueHolder.current,
    setValue: (value) => setValueOuter(value),
  };
}

describe('useInputHistory — the composer history ring', () => {
  it('prev is a no-op on an empty ring', async () => {
    const probe = mountHistory();
    await flushInk();
    probe.out().prev();
    await flushInk();
    expect(probe.value()).toBe('');
    expect(probe.out().next()).toBe(false); // still at the live draft
  });

  it('first Up stashes the draft; walking clamps at the oldest entry', async () => {
    const probe = mountHistory();
    await flushInk();
    probe.out().push('first');
    probe.out().push('second');
    probe.setValue('draft in progress');
    await flushInk();

    probe.out().prev(); // → newest entry
    await flushInk();
    expect(probe.value()).toBe('second');
    probe.out().prev(); // → oldest
    await flushInk();
    expect(probe.value()).toBe('first');
    probe.out().prev(); // clamped — stays at the oldest
    await flushInk();
    expect(probe.value()).toBe('first');
  });

  it('next walks newest-ward and restores the stashed draft past the newest', async () => {
    const probe = mountHistory();
    await flushInk();
    probe.out().push('first');
    probe.out().push('second');
    probe.setValue('my draft');
    await flushInk();
    probe.out().prev();
    await flushInk();
    probe.out().prev();
    await flushInk();
    expect(probe.value()).toBe('first');

    expect(probe.out().next()).toBe(true); // → 'second'
    await flushInk();
    expect(probe.value()).toBe('second');
    expect(probe.out().next()).toBe(true); // past the newest → restores the draft
    await flushInk();
    expect(probe.value()).toBe('my draft');
    expect(probe.out().next()).toBe(false); // at the live draft: NOT consumed
  });

  it('push resets navigation: the next Up starts from the new newest entry', async () => {
    const probe = mountHistory();
    await flushInk();
    probe.out().push('first');
    probe.out().prev();
    await flushInk();
    expect(probe.value()).toBe('first');

    probe.out().push('second'); // submit while navigating: cursor resets
    probe.setValue('');
    await flushInk();
    probe.out().prev();
    await flushInk();
    expect(probe.value()).toBe('second');
  });

  it('resetNavigation (typing) exits navigation and re-stashes on the next Up', async () => {
    const probe = mountHistory();
    await flushInk();
    probe.out().push('first');
    probe.out().push('second');
    probe.out().prev();
    await flushInk();
    expect(probe.value()).toBe('second');

    // The user edits the recalled entry — that text becomes the new live draft.
    probe.setValue('second edited');
    probe.out().resetNavigation();
    await flushInk();
    expect(probe.out().next()).toBe(false); // back at the live draft

    probe.out().prev(); // re-stash the edited draft, start from the newest again
    await flushInk();
    expect(probe.value()).toBe('second');
    probe.out().next();
    await flushInk();
    expect(probe.value()).toBe('second edited'); // the edited draft survived
  });
});
