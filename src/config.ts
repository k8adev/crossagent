import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

export const CONFIG_PATH = join(homedir(), ".config", "crossagent", "config.toml");

export interface HarnessConfig {
  idleRegex: string;
  busyRegex?: string;
  /** Slash command (or similar) that resets the harness's conversation state before a brief. Undefined when the harness has no known one. */
  resetCommand?: string;
}

export interface CrossagentConfig {
  harness: Record<string, HarnessConfig>;
  defaults: {
    timeoutMs: number;
    quietMs: number;
    tailLines: number;
  };
}

/*
 * Best-effort defaults captured from live panes (see worktree notes): Claude Code's idle prompt
 * is a bare "❯" that is NOT the last line (status lines follow it), so idleRegex is matched
 * against a tail window rather than only the last line. Codex's idle prompt is "› Ask Codex to
 * do anything" (placeholder text may or may not be present) and its screen is sprinkled with
 * animated braille glyphs even while idle, which normalize() strips before comparison. Both
 * harnesses show a busy line containing "esc to interrupt" while working — busyRegex overrides
 * idleRegex whenever it matches anywhere in the tail window. Still best-effort: expect to tune
 * manually against real sessions.
 */
const DEFAULT_CONFIG: CrossagentConfig = {
  harness: {
    claude: {
      idleRegex: "^❯\\s*$",
      busyRegex: "esc to interrupt",
      resetCommand: "/clear",
    },
    codex: {
      idleRegex: "^›\\s*(Ask Codex to do anything)?\\s*$",
      busyRegex: "esc to interrupt",
      resetCommand: "/new",
    },
    unknown: {
      idleRegex: "^[>❯›$%]\\s*$",
      busyRegex: "esc to interrupt",
      /* No known reset command for an unrecognized harness. */
      resetCommand: undefined,
    },
  },
  defaults: {
    timeoutMs: 300_000,
    quietMs: 1_500,
    tailLines: 8,
  },
};

/** Loads `~/.config/crossagent/config.toml`, merging it onto built-in defaults. Missing file is not an error. */
export async function loadConfig(path: string = CONFIG_PATH): Promise<CrossagentConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return DEFAULT_CONFIG;
  }

  const parsed = parse(raw) as Partial<{
    harness: Record<string, Partial<{ idle_regex: string; busy_regex: string; reset_command: string }>>;
    defaults: Partial<{ timeout_ms: number; quiet_ms: number; tail_lines: number }>;
  }>;

  const harness: Record<string, HarnessConfig> = { ...DEFAULT_CONFIG.harness };
  for (const [name, config] of Object.entries(parsed.harness ?? {})) {
    const base = harness[name] ?? DEFAULT_CONFIG.harness.unknown!;
    harness[name] = {
      idleRegex: config?.idle_regex ?? base.idleRegex,
      busyRegex: config?.busy_regex ?? base.busyRegex,
      resetCommand: config?.reset_command ?? base.resetCommand,
    };
  }

  return {
    harness,
    defaults: {
      timeoutMs: parsed.defaults?.timeout_ms ?? DEFAULT_CONFIG.defaults.timeoutMs,
      quietMs: parsed.defaults?.quiet_ms ?? DEFAULT_CONFIG.defaults.quietMs,
      tailLines: parsed.defaults?.tail_lines ?? DEFAULT_CONFIG.defaults.tailLines,
    },
  };
}

export function getIdleRegex(config: CrossagentConfig, harnessName: string): RegExp {
  const entry = config.harness[harnessName] ?? config.harness.unknown;
  /* Falls back to a generic prompt shape when the harness is unrecognized. */
  const pattern = entry?.idleRegex ?? "^[>$#›]\\s*$";
  return new RegExp(pattern);
}

export function getBusyRegex(config: CrossagentConfig, harnessName: string): RegExp | undefined {
  const entry = config.harness[harnessName] ?? config.harness.unknown;
  const pattern = entry?.busyRegex;
  return pattern ? new RegExp(pattern) : undefined;
}

export function getResetCommand(config: CrossagentConfig, harnessName: string): string | undefined {
  const entry = config.harness[harnessName] ?? config.harness.unknown;
  return entry?.resetCommand;
}
