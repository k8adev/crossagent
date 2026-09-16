import { afterEach, describe, expect, it, vi } from "vitest";

const { listPanesRawOrThrow, walkAncestorPids } = vi.hoisted(() => ({
  listPanesRawOrThrow: vi.fn(),
  walkAncestorPids: vi.fn(),
}));

vi.mock("../tmux.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tmux.js")>();
  return {
    ...actual,
    listPanesRawOrThrow,
  };
});

vi.mock("../harness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../harness.js")>();
  return {
    ...actual,
    walkAncestorPids,
  };
});

const { TmuxUnreachableError } = await import("../tmux.js");
const { resolveOwnPane } = await import("../bootstrap.js");

describe("resolveOwnPane", () => {
  const originalTmuxPane = process.env.TMUX_PANE;

  afterEach(() => {
    if (originalTmuxPane === undefined) {
      delete process.env.TMUX_PANE;
    } else {
      process.env.TMUX_PANE = originalTmuxPane;
    }
    vi.clearAllMocks();
  });

  it("prefers TMUX_PANE when set, without consulting the process tree", async () => {
    process.env.TMUX_PANE = "%5";

    const result = await resolveOwnPane(999);

    expect(result).toEqual({ pane: "%5", source: "env", reason: undefined });
    expect(listPanesRawOrThrow).not.toHaveBeenCalled();
    expect(walkAncestorPids).not.toHaveBeenCalled();
  });

  it("falls back to the process tree and finds a matching ancestor pane_pid", async () => {
    delete process.env.TMUX_PANE;
    listPanesRawOrThrow.mockResolvedValue(["%1\t100", "%2\t200"].join("\n"));
    walkAncestorPids.mockResolvedValue([300, 200, 1]);

    const result = await resolveOwnPane(300);

    expect(result).toEqual({ pane: "%2", source: "process-tree", reason: undefined });
  });

  it("returns degraded with a reason when no ancestor matches any pane_pid", async () => {
    delete process.env.TMUX_PANE;
    listPanesRawOrThrow.mockResolvedValue(["%1\t100"].join("\n"));
    walkAncestorPids.mockResolvedValue([999, 1]);

    const result = await resolveOwnPane(999);

    expect(result).toEqual({
      pane: undefined,
      source: null,
      reason: "no ancestor process matched a live tmux pane",
    });
  });

  it("returns degraded with a distinct reason when no tmux server is reachable", async () => {
    delete process.env.TMUX_PANE;
    listPanesRawOrThrow.mockRejectedValue(new TmuxUnreachableError(new Error("exit 1")));

    const result = await resolveOwnPane(999);

    expect(result.pane).toBeUndefined();
    expect(result.source).toBeNull();
    expect(result.reason).toBe("no tmux server is running");
    expect(walkAncestorPids).not.toHaveBeenCalled();
  });
});
