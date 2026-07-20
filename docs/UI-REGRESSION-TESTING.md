# UI regression baselines

The fixed-width UI baselines are a deliberately small review lane, not a replacement for
semantic assertions or the PTY UX contract. Each case first asserts meaningful text/state,
then pins a normalized ANSI frame so color, glyph, spacing, and line grouping cannot drift
silently.

Snapshot updates must be intentional. Run the focused file with `vitest -u`, inspect every
changed frame as terminal UI (including SGR changes), and record the reason in the commit.
Never update snapshots merely to make a failure green. Volatile elapsed time, absolute paths,
and generated identifiers must be fixed at fixture construction or normalized before matching.

The curated matrix is ANSI-16 at 40 and 80 columns. Width-specific wrapping and clipping are
covered at both widths; truecolor token mapping and no-color behavior remain semantic/theme
tests, while the PTY selftest is the authority for a real terminal framebuffer and scrollback.
