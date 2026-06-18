Read-only workspace, so I’m providing the patch for synthesis.

**src/ui/StatusLine.tsx**

Rationale: threads an optional fixed width into the footer and clips constrained rows to one line each.

Replace `StatusLineProps` and `StatusLine` with:

```tsx
export interface StatusLineProps {
  status: StatusLineState;
  depth?: ColorDepth;
  width?: number;
}

export function StatusLine({ status, depth, width }: StatusLineProps): ReactElement {
  const d = depth ?? DEPTH;
  const constrainedHeight = width === undefined ? undefined : 4;
  const rowHeight = width === undefined ? undefined : 1;
  const constrainedOverflow = width === undefined ? undefined : 'hidden';
  const rowFlexWrap = width === undefined ? undefined : 'nowrap';
  const textWrap = width === undefined ? undefined : 'truncate-end';

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={token('border', d)}
      paddingLeft={1}
      paddingRight={1}
      width={width}
      height={constrainedHeight}
      overflow={constrainedOverflow}
    >
      <Box gap={1} flexWrap={rowFlexWrap} height={rowHeight} overflow={constrainedOverflow}>
        <Text color={token('accent', d)} bold wrap={textWrap}>
          {status.model}
        </Text>
        <Text color={token('textDim', d)} wrap={textWrap}>
          {status.cwd}
        </Text>
        <Text color={token('text', d)} wrap={textWrap}>
          tok:{status.tokens.total}
        </Text>
        <Text color={token('accent', d)} wrap={textWrap}>
          {contextBar(status.contextFraction)}
        </Text>
        <EffortBadge effort={status.effort} depth={d} />
        {status.skills !== undefined && status.skills.length > 0 ? (
          <Text color={token('info', d)} wrap={textWrap}>
            skills:{status.skills.length}
          </Text>
        ) : null}
        {status.permissionMode !== undefined && status.permissionMode !== 'default' ? (
          <Text color={token('warning', d)} wrap={textWrap}>
            mode:{status.permissionMode}
          </Text>
        ) : null}
      </Box>
      <Box height={rowHeight} overflow={constrainedOverflow}>
        <Text color={token('textDim', d)} wrap={textWrap}>
          {status.statusText}
        </Text>
      </Box>
    </Box>
  );
}
```

**src/app.tsx**

Rationale: passes the live terminal width from `useTerminalSize()` into the footer.

Replace:

```tsx
      <StatusLine status={status} />
```

with:

```tsx
      <StatusLine status={status} width={columns} />
```

**tests/components.test.tsx**

Rationale: adds a deterministic regression test for bounded footer line count under narrow fixed width.

Replace the `describe('StatusLine', () => { ... })` block with:

```tsx
describe('StatusLine', () => {
  it('shows model, cwd, tokens and a context bar', () => {
    const status = selectStatusLine(baseState, { model: 'gpt-x', cwd: '/work', maxContext: 200 });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).toContain('gpt-x');
    expect(frame).toContain('/work');
    expect(frame).toContain('tok:150');
    expect(frame).toContain('[');
    expect(frame).toContain(']');
  });

  it('keeps a stable line count when constrained narrower than its chips', () => {
    const status = selectStatusLine(baseState, {
      model: 'gpt-super-long-model-name-that-overflows',
      cwd: '/workspaces/juno/a/very/deep/path/that/exceeds/the/status/width/by/a/large/margin',
      maxContext: 200,
      skills: ['alpha', 'beta'],
      permissionMode: 'acceptEdits',
    });

    const narrowFrame = render(<StatusLine status={status} width={20} />).lastFrame() ?? '';
    const wideFrame = render(<StatusLine status={status} width={80} />).lastFrame() ?? '';

    expect(narrowFrame.split('\n')).toHaveLength(4);
    expect(wideFrame.split('\n')).toHaveLength(4);
  });

  it('renders a skills chip with the count when skills are present (Wave 3)', () => {
    const status = selectStatusLine(baseState, { model: 'm', cwd: '/w', skills: ['alpha', 'beta'] });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).toContain('skills:2');
  });

  it('omits the skills chip when there are no skills', () => {
    const status = selectStatusLine(baseState, { model: 'm', cwd: '/w' });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).not.toContain('skills:');
  });
});
```

**Why Non-Tautological**

The new test renders a status line whose chip text greatly exceeds the fixed widths. If the `width` prop is ignored, or if the chip/status rows are allowed to wrap, the frame grows beyond the expected four lines. With the fix, both narrow and wide constrained renders stay at exactly four lines.

Verification not run: the read-only policy blocked the attempted `npx` command.