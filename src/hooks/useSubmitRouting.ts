// src/hooks/useSubmitRouting.ts
// W9 app-decompose — the composer's input-dispatch seam, extracted verbatim from
// app.tsx. One reason to change: how a submitted line routes to a slash command,
// a mid-turn steer, or the model.
//
// This is the single guard against leaking `/` to the model. A leading-`/` line
// NEVER reaches turn.submit():
//   - slash overlay open + plain non-slash line: send it once via the shared
//     helper (deduped against acceptSlash's same-Enter dispatch).
//   - overlay === 'slash' + `/`-line: DEFER value ownership to acceptSlash (the
//     SAME Enter via useKeybinds): it runs the command + clears, or PREFILLS
//     `/name ` for a takesArgs command. submit must NOT clear here or it would
//     clobber that prefill. `/steer <arg>` still injects here exactly once.
//   - otherwise: parse + dispatch the typed `/command` ourselves; unknown → drop.
import { useCallback, useRef } from 'react';
import type { Action, State } from '../core/reducer';
import {
  findSlashCommand,
  parseSlashCommand,
  parseSteerArg,
  slashCommandHasArg,
  type SlashCommand,
} from '../app/slashCommands';

/** The narrow slice of useStreamingTurn the routing consumes. */
export interface SubmitRoutingTurn {
  readonly isBusy: () => boolean;
  readonly steer: (text: string) => void;
  readonly abort: () => void;
  readonly dispatch: (action: Action) => void;
  readonly compactNow: () => void;
}

export interface SubmitRoutingDeps {
  readonly turn: SubmitRoutingTurn;
  /** The reducer overlay (turn.state.overlay) at this render. */
  readonly overlay: State['overlay'];
  /** The live composer text (the slash palette's query / inline args). */
  readonly value: string;
  readonly setValue: (value: string) => void;
  readonly closeOverlay: () => void;
  /** The optimistic-flag submit wrapper (app.tsx's runSubmit). */
  readonly runSubmit: (text: string) => void;
  /** Record a sent line in the input-history ring (useInputHistory.push). */
  readonly pushHistory: (line: string) => void;
  /** The palette's filtered rows + highlight, for the Enter-accept fallback. */
  readonly filteredSlashCommands: ReadonlyArray<SlashCommand>;
  readonly selectedIndex: number;
  readonly openModelPicker: () => void;
  readonly openSkillPicker: () => void;
  readonly openPermissionModePicker: () => void;
  readonly openSessionPicker: () => void;
  readonly openMcp: () => void;
  readonly openHelp: () => void;
}

export interface SubmitRouting {
  /** The InputBox Enter path. */
  readonly submit: (nextValue: string) => void;
  /** The slash palette's Enter path (routed by useKeybinds). */
  readonly acceptSlash: () => void;
}

export function useSubmitRouting(deps: SubmitRoutingDeps): SubmitRouting {
  const {
    turn,
    overlay,
    value,
    setValue,
    closeOverlay,
    runSubmit,
    pushHistory,
    filteredSlashCommands,
    selectedIndex,
    openModelPicker,
    openSkillPicker,
    openPermissionModePicker,
    openSessionPicker,
    openMcp,
    openHelp,
  } = deps;

  const slashPlainSubmitRef = useRef<string | null>(null);

  // When the slash overlay is open but the user has replaced the input with a
  // plain (non-slash) line, Enter must send THAT line exactly once — not fire the
  // highlighted command. `slashPlainSubmitRef` dedups against the InputBox's own
  // Enter→onSubmit so the SAME Enter does not double-fire (acceptSlash here + the
  // InputBox submit path) — see submit() below.
  const submitPlainInputFromSlashOverlay = useCallback(
    (nextValue: string): void => {
      // Match the plain-input submit paths' busy guard (see submit() below): while a turn
      // owns the controller, `turn.submit` no-ops, so closing the overlay + clearing the
      // composer here would silently DROP the typed line. Return before mutating any state
      // so the line survives for resend once the controller frees — and, together with
      // runSubmit's own guard, the in-flight turn's optimistic indicator is never lowered.
      if (turn.isBusy()) {
        return;
      }
      if (slashPlainSubmitRef.current === nextValue) {
        return;
      }

      slashPlainSubmitRef.current = nextValue;
      setTimeout(() => {
        if (slashPlainSubmitRef.current === nextValue) {
          slashPlainSubmitRef.current = null;
        }
      }, 0);

      closeOverlay();
      setValue('');
      runSubmit(nextValue);
    },
    [closeOverlay, runSubmit, setValue, turn],
  );

  // Dispatch a resolved slash command to its already-wired target. Single source
  // of truth for slash dispatch — shared by acceptSlash (Enter while the overlay
  // is open) and submit() (a typed `/command` when the overlay is NOT 'slash').
  const runSlashCommand = useCallback(
    (command: SlashCommand | undefined): void => {
      if (command === undefined) {
        // Unknown / zero-match selection: just close (closeOverlay clears the composer).
        // A safe no-op — no command fires, nothing leaks to the model.
        closeOverlay();
        return;
      }

      // A takesArgs command (only `/steer`) chosen from the palette with NO arg text
      // yet: prefill `/name ` and KEEP the overlay open + composer focused so the user
      // types the argument inline. The next Enter routes the full `/steer <text>`
      // through submit() → turn.steer. Do NOT close here.
      if (command.takesArgs === true && !slashCommandHasArg(value)) {
        setValue(`/${command.name} `);
        return;
      }

      // Every other resolved command clears the composer as it dispatches/opens a
      // sub-picker (the slash overlay's Enter path defers value ownership to here, so
      // submit no longer clears — see submit()). closeOverlay-based branches clear
      // again harmlessly; the sub-picker openers (model/skills/...) rely on this.
      setValue('');

      switch (command.name) {
        case 'clear':
          // Cancel any in-flight turn FIRST. `clear` alone resets the reducer to an
          // idle transcript but does NOT abort the running turn, so the controller stays
          // held (swallowing the next submit) and a parked permission await orphans into
          // a permanent input freeze. abort() releases the controller and drainDeny()s
          // the registry; it is a safe no-op when nothing is running.
          turn.abort();
          // Scrollback wipe (F): the `clear` dispatch bumps transcriptEpoch and remounts
          // <Static>. The shared dispatch funnel erases native scrollback FIRST (see
          // wipeScrollback + useStreamingTurn's dispatchNow) so the remount doesn't stack
          // a duplicate — the SAME sanctioned path compact and resume now wipe through.
          turn.dispatch({ t: 'clear' });
          closeOverlay();
          break;
        case 'model':
          openModelPicker();
          break;
        case 'effort':
          turn.dispatch({ t: 'cycle-effort' });
          closeOverlay();
          break;
        case 'skills':
          openSkillPicker();
          break;
        case 'permissions':
          openPermissionModePicker();
          break;
        case 'resume':
          openSessionPicker();
          break;
        case 'compact':
          void turn.compactNow();
          closeOverlay();
          break;
        case 'mcp':
          openMcp();
          break;
        case 'help':
          openHelp();
          break;
        case 'steer':
          // Palette selection carries no typed argument, so there is nothing to inject
          // here — this branch is for discoverability only. The real injection path is the
          // typed `/steer <text>` line, intercepted in `submit` below.
          closeOverlay();
          break;
        default:
          closeOverlay();
          break;
      }
    },
    [closeOverlay, openHelp, openMcp, openModelPicker, openPermissionModePicker, openSessionPicker, openSkillPicker, setValue, turn, value],
  );

  // Prefer a typed `/command` (parsed from the input value) over the highlighted
  // index, so a typed `/effort` + Enter cycles exactly once. If the slash overlay
  // is still open but the user has replaced the input with a plain non-slash
  // line, send that line once instead of firing the highlighted command (the
  // Unit-5.1 follow-up edge case — no phantom default-highlighted command).
  const acceptSlash = useCallback((): void => {
    // A MULTILINE value (bracketed paste, G) is ALWAYS one plain message, never a
    // command — even when it leads with '/'. Mirror submit()'s newline guard
    // (`nextValue.includes('\n')` below) so the SAME physical Enter that submit()
    // already routes to submitPlainInputFromSlashOverlay does not ALSO parse the
    // first word (`/clear\nfoo` → 'clear') and fire a command that aborts + wipes the
    // just-submitted turn. The pair is deduped by slashPlainSubmitRef → exactly one send.
    if (value.includes('\n')) {
      submitPlainInputFromSlashOverlay(value);
      return;
    }

    const parsedCommand = parseSlashCommand(value);
    const plainNonSlashInput = value.trim().length > 0 && !value.trimStart().startsWith('/');

    if (plainNonSlashInput && parsedCommand === null) {
      submitPlainInputFromSlashOverlay(value);
      return;
    }

    const typedCommand = findSlashCommand(parsedCommand);
    const command = typedCommand ?? filteredSlashCommands[selectedIndex];
    runSlashCommand(command);
  }, [filteredSlashCommands, runSlashCommand, selectedIndex, submitPlainInputFromSlashOverlay, value]);

  const submit = useCallback(
    (nextValue: string): void => {
      if (nextValue.trim().length === 0) {
        return;
      }

      // A pasted MULTILINE value (bracketed paste, G) is ALWAYS one plain message —
      // never a slash command, even when its first char is '/'. Route it straight to
      // the model without the leading-`/` guard so a paste like `/etc/hosts\n…` is not
      // mis-parsed as a command. (A single-line `/command` is unaffected.)
      if (nextValue.includes('\n')) {
        if (overlay === 'slash') {
          submitPlainInputFromSlashOverlay(nextValue);
          return;
        }
        if (turn.isBusy()) {
          return;
        }
        pushHistory(nextValue);
        setValue('');
        runSubmit(nextValue);
        return;
      }

      const trimmed = nextValue.trimStart();
      if (overlay === 'slash' && !trimmed.startsWith('/')) {
        submitPlainInputFromSlashOverlay(nextValue);
        return;
      }

      // Dedup: acceptSlash already submitted this exact value on the same Enter.
      if (slashPlainSubmitRef.current === nextValue) {
        slashPlainSubmitRef.current = null;
        return;
      }

      // `/steer <text>` is the one slash command that carries an inline argument, so it
      // routes through `turn.steer` (mid-turn inject) instead of the generic command
      // dispatch — and is intercepted HERE so it NEVER leaks to `turn.submit`. A bare
      // `/steer` (no text) is a no-op. The injection happens here exactly once.
      if (parseSlashCommand(nextValue) === 'steer') {
        const arg = parseSteerArg(nextValue);
        if (overlay === 'slash') {
          // Palette open: acceptSlash (same Enter) owns the composer value — it prefills
          // `/steer ` when there's no arg yet, or clears on close after we inject here.
          // Do NOT clear here (would clobber the prefill).
          if (arg !== null) {
            turn.steer(arg);
          }
          return;
        }
        // Typed/pasted with the palette closed: inject (if any) then clear the composer.
        setValue('');
        if (arg !== null) {
          turn.steer(arg);
        }
        return;
      }

      if (trimmed.startsWith('/')) {
        if (overlay === 'slash') {
          // Defer to acceptSlash (same Enter): it runs the command and owns the
          // composer value (clears on close, or prefills a takesArgs command).
          return;
        }
        setValue('');
        runSlashCommand(findSlashCommand(parseSlashCommand(nextValue)));
        return;
      }

      // Do NOT clear the composer unless the hook can actually accept the submission.
      // `turn.submit` silently no-ops while a turn — or a fire-and-forget compaction /
      // ambient-recall pass — still owns the controller (even though the phase can read
      // 'idle'), so clearing first would wipe the typed text AND drop the message: pure
      // silent data loss. When busy, preserve the composer so the user can resend once
      // the controller frees.
      if (turn.isBusy()) {
        return;
      }

      pushHistory(nextValue);
      setValue('');
      runSubmit(nextValue);
    },
    [overlay, pushHistory, runSlashCommand, runSubmit, setValue, submitPlainInputFromSlashOverlay, turn],
  );

  return { submit, acceptSlash };
}
