import { describe, expect, it } from "vitest";
import { resolvePeerHarness } from "../server.js";
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
