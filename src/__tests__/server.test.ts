import { describe, expect, it } from "vitest";
import { pickImplicitPeer, resolvePeerHarness } from "../server.js";
import type { PaneRecord } from "../discovery.js";

function pane(overrides: Partial<PaneRecord>): PaneRecord {
  return {
    paneId: "%1",
    sessionName: "s",
    windowId: "@1",
    currentPath: "/repo",
    currentCommand: "zsh",
    panePid: "100",
    harness: undefined,
    repo: undefined,
    pid: undefined,
    declared: false,
    ...overrides,
  };
}

describe("resolvePeerHarness", () => {
  it("prefers the declared harness over currentCommand", () => {
    const peer = pane({ harness: "claude", currentCommand: "codex", declared: true });

    expect(resolvePeerHarness(peer)).toBe("claude");
  });

  it("falls back to currentCommand when harness is undeclared", () => {
    const peer = pane({ harness: undefined, currentCommand: "codex" });

    expect(resolvePeerHarness(peer)).toBe("codex");
  });

  it("returns 'unknown' when currentCommand matches no known harness", () => {
    const peer = pane({ harness: undefined, currentCommand: "zsh" });

    expect(resolvePeerHarness(peer)).toBe("unknown");
  });

  it("returns 'unknown' when the peer is undefined", () => {
    expect(resolvePeerHarness(undefined)).toBe("unknown");
  });
});

describe("pickImplicitPeer", () => {
  it("excludes shell panes, even when one is the only peer", () => {
    const shell = pane({ paneId: "%2", currentCommand: "zsh" });
    const agent = pane({ paneId: "%3", currentCommand: "codex", windowId: "@2" });

    expect(pickImplicitPeer([shell], "@1")).toEqual({
      ok: false,
      message: "no pane specified and no repo-scoped agent peers found",
    });
    expect(pickImplicitPeer([shell, agent], "@1")).toEqual({ ok: true, pane: "%3" });
  });

  it("picks the only same-window agent among several agents", () => {
    const near = pane({ paneId: "%2", currentCommand: "codex", windowId: "@1" });
    const far = pane({ paneId: "%3", harness: "claude", declared: true, windowId: "@2" });

    expect(pickImplicitPeer([far, near], "@1")).toEqual({ ok: true, pane: "%2" });
  });

  it("errors with the agent candidates when none (or several) share the window", () => {
    const a = pane({ paneId: "%2", currentCommand: "codex", windowId: "@2" });
    const b = pane({ paneId: "%3", currentCommand: "claude", windowId: "@3" });
    const shell = pane({ paneId: "%4", currentCommand: "zsh", windowId: "@1" });

    expect(pickImplicitPeer([a, b, shell], "@1")).toEqual({
      ok: false,
      message: "no pane specified and multiple repo-scoped peers found: %2, %3",
    });
  });
});
