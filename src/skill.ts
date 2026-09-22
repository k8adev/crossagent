import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root is one level above this module's directory — dist/skill.js or src/skill.ts via tsx, from a local checkout and from an npx install alike. */
export function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function skillPath(): string {
  return join(packageRoot(), "skills", "pair", "SKILL.md");
}

/** Drops the YAML frontmatter block, which is host metadata (name/description) rather than protocol content. */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

let cached: string | undefined;

/**
 * Reads the packaged `pair` SKILL.md body, cached for the process lifetime. Throws a message
 * naming the expected path when the file is missing, so `prompts/get` can fail soft.
 */
export function loadPairSkill(): string {
  if (cached !== undefined) {
    return cached;
  }
  const path = skillPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`crossagent could not read the pair skill at ${path}: ${(error as Error).message}`);
  }
  cached = stripFrontmatter(raw);
  return cached;
}
