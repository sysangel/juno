import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Juno does not depend on Chalk directly. Importing `chalk` from a test can
// therefore resolve a different transitive copy (currently ESLint's Chalk 4)
// than the Chalk 5 instance Ink uses to render <Text>. Mutating that unrelated
// instance's `level` makes ANSI assertions silently receive plain text.
//
// Resolve from Ink's own module location so color-sensitive tests always
// configure the renderer's actual Chalk instance, regardless of npm hoisting.
const requireFromTest = createRequire(import.meta.url);
const inkEntry = requireFromTest.resolve('ink');
const requireFromInk = createRequire(inkEntry);
const chalkUrl = pathToFileURL(requireFromInk.resolve('chalk')).href;

const chalkModule = await import(chalkUrl) as unknown as {
  default: { level: 0 | 1 | 2 | 3 };
};

export default chalkModule.default;
