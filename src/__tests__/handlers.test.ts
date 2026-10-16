import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  pressEnter: vi.fn(),
  pressKey: vi.fn(),
  capture: vi.fn(),
  waitIdle: vi.fn(),
  listPanesRaw: vi.fn(),
}));

vi.mock("../tmux.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../tmux.js")>()), ...mocks }));

vi.mock("../bootstrap.js", () => ({
  computeState: async () => ({ pane: "%1", paneSource: "env", reason: undefined, harness: "claude", repoKey: "/repo", pid: 1, registered: true }),
  register: async () => ({}),
}));

vi.mock("../discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../discovery.js")>()),
  discoverPeers: async () => [{ paneId: "%7", harness: "codex", currentCommand: "codex" }],
}));

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: () => actual.loadConfig("/nonexistent/config.toml") };
});

const { createServer } = await import("../server.js");

const IDLE = "› Ask Codex to do anything\n  GPT-6-Astra medium";
const MENU = "Where should the new conversation run?\n› 1. Use current Git worktree\n  2. Create new Git worktree\n  enter select · esc back";

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? "";
  return { isError: result.isError === true, text, json: result.isError ? undefined : JSON.parse(text) };
}

/** Makes the mocked peer answer every sent prompt with the given reply and go idle. */
function peerReplies(reply: string) {
  let sent = "";
  mocks.send.mockImplementation(async (_pane: string, text: string) => {
    sent = text;
  });
  mocks.capture.mockImplementation(async () => IDLE);
  mocks.waitIdle.mockImplementation(async () => `${IDLE}\n${sent}\n${reply}\n${IDLE}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listPanesRaw.mockResolvedValue("");
});

describe("discuss handler", () => {
  it("sends one message (brief + kind line + payload) and parses the first reply, with no ACK round-trip", async () => {
    peerReplies("REVIEW: looks fine\nVERDICT: AGREE");
    const client = await connect();

    const { json } = await call(client, "discuss", { pane: "%7", message: "PAYLOAD src/a.ts:1", kind: "plan" });

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.waitIdle).toHaveBeenCalledTimes(1);
    const [pane, text] = mocks.send.mock.calls[0]!;
    expect(pane).toBe("%7");
    expect(text).toMatch(/^You are codex, a same-level copilot/);
    expect(text).toContain("This is a PLAN");
    expect(text.endsWith("\n\nPAYLOAD src/a.ts:1")).toBe(true);
    expect(text).not.toMatch(/understood/i);
    expect(json).toMatchObject({ pane: "%7", verdict: "AGREE", round: 1 });
  });

  it("counts rounds per pane and restarts the count after brief resets the pane", async () => {
    peerReplies("REVIEW: fix x\nVERDICT: ADJUST");
    const client = await connect();
    /* The counter is module state shared across tests; start from a reset pane. */
    await call(client, "brief", { pane: "%7" });

    const first = await call(client, "discuss", { pane: "%7", message: "m1" });
    const second = await call(client, "discuss", { pane: "%7", message: "m2" });
    expect([first.json.round, second.json.round]).toEqual([1, 2]);

    await call(client, "brief", { pane: "%7" });
    const third = await call(client, "discuss", { pane: "%7", message: "m3" });
    expect(third.json.round).toBe(1);
  });
});

describe("brief handler", () => {
  it("only resets: sends the reset command, waits for idle, sends no role text", async () => {
    mocks.capture.mockResolvedValue(IDLE);
    mocks.waitIdle.mockResolvedValue(IDLE);
    const client = await connect();

    const { json } = await call(client, "brief", { pane: "%7" });

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]!.slice(0, 2)).toEqual(["%7", "/new"]);
    expect(mocks.waitIdle).toHaveBeenCalledTimes(1);
    expect(mocks.pressEnter).not.toHaveBeenCalled();
    expect(json).toEqual({ pane: "%7", harness: "codex", reset: true });
  });

  it("answers Codex's worktree menu with Enter (current worktree) before waiting for idle", async () => {
    mocks.capture.mockResolvedValueOnce(MENU).mockResolvedValue(IDLE);
    mocks.waitIdle.mockResolvedValue(IDLE);
    const client = await connect();

    const { json } = await call(client, "brief", { pane: "%7" });

    expect(mocks.pressEnter).toHaveBeenCalledTimes(1);
    expect(mocks.pressEnter).toHaveBeenCalledWith("%7");
    expect(mocks.pressEnter.mock.invocationCallOrder[0]!).toBeLessThan(mocks.waitIdle.mock.invocationCallOrder[0]!);
    expect(json.reset).toBe(true);
  });

  it("presses the option's number key when another option is selected", async () => {
    const other = "Where should the new conversation run?\n  1. Use current Git worktree  Keep\n› 2. Create new Git worktree   Make\n  enter select · esc back";
    mocks.capture.mockResolvedValueOnce(other).mockResolvedValue(IDLE);
    mocks.waitIdle.mockResolvedValue(IDLE);
    const client = await connect();

    const { json } = await call(client, "brief", { pane: "%7" });

    expect(mocks.pressKey).toHaveBeenCalledWith("%7", "1");
    expect(mocks.pressEnter).not.toHaveBeenCalled();
    expect(json.reset).toBe(true);
  });

  it("fails clearly, pressing nothing, when the menu has no current-worktree option", async () => {
    const odd = "Where should the new conversation run?\n› 1. Somewhere else\n  2. Another place";
    mocks.capture.mockResolvedValue(odd);
    const client = await connect();

    const result = await call(client, "brief", { pane: "%7" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("no option matching");
    expect(mocks.pressKey).not.toHaveBeenCalled();
    expect(mocks.pressEnter).not.toHaveBeenCalled();
    expect(mocks.waitIdle).not.toHaveBeenCalled();
  });

  it("reports a failed submit as an error instead of waiting for idle", async () => {
    const { PromptNotSubmittedError } = await import("../tmux.js");
    mocks.send.mockRejectedValue(new PromptNotSubmittedError("%7", "tail"));
    const client = await connect();

    const result = await call(client, "brief", { pane: "%7" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("prompt not submitted");
    expect(mocks.waitIdle).not.toHaveBeenCalled();
  });
});
