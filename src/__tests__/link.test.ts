import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyLink, applyUnlink, planLinks } from "../link.js";

describe("planLinks", () => {
  it("resolves the three per-host targets, honoring CODEX_HOME when set", () => {
    const targets = planLinks("/home/user", undefined);
    expect(targets.map((t) => t.path)).toEqual([
      "/home/user/.claude/skills/pair",
      "/home/user/.codex/skills/pair",
      "/home/user/.agents/skills/pair",
    ]);

    const withCodexHome = planLinks("/home/user", "/custom/codex-home");
    expect(withCodexHome[1]!.path).toBe("/custom/codex-home/skills/pair");
  });
});

describe("applyLink / applyUnlink", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  function setup(): { sourceDir: string; targetPath: string } {
    dir = mkdtempSync(join(tmpdir(), "crossagent-link-"));
    const sourceDir = join(dir, "skills", "pair");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "SKILL.md"), "---\nname: pair\n---\n");
    const targetPath = join(dir, "home", ".claude", "skills", "pair");
    return { sourceDir, targetPath };
  }

  it("creates a symlink when the target is missing", () => {
    const { sourceDir, targetPath } = setup();
    const outcome = applyLink({ path: targetPath, label: "Claude Code" }, sourceDir);
    expect(outcome.status).toBe("linked");
    expect(readlinkSync(targetPath)).toBe(sourceDir);
  });

  it("is a no-op when already linked to our source", () => {
    const { sourceDir, targetPath } = setup();
    applyLink({ path: targetPath, label: "Claude Code" }, sourceDir);
    const outcome = applyLink({ path: targetPath, label: "Claude Code" }, sourceDir);
    expect(outcome.status).toBe("already-linked");
  });

  it("leaves a foreign real directory untouched and reports it", () => {
    const { sourceDir, targetPath } = setup();
    mkdirSync(targetPath, { recursive: true });
    writeFileSync(join(targetPath, "other.md"), "not ours");

    const outcome = applyLink({ path: targetPath, label: "Claude Code" }, sourceDir);
    expect(outcome.status).toBe("skipped");
    /* The foreign directory and its contents must survive untouched. */
    expect(readlinkSync.bind(null, targetPath)).toThrow();
  });

  it("leaves a symlink pointing elsewhere untouched and reports it", () => {
    const { sourceDir, targetPath } = setup();
    const otherDir = join(sourceDir, "..", "other-skill");
    mkdirSync(otherDir, { recursive: true });
    mkdirSync(join(targetPath, ".."), { recursive: true });
    symlinkSync(otherDir, targetPath, "dir");

    const outcome = applyLink({ path: targetPath, label: "Claude Code" }, sourceDir);
    expect(outcome.status).toBe("skipped");
    expect(readlinkSync(targetPath)).toBe(otherDir);
  });

  it("removes only a symlink that points at our source", () => {
    const { sourceDir, targetPath } = setup();
    applyLink({ path: targetPath, label: "Claude Code" }, sourceDir);

    const outcome = applyUnlink({ path: targetPath, label: "Claude Code" }, sourceDir);
    expect(outcome.status).toBe("unlinked");
    expect(readlinkSync.bind(null, targetPath)).toThrow();
  });

  it("does not remove a foreign symlink or real directory on unlink", () => {
    const { sourceDir, targetPath } = setup();
    const otherDir = join(sourceDir, "..", "other-skill");
    mkdirSync(otherDir, { recursive: true });
    mkdirSync(join(targetPath, ".."), { recursive: true });
    symlinkSync(otherDir, targetPath, "dir");

    const outcome = applyUnlink({ path: targetPath, label: "Claude Code" }, sourceDir);
    expect(outcome.status).toBe("not-ours");
    expect(readlinkSync(targetPath)).toBe(otherDir);
  });

  it("reports not-linked when nothing exists at the target", () => {
    const { sourceDir, targetPath } = setup();
    const outcome = applyUnlink({ path: targetPath, label: "Claude Code" }, sourceDir);
    expect(outcome.status).toBe("not-linked");
  });
});
