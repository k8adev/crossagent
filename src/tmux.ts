import { execFile } from "node:child_process";

/* Thin wrappers around the `tmux` CLI. Every tmux interaction in this project goes through here. */

/** Runs `tmux <args>`, optionally feeding `input` on stdin, and resolves with stdout. */
function tmux(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("tmux", args, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

export async function setPaneOption(pane: string, option: string, value: string): Promise<void> {
  await tmux(["set-option", "-p", "-t", pane, option, value]);
}

/** Reads a single pane user option, returning undefined if it is unset. */
export async function getPaneOption(pane: string, option: string): Promise<string | undefined> {
  try {
    const value = (await tmux(["show-options", "-p", "-t", pane, "-v", option])).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Per-process counter that makes each paste buffer name unique. */
let bufferCounter = 0;

const ENTER_DELAY_MS = 250;
/** How long after Enter the composer is inspected, so a submitted prompt has had time to start working. */
const SUBMIT_SETTLE_MS = 500;
/** Longer pause before the single Enter retry, for a TUI still digesting a large paste. */
const SUBMIT_RETRY_DELAY_MS = 1_500;
/** Non-empty trailing lines scanned for the composer; wide enough to still see the prompt line under a status footer. */
const COMPOSER_TAIL_LINES = 60;
/** A live composer sits just above its footer/status lines; more than this many lines below a prompt line means it is a scrollback echo, not the composer. */
const MAX_LINES_BELOW_COMPOSER = 5;

export interface SubmitVerification {
  /** Idle prompt shape; an empty composer. */
  idleRegex: RegExp;
  /** Matches a prompt line that holds input (not the placeholder). */
  composerRegex: RegExp;
  /** Matches the harness's empty-composer placeholder line (e.g. `› Ask Codex to do anything`); counts as an empty composer. */
  placeholderRegex?: RegExp;
  /** Busy indicator (e.g. "esc to interrupt"); a match outside the composer/sent text means the prompt was taken. */
  busyRegex?: RegExp;
  /** Title of a menu the sent text opens instead of landing in the composer (Codex's `/new` worktree picker). Only the reset path sets it; see findMenu(). */
  menuRegex?: RegExp;
}

/** Thrown by send() when the composer still holds the prompt after the Enter retry. */
export class PromptNotSubmittedError extends Error {
  constructor(
    public readonly pane: string,
    public readonly tail: string,
  ) {
    super(`prompt not submitted: pane ${pane} still holds it in the input box after retrying Enter`);
    this.name = "PromptNotSubmittedError";
  }
}

const MENU_OPTION_REGEX = /^[›>]?\s*\d+\.\s+\S/;

export interface PaneMenu {
  /** Numbered option lines, in order (marker and whitespace normalized). */
  options: string[];
  /** Index into `options` of the line carrying the `›` selection marker, or -1. */
  selected: number;
}

/**
 * Finds a numbered menu in a capture: a title line matching `titleRegex` that is not itself a
 * prompt line (so the same words typed into the composer don't count), followed by at least two
 * numbered options. Returns undefined otherwise.
 */
export function findMenu(content: string, titleRegex: RegExp): PaneMenu | undefined {
  const lines = normalize(content).split("\n");
  const title = lines.findIndex((line) => titleRegex.test(line) && !/^[›❯>]/.test(line));
  if (title < 0) {
    return undefined;
  }
  const options = lines.slice(title + 1).filter((line) => MENU_OPTION_REGEX.test(line));
  if (options.length < 2) {
    return undefined;
  }
  return { options: options.map((line) => line.replace(/^[›>]\s*/, "")), selected: options.findIndex((line) => line.startsWith("›")) };
}

/**
 * True when `sentText` is still sitting unsent in the composer. The last prompt line in the tail
 * decides: an empty one (idle or placeholder) means submitted, one with content means pending,
 * but only if it sits just above the footer (an echo with a dialog or output below is not the
 * composer). With no prompt line at all the state is unknown and reported as not pending, so
 * crossagent never presses an extra Enter without having seen the composer. A busy line only
 * counts when it is not part of the sent text or the composer, so a prompt that literally
 * mentions the busy phrase cannot disable the check. With `menuRegex` (reset path only), an open
 * menu counts as taken.
 */
export function composerHoldsInput(content: string, sentText: string, check: SubmitVerification): boolean {
  const tail = tailWindow(normalize(content), COMPOSER_TAIL_LINES);
  if (check.menuRegex && findMenu(content, check.menuRegex)) {
    return false;
  }
  const sent = normalize(sentText).replace(/\n/g, " ");
  const isSentContent = (line: string) => line.length > 0 && sent.includes(line);
  if (check.busyRegex && tail.some((line) => check.busyRegex!.test(line) && !check.composerRegex.test(line) && !isSentContent(line))) {
    return false;
  }

  const isEmpty = (line: string) => check.idleRegex.test(line) || (check.placeholderRegex?.test(line) ?? false);
  const index = tail.findLastIndex((line) => isEmpty(line) || check.composerRegex.test(line));
  if (index < 0 || isEmpty(tail[index]!)) {
    return false;
  }
  /* A numbered option (the candidate or anything below it) means a selection dialog, whose `›` marker looks like a composer. */
  if (tail.slice(index).some((line) => MENU_OPTION_REGEX.test(line))) {
    return false;
  }
  return tail.length - 1 - index <= MAX_LINES_BELOW_COMPOSER;
}

/** Presses a single key (tmux key name, e.g. "Enter" or "1") in `pane`. */
export async function pressKey(pane: string, key: string): Promise<void> {
  await tmux(["send-keys", "-t", pane, key]);
}

export const pressEnter = (pane: string): Promise<void> => pressKey(pane, "Enter");

/**
 * Types `text` into `pane` and submits it. With `verify`, captures the pane afterwards and, if
 * the composer still holds the prompt, presses Enter once more after a longer pause (re-checking
 * first, in case it was submitted meanwhile); if it is still unsent, throws PromptNotSubmittedError
 * instead of leaving the caller to wait out an idle timeout on a composer that can never look idle.
 */
export async function send(pane: string, text: string, verify?: SubmitVerification): Promise<void> {
  /*
   * Paste through a tmux buffer with -p (bracketed paste) rather than `send-keys -l`: a long
   * multi-line prompt typed as a burst of keys is treated by Codex/Claude Code as a paste anyway,
   * and the Enter that followed could be swallowed, leaving the prompt unsent in the composer
   * (observed live). A real bracketed paste is delimited, so the Enter that follows is a distinct
   * keypress. The buffer name is unique per send because tmux buffers are server-global: a shared
   * name would let concurrent sends overwrite each other between load and paste. -d frees it.
   */
  const buffer = `crossagent-${process.pid}-${bufferCounter++}`;
  await tmux(["load-buffer", "-b", buffer, "-"], text);
  await tmux(["paste-buffer", "-p", "-d", "-b", buffer, "-t", pane]);
  /* Short pause so the TUI finishes ingesting the paste before Enter arrives. */
  await sleep(ENTER_DELAY_MS);
  await pressEnter(pane);

  if (!verify) {
    return;
  }

  await sleep(SUBMIT_SETTLE_MS);
  if (!composerHoldsInput(await capture(pane, COMPOSER_TAIL_LINES), text, verify)) {
    return;
  }

  await sleep(SUBMIT_RETRY_DELAY_MS);
  if (!composerHoldsInput(await capture(pane, COMPOSER_TAIL_LINES), text, verify)) {
    return;
  }
  await pressEnter(pane);
  await sleep(SUBMIT_SETTLE_MS);
  const after = await capture(pane, COMPOSER_TAIL_LINES);
  if (composerHoldsInput(after, text, verify)) {
    throw new PromptNotSubmittedError(pane, after);
  }
}

export async function capture(pane: string, lines: number): Promise<string> {
  return tmux(["capture-pane", "-p", "-t", pane, "-S", `-${lines}`]);
}

export async function listPanesRaw(format: string): Promise<string> {
  return tmux(["list-panes", "-a", "-F", format]);
}

/** Tab-separated format used by resolveOwnPane() to intersect ancestor pids with live tmux panes. */
export const PANE_ID_PID_FORMAT = "#{pane_id}\t#{pane_pid}";

/** Thrown by listPanesRaw() when no tmux server is reachable (distinct from "server up, no panes"). */
export class TmuxUnreachableError extends Error {
  constructor(cause: unknown) {
    super("no tmux server is running");
    this.name = "TmuxUnreachableError";
    this.cause = cause;
  }
}

/** Same as listPanesRaw(), but rethrows as TmuxUnreachableError so callers can distinguish "no server" from other failures. */
export async function listPanesRawOrThrow(format: string): Promise<string> {
  try {
    return await listPanesRaw(format);
  } catch (error) {
    throw new TmuxUnreachableError(error);
  }
}

export interface WaitIdleOptions {
  /** Regex matched against the tail window; idle requires at least one line to match. */
  idleRegex: RegExp;
  /** If any line in the tail window matches, the pane is busy regardless of idleRegex. */
  busyRegex?: RegExp;
  timeoutMs: number;
  pollMs: number;
  /** How long the (normalized) pane content must stay unchanged before it is considered idle. */
  quietMs: number;
  /** How many trailing non-empty lines to evaluate. Defaults to 8. */
  tailLines?: number;
}

export class WaitIdleTimeoutError extends Error {
  constructor(public readonly tail: string) {
    super("timed out waiting for pane to become idle");
    this.name = "WaitIdleTimeoutError";
  }
}

/**
 * Polls `capturePane` until a tail window of the last N non-empty lines has no `busyRegex`
 * match, some line matches `idleRegex`, AND the normalized captured content has been stable
 * for `quietMs`. Injected `capturePane` keeps this testable without a real tmux process.
 */
export async function waitIdle(
  capturePane: () => Promise<string>,
  options: WaitIdleOptions,
): Promise<string> {
  const { idleRegex, busyRegex, timeoutMs, pollMs, quietMs, tailLines = 8 } = options;
  const start = Date.now();
  let lastNormalized: string | null = null;
  let stableSince: number | null = null;

  while (true) {
    const content = await capturePane();
    const normalized = normalize(content);
    const tail = tailWindow(normalized, tailLines);

    if (normalized !== lastNormalized) {
      lastNormalized = normalized;
      stableSince = Date.now();
    }

    const isStable = stableSince !== null && Date.now() - stableSince >= quietMs;
    const isBusy = busyRegex !== undefined && tail.some((line) => busyRegex.test(line));
    const isIdleMatch = tail.some((line) => idleRegex.test(line));

    if (isStable && !isBusy && isIdleMatch) {
      return content;
    }

    if (Date.now() - start >= timeoutMs) {
      throw new WaitIdleTimeoutError(content);
    }

    await sleep(pollMs);
  }
}

/** Braille block used for spinners (U+2800–U+28FF); stripped so animated noise doesn't defeat stability checks. */
const BRAILLE_RANGE = /[⠀-⣿]/g;

/** Strips braille spinner glyphs, collapses whitespace runs, trims line ends, and drops empty lines. */
export function normalize(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(BRAILLE_RANGE, "").replace(/\s+/g, " ").trimEnd().trimStart())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Returns the last `n` lines of already-normalized (empty-line-free) content. */
function tailWindow(normalized: string, n: number): string[] {
  if (normalized.length === 0) {
    return [];
  }
  const lines = normalized.split("\n");
  return lines.slice(-n);
}

export interface ExtractReplyOptions {
  /** The text this call sent to the pane (unsent for wait_reply, the review prompt for ask_review). */
  sentText: string;
  /** Content captured before sending, used as the fallback "new content since call started" baseline. */
  before: string;
  /** Content captured once the pane went idle. */
  after: string;
  idleRegex: RegExp;
  tailLines?: number;
}

export interface ExtractReplyResult {
  reply: string;
  /** Only set when reply is empty, so the caller can debug why. */
  rawTail?: string;
}

/**
 * Extracts just the peer's reply from a normalized idle-time capture, dropping the echoed
 * prompt, the idle prompt line, and trailing status lines.
 *
 * Strategy: normalize `sentText` and find the LAST occurrence of its last non-empty line in
 * `after` (screens can echo the prompt more than once, and tmux scrollback may repeat it).
 * Everything after that line is a candidate reply; the idle-prompt line and everything from
 * it onward (status lines) is then trimmed off. The anchor line is matched on whitespace-collapsed
 * text (join lines, collapse spaces) rather than exact single-line equality, because a TUI may
 * re-wrap a long echoed line across multiple screen lines — an exact-line match would then miss
 * the echo entirely and fall through to an earlier partial echo. Falls back to the "new content
 * since `before`" diff when the sent text cannot be located at all (e.g. it scrolled out of the
 * capture window).
 */
export function extractReply(options: ExtractReplyOptions): ExtractReplyResult {
  const { sentText, before, after, idleRegex, tailLines = 8 } = options;
  const normalizedAfter = normalize(after);
  const afterLines = normalizedAfter.length === 0 ? [] : normalizedAfter.split("\n");

  const normalizedSent = normalize(sentText);
  const sentLines = normalizedSent.length === 0 ? [] : normalizedSent.split("\n");
  const lastSentLine = sentLines.at(-1);

  let replyLines: string[] | undefined;
  if (lastSentLine) {
    const echoEndLine = findEchoEndLine(afterLines, lastSentLine);
    if (echoEndLine !== -1) {
      replyLines = afterLines.slice(echoEndLine + 1);
    }
  }

  if (replyLines === undefined) {
    replyLines = diffTailLines(before, afterLines);
  }

  const idleIndex = replyLines.findIndex((line) => idleRegex.test(line));
  const trimmed = idleIndex === -1 ? replyLines : replyLines.slice(0, idleIndex);
  const reply = trimmed.join("\n");

  if (reply.length === 0) {
    return { reply, rawTail: tailWindow(normalizedAfter, tailLines).join("\n") };
  }
  return { reply };
}

/** Collapses a line's internal whitespace runs to a single space, for cross-line-wrap comparison. */
function collapse(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/**
 * Finds the index of the LAST line in `afterLines` at which the echo of `targetLine` ends, tolerant
 * of the terminal re-wrapping `targetLine` across multiple screen lines. Tries an exact single-line
 * match first (the common case); if that fails, looks for a growing window of consecutive lines
 * whose whitespace-collapsed concatenation ends with the collapsed target, and returns the last
 * line of that window. Returns -1 if no match is found by either method.
 */
function findEchoEndLine(afterLines: string[], targetLine: string): number {
  const exactIndex = afterLines.lastIndexOf(targetLine);
  if (exactIndex !== -1) {
    return exactIndex;
  }

  const collapsedTarget = collapse(targetLine);
  if (collapsedTarget.length === 0) {
    return -1;
  }

  for (let end = afterLines.length - 1; end >= 0; end--) {
    let joined = "";
    for (let start = end; start >= 0; start--) {
      joined = joined.length === 0 ? collapse(afterLines[start]!) : `${collapse(afterLines[start]!)} ${joined}`;
      if (joined.length > collapsedTarget.length + 1) {
        break;
      }
      if (joined === collapsedTarget || joined.endsWith(collapsedTarget)) {
        return end;
      }
    }
  }
  return -1;
}

/** Fallback: the tail of the normalized `after` lines that is new relative to `before` (naive suffix diff by line count). */
function diffTailLines(before: string, afterLines: string[]): string[] {
  const beforeLines = normalize(before).split("\n").filter((line) => line.length > 0);
  const newLineCount = afterLines.length - beforeLines.length;
  return newLineCount <= 0 ? afterLines : afterLines.slice(-newLineCount);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
