import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { register, computeState } from "./bootstrap.js";
import { discoverPeers, parsePanes, LIST_PANES_FORMAT, type PaneRecord, type PeerScope } from "./discovery.js";
import { send, capture, waitIdle, WaitIdleTimeoutError, listPanesRaw, extractReply, TmuxUnreachableError } from "./tmux.js";
import { loadConfig, getIdleRegex, getBusyRegex } from "./config.js";

const REVIEW_PREAMBLE =
  "You are reviewing a change from a peer coding agent over crossagent. Reply with concrete, actionable feedback.\n\n";

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
    "ask_review",
    {
      title: "Ask review",
      description: "Sends a review request to a peer pane (or the sole repo-scoped peer) and waits for its reply.",
      inputSchema: {
        pane: z.string().optional(),
        prompt: z.string(),
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    async ({ pane, prompt, timeout_ms }) => {
      let targetPane = pane;
      const state = await computeState();

      if (!targetPane) {
        /* Resolving the sole repo peer needs our own pane; explicit `pane` never does. */
        if (!requirePane(state.pane)) {
          return errorResult(
            `${ownPaneUnresolvedError(state.reason)} ask_review needs \`pane\` to know which peer to reach.`,
          );
        }
        const resolved = await resolveSolePeer(state.pane, state.repoKey);
        if (!resolved.ok) {
          return errorResult(resolved.message);
        }
        targetPane = resolved.pane;
      } else {
        const reachable = await requireTmuxServer();
        if (!reachable.ok) {
          return errorResult(reachable.message);
        }
      }

      const config = await loadConfig();
      const before = await capture(targetPane, 5000);
      const sentText = REVIEW_PREAMBLE + prompt;
      await send(targetPane, sentText);

      const harness = await peerHarness(state, targetPane);
      const idleRegex = getIdleRegex(config, harness);
      const busyRegex = getBusyRegex(config, harness);

      try {
        const after = await waitIdle(() => capture(targetPane, 5000), {
          idleRegex,
          busyRegex,
          timeoutMs: timeout_ms ?? config.defaults.timeoutMs,
          pollMs: 500,
          quietMs: config.defaults.quietMs,
          tailLines: config.defaults.tailLines,
        });
        return textResult(extractReply({ sentText, before, after, idleRegex, tailLines: config.defaults.tailLines }));
      } catch (error) {
        if (error instanceof WaitIdleTimeoutError) {
          return errorResult(`timed out waiting for review reply from pane ${targetPane}; last output:\n${error.tail}`);
        }
        return errorResult(`failed waiting on pane ${targetPane}: ${(error as Error).message}`);
      }
    },
  );

  return server;
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
 * Looks up a peer pane's declared harness via `@crossagent_harness`. Works without our own pane
 * resolved (degraded mode) — scope "all" only excludes `ownPaneId`, and an empty id excludes
 * nothing, so the target pane still shows up in the listing.
 */
async function peerHarness(state: { pane: string | undefined; repoKey: string }, targetPane: string): Promise<string> {
  const peers = await discoverPeers({
    scope: "all",
    ownPaneId: state.pane ?? "",
    ownWindowId: state.pane ? await ownWindowId(state.pane) : "",
    ownRepoKey: state.repoKey,
  });
  return peers.find((peer) => peer.paneId === targetPane)?.harness ?? "unknown";
}
