import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/* Thin wrappers around the `tmux` CLI. Every tmux interaction in this project goes through here. */

export async function setPaneOption(pane: string, option: string, value: string): Promise<void> {
  await execFileAsync("tmux", ["set-option", "-p", "-t", pane, option, value]);
}

const ENTER_DELAY_MS = 250;

export async function send(pane: string, text: string): Promise<void> {
  /* -l sends the text literally, then Enter is sent as a separate key so control sequences in `text` are not interpreted. */
  await execFileAsync("tmux", ["send-keys", "-t", pane, "-l", text]);
  /*
   * TUIs (Codex, Claude Code) treat a fast burst of input as a bracketed paste; an Enter arriving
   * inside that burst becomes a newline in the input box instead of submitting it. Observed live:
   * a multi-line prompt stayed unsent in Codex's composer. A short pause lets the paste settle.
   */
  await new Promise((resolve) => setTimeout(resolve, ENTER_DELAY_MS));
  await execFileAsync("tmux", ["send-keys", "-t", pane, "Enter"]);
}

export async function capture(pane: string, lines: number): Promise<string> {
  const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-t", pane, "-S", `-${lines}`]);
  return stdout;
}

export async function listPanesRaw(format: string): Promise<string> {
  const { stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", format]);
  return stdout;
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
 * it onward (status lines) is then trimmed off. Falls back to the "new content since `before`"
 * diff when the sent text cannot be located (e.g. it scrolled out of the capture window).
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
    const echoIndex = afterLines.lastIndexOf(lastSentLine);
    if (echoIndex !== -1) {
      replyLines = afterLines.slice(echoIndex + 1);
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

/** Fallback: the tail of the normalized `after` lines that is new relative to `before` (naive suffix diff by line count). */
function diffTailLines(before: string, afterLines: string[]): string[] {
  const beforeLines = normalize(before).split("\n").filter((line) => line.length > 0);
  const newLineCount = afterLines.length - beforeLines.length;
  return newLineCount <= 0 ? afterLines : afterLines.slice(-newLineCount);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
