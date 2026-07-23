/** Terminal alternate-screen sequences used by the orchestration workspace. */
export const ENTER_ALTERNATE_SCREEN = '\u001b[?1049h\u001b[2J\u001b[H';
export const EXIT_ALTERNATE_SCREEN = '\u001b[?1049l';

export interface AlternateScreenController {
  readonly active: () => boolean;
  readonly enter: () => void;
  readonly exit: () => void;
}

const activeControllers = new Set<AlternateScreenController>();

/**
 * Emergency restore used by fatal-process containment. Controllers remember
 * their own writer, so tests and embedded callers are restored through the same
 * output channel that entered the alternate buffer.
 */
export function restoreActiveAlternateScreens(): void {
  for (const controller of [...activeControllers]) {
    controller.exit();
  }
}

/**
 * Idempotent ownership for the terminal alternate buffer. React owns when the
 * transition happens; this object owns balanced escape emission, including the
 * unmount/error cleanup path.
 */
export function createAlternateScreenController(
  write: (data: string) => void,
  enabled: boolean,
): AlternateScreenController {
  let isActive = false;
  const controller: AlternateScreenController = {
    active: () => isActive,
    enter: () => {
      if (!enabled || isActive) return;
      write(ENTER_ALTERNATE_SCREEN);
      isActive = true;
      activeControllers.add(controller);
    },
    exit: () => {
      if (!enabled || !isActive) return;
      write(EXIT_ALTERNATE_SCREEN);
      isActive = false;
      activeControllers.delete(controller);
    },
  };
  return controller;
}
