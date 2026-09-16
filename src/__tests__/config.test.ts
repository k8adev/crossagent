import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, getResetCommand } from "../config.js";

describe("reset_command", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("defaults to /clear for claude and /new for codex, and none for unknown", async () => {
    const config = await loadConfig("/nonexistent/config.toml");
    expect(getResetCommand(config, "claude")).toBe("/clear");
    expect(getResetCommand(config, "codex")).toBe("/new");
    expect(getResetCommand(config, "unknown")).toBeUndefined();
  });

  it("is overridable via config.toml", async () => {
    dir = await mkdtemp(join(tmpdir(), "crossagent-config-"));
    const path = join(dir, "config.toml");
    await writeFile(
      path,
      [
        "[harness.claude]",
        'reset_command = "/reset"',
        "",
        "[harness.codex]",
        'reset_command = "/restart"',
      ].join("\n"),
    );

    const config = await loadConfig(path);
    expect(getResetCommand(config, "claude")).toBe("/reset");
    expect(getResetCommand(config, "codex")).toBe("/restart");
  });
});
