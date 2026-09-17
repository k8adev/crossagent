import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { register, computeState } from "./bootstrap.js";
import { discoverPeers, parsePanes, LIST_PANES_FORMAT, type PaneRecord, type PeerScope } from "./discovery.js";
import { send, capture, setPaneOption, getPaneOption, waitIdle, WaitIdleTimeoutError, listPanesRaw, extractReply, TmuxUnreachableError } from "./tmux.js";
import { loadConfig, getIdleRegex, getBusyRegex, getResetCommand } from "./config.js";
import { briefPreamble, reviewPreamble, extractReview, type ReviewKind } from "./protocol.js";
import { matchKnownHarness } from "./harness.js";

/** Pane option set once brief() completes with AGREE; discuss() checks it to decide whether to (re-)brief first. */
const BRIEFED_OPTION = "@crossagent_briefed";

/** Per-pane discuss() round counter, reset whenever brief() (re-)briefs that pane. In-memory only — a server restart resets all counts. */
const roundsByPane = new Map<string, number>();

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function requirePane(pane: string | undefined): pane is string {
  return pane !== undefined;
}

/** Explicit-pane tools (send/read/wait_reply/ask_review with `pane`) only need a reachable tmux server, not our own pane. */
async function requireTmuxServer(): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await listPanesRaw(LIST_PANES_FORMAT);
    return { ok: true };
  } catch (error) {
    const reason = error instanceof TmuxUnreachableError ? error.message : (error as Error).message;
    return { ok: false, message: `crossagent cannot reach tmux: ${reason}` };
  }
}

/** Error for tools that need our own pane resolved (self-registration, list_peers with repo/window scope, ask_review without an explicit pane). */
function ownPaneUnresolvedError(reason: string | undefined): string {
  return `crossagent could not resolve its own tmux pane (${reason ?? "unknown reason"}) — pass \`pane\` explicitly where supported.`;
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "crossagent-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Registers this pane's identity and returns pane/harness/repo/mode.",
      inputSchema: {},
    },
    async () => {
      const state = await register();
      return textResult({
        mode: state.pane ? "tmux" : "degraded",
        pane: state.pane,
        pane_source: state.paneSource,
        ...(state.pane ? {} : { reason: state.reason }),
        harness: state.harness,
        repo: state.repoKey,
        pid: state.pid,
        registered: state.registered,
      });
    },
  );

  server.registerTool(
    "list_peers",
    {
      title: "List peers",
      description: "Lists other crossagent-visible tmux panes, scoped to repo, window, or all.",
      inputSchema: {
        scope: z.enum(["repo", "window", "all"]).default("repo"),
      },
    },
    async ({ scope }) => {
      if (scope === "all") {
        /* scope "all" only lists every other pane — it needs the tmux server, not our own pane. */
        const reachable = await requireTmuxServer();
        if (!reachable.ok) {
          return errorResult(reachable.message);
        }
        const peers = await discoverPeers({
          scope: "all",
          ownPaneId: "",
          ownWindowId: "",
          ownRepoKey: "",
        });
        return textResult({ peers });
      }

      const state = await computeState();
      if (!requirePane(state.pane)) {
        return errorResult(ownPaneUnresolvedError(state.reason));
      }

      const peers = await discoverPeers({
        scope: scope as PeerScope,
        ownPaneId: state.pane,
        ownWindowId: await ownWindowId(state.pane),
        ownRepoKey: state.repoKey,
      });
      return textResult({ peers });
    },
  );

  server.registerTool(
    "send",
    {
      title: "Send",
      description: "Sends literal text followed by Enter to a tmux pane.",
      inputSchema: {
        pane: z.string(),
        text: z.string(),
      },
    },
    async ({ pane, text }) => {
      try {
        await send(pane, text);
        return textResult({ sent: true });
      } catch (error) {
        return errorResult(`failed to send to pane ${pane}: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "read",
    {
      title: "Read",
      description: "Captures the last N lines from a tmux pane.",
      inputSchema: {
        pane: z.string(),
        lines: z.number().int().positive().default(200),
      },
    },
    async ({ pane, lines }) => {
      try {
        const content = await capture(pane, lines);
        return textResult({ content });
      } catch (error) {
        return errorResult(`failed to read pane ${pane}: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "wait_reply",
    {
      title: "Wait for reply",
      description: "Waits until a peer pane's harness becomes idle, then returns the new content.",
      inputSchema: {
        pane: z.string(),
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    async ({ pane, timeout_ms }) => {
      const reachable = await requireTmuxServer();
      if (!reachable.ok) {
        return errorResult(reachable.message);
      }
      const state = await computeState();

      const config = await loadConfig();
      const before = await capture(pane, 5000);
      const harness = await peerHarness(state, pane);
      const idleRegex = getIdleRegex(config, harness);
      const busyRegex = getBusyRegex(config, harness);

      try {
        const after = await waitIdle(() => capture(pane, 5000), {
          idleRegex,
          busyRegex,
          timeoutMs: timeout_ms ?? config.defaults.timeoutMs,
          pollMs: 500,
          quietMs: config.defaults.quietMs,
          tailLines: config.defaults.tailLines,
        });
        return textResult(extractReply({ sentText: "", before, after, idleRegex, tailLines: config.defaults.tailLines }));
      } catch (error) {
        if (error instanceof WaitIdleTimeoutError) {
          return errorResult(`timed out waiting for pane ${pane} to become idle; last output:\n${error.tail}`);
        }
        return errorResult(`failed waiting on pane ${pane}: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "brief",
    {
      title: "Brief",
      description: "Sends the pairing-protocol role brief to a peer pane and waits for its VERDICT: AGREE.",
      inputSchema: {
        pane: z.string().optional(),
        force: z.boolean().default(false),
      },
    },
    async ({ pane, force }) => {
      const state = await computeState();
      const resolved = await resolveTargetPane(state, pane);
      if (!resolved.ok) {
        return errorResult(resolved.message);
      }
      const targetPane = resolved.pane;
      const harness = await peerHarness(state, targetPane);

      if (!force) {
        const alreadyBriefed = await getPaneOption(targetPane, BRIEFED_OPTION);
        if (alreadyBriefed) {
          return textResult({
            pane: targetPane,
            harness,
            verdict: "AGREE",
            rationale: "already briefed; pass force: true to re-brief",
          });
        }
      }

      const briefResult = await runBrief(targetPane, state, harness);
      if (!briefResult.ok) {
        return errorResult(briefResult.message);
      }
      return textResult({
        pane: targetPane,
        harness,
        verdict: briefResult.verdict,
        rationale: briefResult.rationale,
      });
    },
  );

  server.registerTool(
    "discuss",
    {
      title: "Discuss",
      description: "Sends a review message to a peer pane (briefing it first if needed), waits for its reply, and parses the VERDICT: line.",
      inputSchema: {
        pane: z.string().optional(),
        message: z.string(),
        kind: z.enum(["plan", "implementation", "question"]).default("implementation"),
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    async ({ pane, message, kind, timeout_ms }) => runDiscuss(pane, message, kind, timeout_ms),
  );

  server.registerTool(
    "ask_review",
    {
      title: "Ask review",
      description: "Alias of discuss with kind 'implementation', kept for compatibility.",
      inputSchema: {
        pane: z.string().optional(),
        prompt: z.string(),
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    async ({ pane, prompt, timeout_ms }) => runDiscuss(pane, prompt, "implementation", timeout_ms),
  );

  return server;

  /** Shared implementation behind `discuss` and `ask_review` (a thin alias) — auto-briefs an un-briefed pane, then sends the review preamble + message and parses the verdict. */
  async function runDiscuss(pane: string | undefined, message: string, kind: ReviewKind, timeout_ms: number | undefined) {
    const state = await computeState();
    const resolved = await resolveTargetPane(state, pane);
    if (!resolved.ok) {
      return errorResult(resolved.message);
    }
    const targetPane = resolved.pane;
    const harness = await peerHarness(state, targetPane);

    const briefed = await getPaneOption(targetPane, BRIEFED_OPTION);
    if (!briefed) {
      const briefResult = await runBrief(targetPane, state, harness);
      if (!briefResult.ok) {
        return errorResult(briefResult.message);
      }
      if (briefResult.verdict !== "AGREE") {
        return textResult({
          pane: targetPane,
          verdict: briefResult.verdict,
          rationale: `brief did not return AGREE: ${briefResult.rationale}`,
          round: 0,
        });
      }
    }

    const config = await loadConfig();
    const sentText = reviewPreamble(kind) + message;
    const result = await sendAndWait(targetPane, sentText, config, harness, timeout_ms);
    if (!result.ok) {
      return errorResult(result.message);
    }

    const round = (roundsByPane.get(targetPane) ?? 0) + 1;
    roundsByPane.set(targetPane, round);

    const { verdict, rationale } = extractReview(result.reply);
    return textResult({
      pane: targetPane,
      verdict,
      rationale,
      round,
      ...(verdict === "UNPARSED" ? { raw: result.reply } : {}),
    });
  }

  /** Resets the peer's conversation (if a reset_command is known), sends the role brief, and marks the pane briefed on AGREE. */
  async function runBrief(
    targetPane: string,
    state: Awaited<ReturnType<typeof computeState>>,
    harness: string,
  ): Promise<{ ok: true; verdict: string; rationale: string } | { ok: false; message: string }> {
    const config = await loadConfig();
    const resetCommand = getResetCommand(config, harness);
    if (resetCommand) {
      await send(targetPane, resetCommand);
      try {
        await waitIdleOnPane(targetPane, config, harness, undefined);
      } catch {
        /* A reset that never settles is not fatal to briefing — fall through and send the brief anyway. */
      }
    }

    const sentText = briefPreamble(harness, state.repoKey);
    const result = await sendAndWait(targetPane, sentText, config, harness, undefined);
    if (!result.ok) {
      return result;
    }

    const { verdict, rationale } = extractReview(result.reply);
    if (verdict === "AGREE") {
      await setPaneOption(targetPane, BRIEFED_OPTION, String(state.pid));
      roundsByPane.delete(targetPane);
    }
    return { ok: true, verdict, rationale };
  }
}

/** Resolves the target pane shared by brief/discuss/ask_review: explicit `pane`, else the sole repo-scoped peer (needs our own pane resolved). */
async function resolveTargetPane(
  state: Awaited<ReturnType<typeof computeState>>,
  pane: string | undefined,
): Promise<SolePeerResult> {
  if (pane) {
    const reachable = await requireTmuxServer();
    if (!reachable.ok) {
      return { ok: false, message: reachable.message };
    }
    return { ok: true, pane };
  }

  if (!requirePane(state.pane)) {
    return {
      ok: false,
      message: `${ownPaneUnresolvedError(state.reason)} this tool needs \`pane\` to know which peer to reach.`,
    };
  }
  return resolveSolePeer(state.pane, state.repoKey);
}

/** Sends `text` to `targetPane`, waits for it to go idle, and extracts the reply. Shared by brief() and discuss(). */
async function sendAndWait(
  targetPane: string,
  text: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  harness: string,
  timeoutMs: number | undefined,
): Promise<{ ok: true; reply: string } | { ok: false; message: string }> {
  const before = await capture(targetPane, 5000);
  await send(targetPane, text);

  const idleRegex = getIdleRegex(config, harness);
  const busyRegex = getBusyRegex(config, harness);

  try {
    const after = await waitIdle(() => capture(targetPane, 5000), {
      idleRegex,
      busyRegex,
      timeoutMs: timeoutMs ?? config.defaults.timeoutMs,
      pollMs: 500,
      quietMs: config.defaults.quietMs,
      tailLines: config.defaults.tailLines,
    });
    const extracted = extractReply({ sentText: text, before, after, idleRegex, tailLines: config.defaults.tailLines });
    return { ok: true, reply: extracted.reply };
  } catch (error) {
    if (error instanceof WaitIdleTimeoutError) {
      return { ok: false, message: `timed out waiting for pane ${targetPane}; last output:\n${error.tail}` };
    }
    return { ok: false, message: `failed waiting on pane ${targetPane}: ${(error as Error).message}` };
  }
}

/** Waits for `targetPane` to go idle without sending anything first — used after a reset_command. */
async function waitIdleOnPane(
  targetPane: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  harness: string,
  timeoutMs: number | undefined,
): Promise<void> {
  const idleRegex = getIdleRegex(config, harness);
  const busyRegex = getBusyRegex(config, harness);
  await waitIdle(() => capture(targetPane, 5000), {
    idleRegex,
    busyRegex,
    timeoutMs: timeoutMs ?? config.defaults.timeoutMs,
    pollMs: 500,
    quietMs: config.defaults.quietMs,
    tailLines: config.defaults.tailLines,
  });
}

type SolePeerResult = { ok: true; pane: string } | { ok: false; message: string };

/** Resolves the implicit target pane for ask_review: the sole repo-scoped peer, or an error. */
async function resolveSolePeer(ownPane: string, ownRepoKey: string): Promise<SolePeerResult> {
  const peers = await discoverPeers({
    scope: "repo",
    ownPaneId: ownPane,
    ownWindowId: await ownWindowId(ownPane),
    ownRepoKey,
  });
  if (peers.length === 0) {
    return { ok: false, message: "no pane specified and no repo-scoped peers found" };
  }
  if (peers.length > 1) {
    const candidates = peers.map((peer: PaneRecord) => peer.paneId).join(", ");
    return { ok: false, message: `no pane specified and multiple repo-scoped peers found: ${candidates}` };
  }
  return { ok: true, pane: peers[0]!.paneId };
}

async function ownWindowId(pane: string): Promise<string> {
  /* list-panes already reports window_id per pane; re-derive ours by matching pane id in the same listing. */
  const raw = await listPanesRaw(LIST_PANES_FORMAT);
  const panes = parsePanes(raw);
  return panes.find((p) => p.paneId === pane)?.windowId ?? "";
}

/**
 * Resolves a peer pane's harness: its declared `@crossagent_harness` wins; otherwise falls back
 * to the pane's live `currentCommand` (a Codex/etc peer that never called register() still shows
 * up this way); "unknown" only when neither identifies a known harness. Pure and unit-testable.
 */
export function resolvePeerHarness(peer: PaneRecord | undefined): string {
  if (peer?.harness) {
    return peer.harness;
  }
  const fromCommand = peer ? matchKnownHarness(peer.currentCommand) : undefined;
  return fromCommand ?? "unknown";
}

/**
 * Looks up a peer pane's harness, preferring its declared `@crossagent_harness` and falling back
 * to `resolvePeerHarness()`'s `currentCommand` heuristic. Works without our own pane resolved
 * (degraded mode) — scope "all" only excludes `ownPaneId`, and an empty id excludes nothing, so
 * the target pane still shows up in the listing.
 */
async function peerHarness(state: { pane: string | undefined; repoKey: string }, targetPane: string): Promise<string> {
  const peers = await discoverPeers({
    scope: "all",
    ownPaneId: state.pane ?? "",
    ownWindowId: state.pane ? await ownWindowId(state.pane) : "",
    ownRepoKey: state.repoKey,
  });
  return resolvePeerHarness(peers.find((peer) => peer.paneId === targetPane));
}
