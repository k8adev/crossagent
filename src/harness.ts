import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Binaries this project knows how to recognize as a coding-agent harness. */
export const KNOWN_HARNESSES = ["claude", "codex", "gemini", "opencode", "cursor-agent"] as const;
export type KnownHarness = (typeof KNOWN_HARNESSES)[number];

export interface ProcessInfo {
  pid: number;
  ppid: number;
  comm: string;
  args: string;
}

/** Runs `ps -o ppid=,comm=,args= -p <pid>`, parses the single-line output. Returns undefined if the pid no longer exists. */
export async function getProcessInfo(pid: number): Promise<ProcessInfo | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "ppid=,comm=,args=", "-p", String(pid)]);
    return parseProcessLine(pid, stdout);
  } catch {
    return undefined;
  }
}

/** Pure parser for a single `ps -o ppid=,comm=,args=` line, kept separate from the process spawn so it is unit-testable. */
export function parseProcessLine(pid: number, line: string): ProcessInfo | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(\d+)\s+(\S+)\s+(.*)$/.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const [, ppid, comm, args] = match;
  return {
    pid,
    ppid: Number(ppid),
    comm: comm ?? "",
    args: args ?? "",
  };
}

/** Matches a `ps`/tmux `comm` value against KNOWN_HARNESSES, either bare or as a path's basename. */
export function matchKnownHarness(comm: string): KnownHarness | undefined {
  return KNOWN_HARNESSES.find((name) => comm === name || comm.endsWith(`/${name}`));
}

/**
 * Walks up the process tree starting at `startPid` (typically process.ppid), collecting every pid
 * visited (including `startPid` itself). Stops at pid 1, a cycle, or a failed lookup. Shared by
 * `detectHarness` and the pane-detection fallback in bootstrap.ts, so both walk the same ancestry
 * with a single `ps`-based lookup.
 */
export async function walkAncestorPids(
  startPid: number,
  lookup: (pid: number) => Promise<ProcessInfo | undefined> = getProcessInfo,
): Promise<number[]> {
  const pids: number[] = [];
  let pid = startPid;
  const seen = new Set<number>();

  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    pids.push(pid);
    const info = await lookup(pid);
    if (!info) {
      break;
    }
    pid = info.ppid;
  }

  return pids;
}

/**
 * Walks up the process tree starting at `startPid` (typically process.ppid), looking for a known
 * harness binary in `comm`. Stops at pid 1 or when a lookup fails. `lookup` is injected so this is
 * testable without spawning real `ps` calls.
 */
export async function detectHarness(
  startPid: number,
  lookup: (pid: number) => Promise<ProcessInfo | undefined> = getProcessInfo,
): Promise<KnownHarness | "unknown"> {
  let pid = startPid;
  const seen = new Set<number>();

  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const info = await lookup(pid);
    if (!info) {
      break;
    }
    const match = matchKnownHarness(info.comm);
    if (match) {
      return match;
    }
    pid = info.ppid;
  }

  return "unknown";
}
