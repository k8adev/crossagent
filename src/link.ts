import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface LinkTarget {
  /** Absolute path to the symlink destination (e.g. ~/.claude/skills/pair). */
  path: string;
  /** Short label for reporting (e.g. "Claude Code"). */
  label: string;
}

export type LinkOutcome =
  | { status: "linked"; target: LinkTarget }
  | { status: "already-linked"; target: LinkTarget }
  | { status: "skipped"; target: LinkTarget; reason: string }
  | { status: "unlinked"; target: LinkTarget }
  | { status: "not-ours"; target: LinkTarget }
  | { status: "not-linked"; target: LinkTarget };

/** Resolves the three per-host skill directories the `pair` skill links into. Honors $CODEX_HOME when set. */
export function planLinks(homeDir: string, codexHome: string | undefined): LinkTarget[] {
  const codexSkillsDir = codexHome ? codexHome : join(homeDir, ".codex");
  return [
    { path: join(homeDir, ".claude", "skills", "pair"), label: "Claude Code" },
    { path: join(codexSkillsDir, "skills", "pair"), label: "Codex CLI" },
    { path: join(homeDir, ".agents", "skills", "pair"), label: "Agents (generic)" },
  ];
}

/**
 * Creates a symlink at `target.path` pointing at `sourceDir`, unless something already occupies
 * it. A symlink already pointing at our source is a no-op reported as "already-linked"; anything
 * else at that path (a real dir/file, or a symlink elsewhere) is left untouched and reported.
 */
export function applyLink(target: LinkTarget, sourceDir: string): LinkOutcome {
  const resolvedSource = resolve(sourceDir);

  if (existsSync(target.path) || isDanglingSymlink(target.path)) {
    const stat = lstatSync(target.path);
    if (stat.isSymbolicLink()) {
      const linkTarget = resolve(dirname(target.path), readlinkSync(target.path));
      if (linkTarget === resolvedSource) {
        return { status: "already-linked", target };
      }
      return { status: "skipped", target, reason: `symlink already points elsewhere (${linkTarget})` };
    }
    return { status: "skipped", target, reason: "a real file or directory already exists at this path" };
  }

  mkdirSync(dirname(target.path), { recursive: true });
  symlinkSync(resolvedSource, target.path, "dir");
  return { status: "linked", target };
}

/** Removes the symlink at `target.path` only if it points at `sourceDir`. Anything else is left alone. */
export function applyUnlink(target: LinkTarget, sourceDir: string): LinkOutcome {
  const resolvedSource = resolve(sourceDir);

  if (!existsSync(target.path) && !isDanglingSymlink(target.path)) {
    return { status: "not-linked", target };
  }

  const stat = lstatSync(target.path);
  if (!stat.isSymbolicLink()) {
    return { status: "not-ours", target };
  }

  const linkTarget = resolve(dirname(target.path), readlinkSync(target.path));
  if (linkTarget !== resolvedSource) {
    return { status: "not-ours", target };
  }

  rmSync(target.path);
  return { status: "unlinked", target };
}

/* lstatSync on a dangling symlink succeeds (unlike existsSync, which follows the link and reports false). */
function isDanglingSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function describeOutcome(outcome: LinkOutcome): string {
  switch (outcome.status) {
    case "linked":
      return `${outcome.target.label}: linked -> ${outcome.target.path}`;
    case "already-linked":
      return `${outcome.target.label}: already linked (${outcome.target.path})`;
    case "skipped":
      return `${outcome.target.label}: skipped (${outcome.reason}) — remove ${outcome.target.path} manually if you want it replaced`;
    case "unlinked":
      return `${outcome.target.label}: unlinked (${outcome.target.path})`;
    case "not-ours":
      return `${outcome.target.label}: left alone — ${outcome.target.path} is not a symlink to our skill`;
    case "not-linked":
      return `${outcome.target.label}: nothing to unlink (${outcome.target.path})`;
  }
}
