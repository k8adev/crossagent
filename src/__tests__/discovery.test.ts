import { describe, expect, it } from "vitest";
import { parsePanes, listPeers, resolvePaneByAncestry, type ListPeersInput } from "../discovery.js";

/* Mirrors LIST_PANES_FORMAT column order: pane_id, session_name, window_id, current_path, current_command, pane_pid, harness, repo, pid. */
function row(fields: Partial<{
  paneId: string;
  sessionName: string;
  windowId: string;
  currentPath: string;
  currentCommand: string;
  panePid: string;
  harness: string;
  repo: string;
  pid: string;
}>): string {
  return [
    fields.paneId ?? "%0",
    fields.sessionName ?? "main",
    fields.windowId ?? "@0",
    fields.currentPath ?? "/repo",
    fields.currentCommand ?? "zsh",
    fields.panePid ?? "1000",
    fields.harness ?? "",
    fields.repo ?? "",
    fields.pid ?? "",
  ].join("\t");
}

describe("parsePanes", () => {
  it("parses a declared pane", () => {
    const raw = row({ paneId: "%1", harness: "claude", repo: "/repo/.git", pid: "42" });
    const [pane] = parsePanes(raw);

    expect(pane).toMatchObject({
      paneId: "%1",
      harness: "claude",
      repo: "/repo/.git",
      pid: "42",
      declared: true,
    });
  });

  it("marks an undeclared pane (empty crossagent columns) as not declared", () => {
    const raw = row({ paneId: "%2" });
    const [pane] = parsePanes(raw);

    expect(pane?.declared).toBe(false);
    expect(pane?.harness).toBeUndefined();
    expect(pane?.repo).toBeUndefined();
  });

  it("skips blank lines", () => {
    const raw = [row({ paneId: "%1" }), "", row({ paneId: "%2" })].join("\n");
    expect(parsePanes(raw)).toHaveLength(2);
  });
});

describe("listPeers", () => {
  const noopResolver = async () => undefined;

  it("excludes the own pane", async () => {
    const panes = parsePanes([row({ paneId: "%own" }), row({ paneId: "%1" })].join("\n"));
    const input: ListPeersInput = { scope: "all", ownPaneId: "%own", ownWindowId: "@0", ownRepoKey: "/repo/.git" };

    const peers = await listPeers(panes, input, noopResolver);

    expect(peers.map((p) => p.paneId)).toEqual(["%1"]);
  });

  it("scope 'window' matches only same window_id", async () => {
    const panes = parsePanes(
      [
        row({ paneId: "%own", windowId: "@0" }),
        row({ paneId: "%1", windowId: "@0" }),
        row({ paneId: "%2", windowId: "@1" }),
      ].join("\n"),
    );
    const input: ListPeersInput = { scope: "window", ownPaneId: "%own", ownWindowId: "@0", ownRepoKey: "/repo/.git" };

    const peers = await listPeers(panes, input, noopResolver);

    expect(peers.map((p) => p.paneId)).toEqual(["%1"]);
  });

  it("scope 'repo' matches declared peers by @crossagent_repo", async () => {
    const panes = parsePanes(
      [
        row({ paneId: "%own" }),
        row({ paneId: "%1", harness: "codex", repo: "/repo/.git" }),
        row({ paneId: "%2", harness: "codex", repo: "/other/.git" }),
      ].join("\n"),
    );
    const input: ListPeersInput = { scope: "repo", ownPaneId: "%own", ownWindowId: "@0", ownRepoKey: "/repo/.git" };

    const peers = await listPeers(panes, input, noopResolver);

    expect(peers.map((p) => p.paneId)).toEqual(["%1"]);
  });

  it("scope 'repo' falls back to the heuristic resolver for undeclared peers", async () => {
    const panes = parsePanes(
      [row({ paneId: "%own" }), row({ paneId: "%1", currentPath: "/repo/subdir" })].join("\n"),
    );
    const input: ListPeersInput = { scope: "repo", ownPaneId: "%own", ownWindowId: "@0", ownRepoKey: "/repo/.git" };
    const resolver = async (path: string) => (path === "/repo/subdir" ? "/repo/.git" : undefined);

    const peers = await listPeers(panes, input, resolver);

    expect(peers.map((p) => p.paneId)).toEqual(["%1"]);
    expect(peers[0]?.declared).toBe(false);
  });

  it("scope 'repo' excludes undeclared peers whose heuristic resolution misses", async () => {
    const panes = parsePanes(
      [row({ paneId: "%own" }), row({ paneId: "%1", currentPath: "/elsewhere" })].join("\n"),
    );
    const input: ListPeersInput = { scope: "repo", ownPaneId: "%own", ownWindowId: "@0", ownRepoKey: "/repo/.git" };
    const resolver = async () => undefined;

    const peers = await listPeers(panes, input, resolver);

    expect(peers).toHaveLength(0);
  });
});

describe("resolvePaneByAncestry", () => {
  const panePidsRaw = ["%1\t100", "%2\t200", "%3\t300"].join("\n");

  it("returns the pane whose pane_pid matches the closest ancestor", () => {
    const pane = resolvePaneByAncestry([555, 200, 1], panePidsRaw);
    expect(pane).toBe("%2");
  });

  it("returns undefined when no ancestor matches any pane_pid", () => {
    const pane = resolvePaneByAncestry([555, 777, 1], panePidsRaw);
    expect(pane).toBeUndefined();
  });

  it("prefers the closest matching ancestor when multiple pids match different panes", () => {
    const pane = resolvePaneByAncestry([300, 200, 1], panePidsRaw);
    expect(pane).toBe("%3");
  });
});
