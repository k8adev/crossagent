import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, getResetCommand, getComposerRegex } from "../config.js";

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

describe("composer_regex", () => {
  it("has defaults for claude and codex that skip the placeholder, and none for unknown", async () => {
    const config = await loadConfig("/nonexistent/config.toml");
    expect(getComposerRegex(config, "codex")?.test("› pasted text")).toBe(true);
    expect(getComposerRegex(config, "codex")?.test("› Ask Codex to do anything")).toBe(false);
    expect(getComposerRegex(config, "claude")?.test("❯ [Pasted text #1 +30 lines]")).toBe(true);
    expect(getComposerRegex(config, "claude")?.test("❯")).toBe(false);
    expect(getComposerRegex(config, "unknown")).toBeUndefined();
  });
});
