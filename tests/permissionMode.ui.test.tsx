import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { selectStatusLine } from '../src/core/selectors';
import { StatusLine } from '../src/ui/StatusLine';
import { initialState } from '../src/core/reducer';

describe('permissionMode status chip', () => {
  it('threads permissionMode through selectStatusLine (pure passthrough)', () => {
    const status = selectStatusLine(initialState(), { permissionMode: 'acceptEdits' });
    expect(status.permissionMode).toBe('acceptEdits');
  });

  it('renders the mode:acceptEdits chip when mode is acceptEdits', () => {
    const status = selectStatusLine(initialState(), {
      model: 'm',
      cwd: '/w',
      permissionMode: 'acceptEdits',
    });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).toContain('mode:acceptEdits');
  });

  it('does NOT render the mode chip when permissionMode is default', () => {
    const status = selectStatusLine(initialState(), {
      model: 'm',
      cwd: '/w',
      permissionMode: 'default',
    });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).not.toContain('mode:');
  });

  it('does NOT render the mode chip when permissionMode is absent', () => {
    const status = selectStatusLine(initialState(), { model: 'm', cwd: '/w' });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).not.toContain('mode:');
  });
});
