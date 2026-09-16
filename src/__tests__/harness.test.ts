import { describe, expect, it } from "vitest";
import { detectHarness, parseProcessLine, type ProcessInfo } from "../harness.js";

describe("parseProcessLine", () => {
  it("parses a ps -o ppid=,comm=,args= line", () => {
    const info = parseProcessLine(123, "  1  claude  claude --resume\n");
    expect(info).toEqual({ pid: 123, ppid: 1, comm: "claude", args: "claude --resume" });
  });

  it("returns undefined for blank output (pid no longer exists)", () => {
    expect(parseProcessLine(123, "")).toBeUndefined();
  });
});

describe("detectHarness", () => {
  it("finds a known harness immediately above the starting pid", async () => {
    const table = new Map<number, ProcessInfo>([
      [200, { pid: 200, ppid: 100, comm: "claude", args: "claude" }],
    ]);
    const lookup = async (pid: number) => table.get(pid);

    const harness = await detectHarness(200, lookup);

    expect(harness).toBe("claude");
  });

  it("walks up the process tree past intermediate shells", async () => {
    const table = new Map<number, ProcessInfo>([
      [300, { pid: 300, ppid: 200, comm: "node", args: "node cli.js" }],
      [200, { pid: 200, ppid: 100, comm: "zsh", args: "-zsh" }],
      [100, { pid: 100, ppid: 1, comm: "codex", args: "codex" }],
    ]);
    const lookup = async (pid: number) => table.get(pid);

    const harness = await detectHarness(300, lookup);

    expect(harness).toBe("codex");
  });

  it("returns 'unknown' when no known harness is found before pid 1", async () => {
    const table = new Map<number, ProcessInfo>([
      [200, { pid: 200, ppid: 100, comm: "zsh", args: "-zsh" }],
      [100, { pid: 100, ppid: 1, comm: "launchd", args: "/sbin/launchd" }],
    ]);
    const lookup = async (pid: number) => table.get(pid);

    const harness = await detectHarness(200, lookup);

    expect(harness).toBe("unknown");
  });

  it("returns 'unknown' when a lookup fails partway up the tree", async () => {
    const lookup = async () => undefined;

    const harness = await detectHarness(999, lookup);

    expect(harness).toBe("unknown");
  });
});
