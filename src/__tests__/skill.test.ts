import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* Frontmatter must carry only the fields shared by Claude Code and Codex (name, description) —
 * both hosts read the same SKILL.md format, but Claude-only extra fields would be ignored by
 * Codex, so the skill deliberately sticks to the shared subset. */
describe("pair skill frontmatter", () => {
  it("has only name and description, and both are non-empty", () => {
    const path = join(import.meta.dirname, "..", "..", "skills", "pair", "SKILL.md");
    const content = readFileSync(path, "utf8");

    const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
    expect(match).not.toBeNull();

    const frontmatter = match![1]!;
    const keys = frontmatter
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.split(":")[0]!.trim());

    expect(keys).toEqual(["name", "description"]);

    const nameMatch = /^name:\s*(.+)$/m.exec(frontmatter);
    const descriptionMatch = /^description:\s*(.+)$/m.exec(frontmatter);
    expect(nameMatch?.[1]?.trim()).toBe("pair");
    expect(descriptionMatch?.[1]?.trim().length).toBeGreaterThan(0);
  });
});
