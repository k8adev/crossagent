import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { register, computeState } from "./bootstrap.js";
import { discoverPeers, parsePanes, LIST_PANES_FORMAT, type PaneRecord, type PeerScope } from "./discovery.js";
import { send, capture, setPaneOption, getPaneOption, waitIdle, WaitIdleTimeoutError, listPanesRaw, extractReply, TmuxUnreachableError } from "./tmux.js";
import { loadConfig, getIdleRegex, getBusyRegex, getResetCommand } from "./config.js";
import { briefPreamble, reviewPreamble, extractReview, type ReviewKind } from "./protocol.js";
import { matchKnownHarness } from "./harness.js";
import { loadPairSkill } from "./skill.js";

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

/**
 * Sent on `initialize` and the main thing an agent sees when crossagent was added with `mcp add`
 * alone: the `pair` prompt is user-invoked and Claude Code-only, so the decision rules have to
 * live here and in the tool descriptions. Claude Code truncates instructions at 2048 chars.
 */
export const SERVER_INSTRUCTIONS = [
  "crossagent pairs you with a peer coding agent running in another tmux pane. You are the driver: you plan, implement and decide. The peer is a same-level copilot that reads the repo and runs read-only checks, never writes, and is not an approver \u2014 treat its disagreement as signal, not a veto.",
  "",
  "Sequence: `ping` once to register your pane, `list_peers` to find the peer (one peer \u2192 use it; none \u2192 say so and continue solo; several \u2192 ask the human which), then `discuss` for every round. `discuss` briefs the peer automatically the first time; call `brief` yourself only to reset a stale peer session with `force: true`.",
  "",
  "Call `discuss` after drafting a plan and before writing code (`kind: \"plan\"`), after implementing and tests pass but before committing or opening a PR (`kind: \"implementation\"`), and on an architectural fork you cannot settle alone (`kind: \"question\"`). Every message must be self-contained, with the diff or concrete `file:line` pointers \u2014 the peer has not seen your turns.",
  "",
  "Each reply comes back as `{ verdict, rationale, round }`, the peer having ended its answer with one `VERDICT:` line. AGREE: proceed. ADJUST: apply the listed corrections, or argue back with facts if one is wrong, then re-`discuss` only the delta. OBJECT: do not proceed as-is; fix or argue, then re-`discuss`. ESCALATE: stop and put the peer's exact question to the human with both positions and what each costs \u2014 never resolve it yourself. UNPARSED: ask the peer to re-send in the `REVIEW:` / `VERDICT:` shape.",
  "",
  "Cap each topic at 3 rounds. If round 3 is still not AGREE, stop looping and report both positions to the human; do not average them or re-ask hoping for a different answer.",
  "",
  "Never send secrets or personal data to the peer, and never ask it to edit, create or delete anything. The full protocol is also available as the `pair` prompt.",
].join("\n");

/** The `pair` prompt's declared arguments, both optional — hosts may omit `arguments` entirely. */
const PAIR_PROMPT_ARGUMENTS = [
  {
    name: "pane",
    description: "tmux pane id of the peer to pair with, e.g. %13. Omit to let list_peers resolve it.",
    required: false,
  },
  {
    name: "kind",
    description: "What you are bringing to the peer first: plan, implementation, or question.",
    required: false,
  },
];

const PAIR_PROMPT = {
  name: "pair",
  title: "Pair with the agent in the next tmux pane",
  description:
    "The full crossagent pairing protocol: brief the peer pane as a same-level copilot, discuss plans and implementations, handle each verdict, and escalate decisions only the human can make.",
  arguments: PAIR_PROMPT_ARGUMENTS,
};

/**
 * Exposes the `pair` skill as an MCP prompt, so `mcp add` alone gives an agent the full pairing
 * protocol (Claude Code surfaces it as `/mcp__crossagent__pair`) without `setup --link`.
 *
 * Registered on the raw Server rather than via `McpServer.registerPrompt` because that helper
 * validates `params.arguments` against an object schema built from the declared shape, which
 * rejects a request that omits `arguments` altogether. The spec makes that field optional and
 * Claude Code omits it when the user invokes the prompt with no input, so both arguments being
 * optional has to mean the whole object may be absent.
 */
function registerPairPrompt(server: McpServer): void {
  server.server.registerCapabilities({ prompts: {} });

  server.server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [PAIR_PROMPT] }));

  server.server.setRequestHandler(GetPromptRequestSchema, (request) => {
    if (request.params.name !== PAIR_PROMPT.name) {
      throw new McpError(ErrorCode.InvalidParams, `Prompt ${request.params.name} not found`);
    }

    const args = request.params.arguments ?? {};
    const text = pairPromptText(args.pane, args.kind);
    return {
      description: PAIR_PROMPT.description,
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text },
        },
      ],
    };
  });
}

/** Skill body with a preamble naming the requested pane/kind; a missing skill file degrades to its error text. */
function pairPromptText(pane: string | undefined, kind: string | undefined): string {
  let skill: string;
  try {
    skill = loadPairSkill();
  } catch (error) {
    return (error as Error).message;
  }
  return pairPreamble(pane, kind) + skill;
}

/** One line naming the concrete pane/kind the caller asked for, prepended to the generic skill text. */
function pairPreamble(pane: string | undefined, kind: string | undefined): string {
  const parts: string[] = [];
  if (pane) parts.push(`Pair with the peer in tmux pane ${pane}`);
  if (kind) parts.push(`${pane ? "b" : "B"}ring it a ${kind} in the first \`discuss\` round`);
  if (parts.length === 0) return "";
  return `${parts.join(", and ")}. Follow this protocol:\n\n`;
}

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "crossagent-mcp",
      version: "0.1.0",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerPairPrompt(server);

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description:
        "Declares this pane's identity (harness, repo, pid) onto its tmux pane so peers can discover it, and reports back pane/harness/repo plus mode. Call it once at the start of a pairing session, before list_peers. Returns mode \"degraded\" with a reason when no tmux pane could be resolved, in which case pane-taking tools need an explicit `pane`.",
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
      description:
        "Lists the other tmux panes you could pair with, so you can pick the peer pane id for brief/discuss. Call it after ping: exactly one peer means use it for the whole session, none means pair-programming is unavailable, several means ask the human which one. Each entry reports the pane id, harness and repo, and `declared: false` for a peer that has not run crossagent yet (still reachable).",
      inputSchema: {
        scope: z
          .enum(["repo", "window", "all"])
          .default("repo")
          .describe(
            "\"repo\" (default) keeps only panes working on the same git repo, \"window\" only panes in this tmux window, \"all\" every other pane on the tmux server.",
          ),
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
      description:
        "Low-level primitive: types literal text plus Enter into a tmux pane and returns immediately, without briefing, waiting, or parsing anything. Prefer `discuss`, which does the whole round; reach for `send` only to drive a pane outside the pairing protocol. Returns `{ sent: true }`.",
      inputSchema: {
        pane: z.string().describe("tmux pane id to type into, e.g. %13."),
        text: z.string().describe("Literal text to type; Enter is appended for you."),
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
      description:
        "Low-level primitive: captures the last N lines currently visible in a tmux pane, whatever state that pane is in. Use it to inspect a pane directly (e.g. to see why a peer stalled); for a review round prefer `discuss`, which waits and parses the verdict for you. Returns the raw captured text.",
      inputSchema: {
        pane: z.string().describe("tmux pane id to capture from, e.g. %13."),
        lines: z.number().int().positive().default(200).describe("How many trailing lines to capture (default 200)."),
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
      description:
        "Low-level primitive: blocks until the pane's harness prompt looks idle again, then returns only the content that appeared since the call started. Pair it with `send` when driving a pane outside the protocol; for a review round prefer `discuss`, which sends, waits and parses in one call. Errors with the last output if the pane never goes idle before the timeout.",
      inputSchema: {
        pane: z.string().describe("tmux pane id to watch, e.g. %13."),
        timeout_ms: z.number().int().positive().optional().describe("How long to wait for idle before giving up (defaults to the configured timeout, 5 min)."),
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
      description:
        "Resets the peer pane's conversation and sends the role preamble that makes it a read-only same-level reviewer bound to the VERDICT contract \u2014 once per peer session, since `discuss` briefs automatically when needed. Call it explicitly up front, or with `force: true` to re-brief a peer whose session went stale or off-protocol. Returns once the peer answers `VERDICT: AGREE`; any other verdict means the peer did not accept the role.",
      inputSchema: {
        pane: z.string().optional().describe("tmux pane id of the peer, e.g. %13. Omit to use the sole repo-scoped peer."),
        force: z.boolean().default(false).describe("Re-brief a pane that is already marked briefed (default false, which makes an already-briefed pane a no-op)."),
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
      description:
        "The main pairing call: briefs the peer if it has not been briefed, sends your message under a kind-specific review preamble, waits for the peer's reply and returns `{ verdict, rationale, round }`. Send a self-contained message with concrete `file:line` pointers or the diff \u2014 the peer has its own context and has not seen your turns. Handle the verdict: AGREE proceed; ADJUST apply the corrections or argue back, then re-`discuss` the delta; OBJECT do not proceed as-is; ESCALATE stop and put the question to the human, never decide it yourself; UNPARSED (raw reply included) ask the peer to re-send in the `REVIEW:` / `VERDICT:` shape. Cap a topic at 3 rounds, then report both positions to the human; a timeout comes back as an error with the peer's last output.",
      inputSchema: {
        pane: z.string().optional().describe("tmux pane id of the peer, e.g. %13. Omit to use the sole repo-scoped peer."),
        message: z.string().describe("The self-contained plan, diff, or question to review, with concrete paths."),
        kind: z
          .enum(["plan", "implementation", "question"])
          .default("implementation")
          .describe(
            "\"plan\" before any code is written, \"implementation\" for a finished diff before committing (default), \"question\" for an architectural fork that is neither.",
          ),
        timeout_ms: z.number().int().positive().optional().describe("How long to wait for the peer's reply (defaults to the configured timeout, 5 min)."),
      },
    },
    async ({ pane, message, kind, timeout_ms }) => runDiscuss(pane, message, kind, timeout_ms),
  );

  server.registerTool(
    "ask_review",
    {
      title: "Ask review",
      description:
        "Compatibility alias for `discuss` with `kind: \"implementation\"` \u2014 same briefing, waiting, verdict parsing and round counting, with the message named `prompt`. Prefer `discuss`, which also offers the \"plan\" and \"question\" kinds. Returns the same `{ verdict, rationale, round }`.",
      inputSchema: {
        pane: z.string().optional().describe("tmux pane id of the peer, e.g. %13. Omit to use the sole repo-scoped peer."),
        prompt: z.string().describe("The self-contained implementation/diff to review, with concrete paths."),
        timeout_ms: z.number().int().positive().optional().describe("How long to wait for the peer's reply (defaults to the configured timeout, 5 min)."),
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
