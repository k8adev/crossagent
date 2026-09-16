import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listPanesRaw } from "./tmux.js";

const execFileAsync = promisify(execFile);

/* Tab-separated format handed to `tmux list-panes -F`, columns match parsePanes() below. */
export const LIST_PANES_FORMAT = [
  "#{pane_id}",
  "#{session_name}",
  "#{window_id}",
  "#{pane_current_path}",
  "#{pane_current_command}",
  "#{pane_pid}",
  "#{@crossagent_harness}",
  "#{@crossagent_repo}",
  "#{@crossagent_pid}",
].join("\t");

export interface PaneRecord {
  paneId: string;
  sessionName: string;
  windowId: string;
  currentPath: string;
  currentCommand: string;
  panePid: string;
  harness: string | undefined;
  repo: string | undefined;
  pid: string | undefined;
  /** True when the pane has self-declared via register(), false when only discoverable by heuristic. */
  declared: boolean;
}

/** Pure parser: takes the raw tab-separated tmux output, returns typed records. Kept free of tmux calls so it is unit-testable. */
export function parsePanes(raw: string): PaneRecord[] {
  return raw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const columns = line.split("\t");
      const [paneId, sessionName, windowId, currentPath, currentCommand, panePid, harness, repo, pid] = columns;
      return {
        paneId: paneId ?? "",
        sessionName: sessionName ?? "",
        windowId: windowId ?? "",
        currentPath: currentPath ?? "",
        currentCommand: currentCommand ?? "",
        panePid: panePid ?? "",
        harness: emptyToUndefined(harness),
        repo: emptyToUndefined(repo),
        pid: emptyToUndefined(pid),
        declared: emptyToUndefined(harness) !== undefined,
      };
    });
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** Pure parser for the `#{pane_id}\t#{pane_pid}` format used by resolveOwnPane(). */
export function parsePanePids(raw: string): Map<number, string> {
  const byPid = new Map<number, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      continue;
    }
    const [paneId, panePid] = trimmed.split("\t");
    const pid = Number(panePid);
    if (paneId && Number.isFinite(pid)) {
      byPid.set(pid, paneId);
    }
  }
  return byPid;
}

/**
 * Finds which live tmux pane owns this process by intersecting its ancestor pid chain with
 * `pane_pid` values from `tmux list-panes`. The first ancestor (closest to the process itself)
 * that matches a pane_pid identifies the pane. Used as the fallback when TMUX_PANE is unset
 * (e.g. Codex's `shell_environment_policy.inherit = "core"` filters it out even though the
 * process IS running inside a tmux pane).
 */
export function resolvePaneByAncestry(ancestorPids: number[], panePidsRaw: string): string | undefined {
  const byPid = parsePanePids(panePidsRaw);
  for (const pid of ancestorPids) {
    const paneId = byPid.get(pid);
    if (paneId) {
      return paneId;
    }
  }
  return undefined;
}

export type PeerScope = "repo" | "window" | "all";

export interface ListPeersInput {
  scope: PeerScope;
  ownPaneId: string;
  ownWindowId: string;
  ownRepoKey: string;
}

/** Resolves a pane's cwd to a repo identity key (e.g. via git), used as the heuristic fallback for undeclared peers. */
export type RepoKeyResolver = (path: string) => Promise<string | undefined>;

/**
 * Filters out the own pane, then applies the scope:
 * - "repo": @crossagent_repo matches, OR (heuristic fallback for undeclared peers) the pane's
 *   current path resolves to the same git common dir as our own repo key.
 * - "window": same window_id.
 * - "all": every other pane.
 *
 * `resolveRepoKey` is injected so this stays unit-testable without shelling out to git.
 */
export async function listPeers(
  panes: PaneRecord[],
  input: ListPeersInput,
  resolveRepoKey: RepoKeyResolver,
): Promise<PaneRecord[]> {
  const others = panes.filter((pane) => pane.paneId !== input.ownPaneId);

  switch (input.scope) {
    case "all":
      return others;
    case "window":
      return others.filter((pane) => pane.windowId === input.ownWindowId);
    case "repo": {
      const matches = await Promise.all(
        others.map(async (pane) => {
          if (pane.repo !== undefined) {
            return pane.repo === input.ownRepoKey;
          }
          /* Undeclared peer (e.g. Codex hasn't called a tool yet): fall back to resolving its cwd. */
          const heuristicRepoKey = await resolveRepoKey(pane.currentPath);
          return heuristicRepoKey === input.ownRepoKey;
        }),
      );
      return others.filter((_, index) => matches[index]);
    }
  }
}

/** Resolves a directory's git common dir, used as the repo identity key. Returns undefined outside a git repo. */
export async function resolveRepoKey(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** Fetches live pane state from tmux and returns the peers visible to `scope`. */
export async function discoverPeers(input: ListPeersInput): Promise<PaneRecord[]> {
  const raw = await listPanesRaw(LIST_PANES_FORMAT);
  const panes = parsePanes(raw);
  return listPeers(panes, input, resolveRepoKey);
}
