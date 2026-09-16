import { detectHarness, walkAncestorPids, type KnownHarness } from "./harness.js";
import { resolveRepoKey, resolvePaneByAncestry } from "./discovery.js";
import { setPaneOption, listPanesRawOrThrow, TmuxUnreachableError, PANE_ID_PID_FORMAT } from "./tmux.js";

/** Where the pane id came from, or null in degraded mode. */
export type PaneSource = "env" | "process-tree" | null;

export interface BootstrapState {
  /** undefined when not running inside tmux — the server still starts, but tools report degraded mode. */
  pane: string | undefined;
  paneSource: PaneSource;
  /** Set only when pane is undefined, explaining what detection step failed. */
  reason: string | undefined;
  harness: KnownHarness | "unknown";
  repoKey: string;
  pid: number;
  registered: boolean;
}

let cachedState: BootstrapState | undefined;

/**
 * Resolves this process's own tmux pane, independent of environment variables: prefers
 * TMUX_PANE, else walks the ancestor pid chain (shared with detectHarness's ps lookup) and
 * intersects it with live `pane_pid`s from `tmux list-panes -a`. Needed because some harnesses
 * (e.g. Codex with `shell_environment_policy.inherit = "core"`) start the MCP server with a
 * filtered environment that strips TMUX_PANE even while running inside a real tmux pane.
 */
export async function resolveOwnPane(
  ppid: number,
): Promise<{ pane: string | undefined; source: PaneSource; reason: string | undefined }> {
  const envPane = process.env.TMUX_PANE;
  if (envPane) {
    return { pane: envPane, source: "env", reason: undefined };
  }

  let panePidsRaw: string;
  try {
    panePidsRaw = await listPanesRawOrThrow(PANE_ID_PID_FORMAT);
  } catch (error) {
    const reason = error instanceof TmuxUnreachableError ? error.message : "failed to list tmux panes";
    return { pane: undefined, source: null, reason };
  }

  const ancestorPids = await walkAncestorPids(ppid);
  const pane = resolvePaneByAncestry(ancestorPids, panePidsRaw);
  if (!pane) {
    return { pane: undefined, source: null, reason: "no ancestor process matched a live tmux pane" };
  }
  return { pane, source: "process-tree", reason: undefined };
}

/** Computes (once) this process's pane/harness/repo identity. Does not touch tmux state beyond pane resolution. */
export async function computeState(): Promise<BootstrapState> {
  if (cachedState) {
    return cachedState;
  }

  const { pane, source, reason } = await resolveOwnPane(process.ppid);
  const harness = await detectHarness(process.ppid);
  const repoKey = (await resolveRepoKey(process.cwd())) ?? process.cwd();

  cachedState = {
    pane,
    paneSource: source,
    reason,
    harness,
    repoKey,
    pid: process.pid,
    registered: false,
  };
  return cachedState;
}

/**
 * Declares this pane's identity to tmux via user options, so peers can discover it without a
 * heuristic. Idempotent, safe to call on every tool invocation.
 *
 * Codex starts MCP servers lazily on first tool call, so a peer's pane may show no
 * `@crossagent_harness` until it actually uses a tool — callers should treat an undeclared peer
 * as "possibly this harness, not yet confirmed" rather than "not running crossagent".
 */
export async function register(): Promise<BootstrapState> {
  const state = await computeState();
  if (!state.pane) {
    /* Degraded mode: nothing to register against. */
    return state;
  }

  await setPaneOption(state.pane, "@crossagent_harness", state.harness);
  await setPaneOption(state.pane, "@crossagent_repo", state.repoKey);
  await setPaneOption(state.pane, "@crossagent_pid", String(state.pid));

  state.registered = true;
  return state;
}
