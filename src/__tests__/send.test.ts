import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { args: string[]; input?: string }[] = [];
let captures: string[] = [];

vi.mock("node:child_process", () => ({
  execFile: (_cmd: string, args: string[], callback: (error: Error | null, stdout: string) => void) => {
    const call: { args: string[]; input?: string } = { args };
    calls.push(call);
    const stdout = args[0] === "capture-pane" ? (captures.shift() ?? "") : "";
    queueMicrotask(() => callback(null, stdout));
    return {
      stdin: {
        end: (input: string) => {
          call.input = input;
        },
      },
    };
  },
}));

const { send, composerHoldsInput, findMenu, PromptNotSubmittedError } = await import("../tmux.js");

const verify = {
  idleRegex: /^›\s*(Ask Codex to do anything)?\s*$/,
  composerRegex: /^›\s+(?!Ask Codex to do anything)\S/,
  placeholderRegex: /^›\s+Ask Codex to do anything/,
  busyRegex: /esc to interrupt/,
  menuRegex: /Where should the new conversation run\?/,
};

const claudeVerify = {
  idleRegex: /^❯\s*$/,
  composerRegex: /^❯\s+(?!Try ")\S/,
  placeholderRegex: /^❯\s+Try "/,
  busyRegex: /esc to interrupt/,
};

const STUCK = "› [Pasted Content 2227 chars]\n\n  GPT-6-Astra medium · Context 0% used";
const MENU = "Where should the new conversation run?\n› 1. Use current Git worktree  Keep using the cwd\n  2. Create new Git worktree   Another dir\n  enter select · esc back";
const SUBMITTED = "› [Pasted Content 2227 chars]\n\n• Working (1s • esc to interrupt)\n\n› Ask Codex to do anything";

/** Runs send() under fake timers to completion, returning its settled outcome. */
async function run(text: string, check?: typeof verify) {
  const outcome = send("%9", text, check).then(
    () => ({ ok: true as const }),
    (error: Error) => ({ ok: false as const, error }),
  );
  await vi.advanceTimersByTimeAsync(10_000);
  return outcome;
}

const verbs = () => calls.map((call) => call.args[0]);

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  captures = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("send", () => {
  it("pastes through a named buffer (stdin, bracketed, freed) and then presses Enter", async () => {
    const outcome = await run("line one\nline two");

    expect(outcome.ok).toBe(true);
    const buffer = calls[0]?.args[2] ?? "";
    expect(buffer).toMatch(/^crossagent-\d+-\d+$/);
    expect(calls.map((call) => call.args)).toEqual([
      ["load-buffer", "-b", buffer, "-"],
      ["paste-buffer", "-p", "-d", "-b", buffer, "-t", "%9"],
      ["send-keys", "-t", "%9", "Enter"],
    ]);
    expect(calls[0]?.input).toBe("line one\nline two");
  });

  it("does not capture or retry when the composer is empty after Enter", async () => {
    captures = [SUBMITTED];

    const outcome = await run("hi", verify);

    expect(outcome.ok).toBe(true);
    expect(verbs()).toEqual(["load-buffer", "paste-buffer", "send-keys", "capture-pane"]);
  });

  it("presses Enter once more when the composer still holds the prompt, then succeeds", async () => {
    captures = [STUCK, STUCK, SUBMITTED];

    const outcome = await run("hi", verify);

    expect(outcome.ok).toBe(true);
    expect(verbs()).toEqual(["load-buffer", "paste-buffer", "send-keys", "capture-pane", "capture-pane", "send-keys", "capture-pane"]);
  });

  it("skips the retry Enter when a re-capture before it shows the prompt was submitted meanwhile", async () => {
    captures = [STUCK, SUBMITTED];

    const outcome = await run("hi", verify);

    expect(outcome.ok).toBe(true);
    expect(verbs().filter((verb) => verb === "send-keys")).toHaveLength(1);
  });

  it("uses a unique buffer per send, so concurrent sends cannot paste each other's text", async () => {
    const [a, b] = [send("%1", "text for one"), send("%2", "text for two")];
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([a, b]);

    const loads = calls.filter((call) => call.args[0] === "load-buffer");
    const pastes = calls.filter((call) => call.args[0] === "paste-buffer");
    const nameOf = (call: { args: string[] }) => call.args[call.args.indexOf("-b") + 1];
    expect(new Set(loads.map(nameOf)).size).toBe(2);
    for (const load of loads) {
      const paste = pastes.find((call) => nameOf(call) === nameOf(load));
      expect(paste).toBeDefined();
      expect(load.input).toBe(load.input === "text for one" ? "text for one" : "text for two");
      expect(paste?.args.at(-1)).toBe(load.input === "text for one" ? "%1" : "%2");
    }
  });

  it("throws PromptNotSubmittedError when the prompt is still unsent after the retry", async () => {
    captures = [STUCK, STUCK, STUCK];

    const outcome = await run("hi", verify);

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toBeInstanceOf(PromptNotSubmittedError);
    expect(!outcome.ok && outcome.error.message).toContain("prompt not submitted");
    expect(verbs().filter((verb) => verb === "send-keys")).toHaveLength(2);
  });
});

describe("composerHoldsInput", () => {
  it("is false for the empty composer placeholder", () => {
    expect(composerHoldsInput("• Hi\n\n› Ask Codex to do anything\n\n  GPT-6-Astra", "hi", verify)).toBe(false);
  });

  it("is true when the last prompt line holds pasted input", () => {
    expect(composerHoldsInput(STUCK, "hi", verify)).toBe(true);
  });

  it("ignores scrollback echoes of earlier prompts above the composer", () => {
    expect(composerHoldsInput("› earlier prompt\n• Hi\n\n› Ask Codex to do anything", "hi", verify)).toBe(false);
  });

  it("is false while the harness is busy", () => {
    expect(composerHoldsInput("› queued text\n• Working (2s • esc to interrupt)", "hi", verify)).toBe(false);
  });

  it("treats the Claude placeholder as an empty composer, not the echoed prompt above it", () => {
    const content = ["❯ please review this change", "⏺ Looks fine.", "", "❯ Try \"fix the bug\"", "  ⏵⏵ auto mode on"].join("\n");
    expect(composerHoldsInput(content, "please review this change", claudeVerify)).toBe(false);
  });

  it("treats the Codex placeholder as an empty composer after an echo and reply", () => {
    const content = ["› please review this change", "• Looks fine.", "", "› Ask Codex to do anything", "  GPT-6-Astra"].join("\n");
    expect(composerHoldsInput(content, "please review this change", verify)).toBe(false);
  });

  it("is true for Claude when the composer holds a collapsed paste", () => {
    expect(composerHoldsInput("⏺ earlier\n❯ [Pasted text #1 +30 lines]\n  ⏵⏵ auto mode on", "x".repeat(50), claudeVerify)).toBe(true);
  });

  it("is not fooled by input that literally contains the busy phrase", () => {
    const sent = "if the harness shows esc to interrupt, stop";
    expect(composerHoldsInput(`› ${sent}\n  GPT-6-Astra`, sent, verify)).toBe(true);
    /* continuation line of a multi-line composer, no glyph */
    expect(composerHoldsInput("› first line\nesc to interrupt\n  GPT-6-Astra", "first line\nesc to interrupt", verify)).toBe(true);
  });

  it("still sees a real busy indicator whose shape is not in the sent text", () => {
    expect(composerHoldsInput("› hi\n• Working (6s • esc to interrupt)\n› Ask Codex to do anything", "hi", verify)).toBe(false);
  });

  it("treats a real menu as taken on the reset path (menuRegex set)", () => {
    expect(composerHoldsInput(MENU, "/new", verify)).toBe(false);
  });

  it("does not mistake the menu title typed into the composer for a menu", () => {
    const sent = "Review the text Where should the new conversation run?";
    const noMenu = { ...verify, menuRegex: undefined };
    expect(composerHoldsInput(`› ${sent}\n  GPT-6-Astra`, sent, noMenu)).toBe(true);
    expect(composerHoldsInput(`› ${sent}\n  GPT-6-Astra`, sent, verify)).toBe(true);
    expect(findMenu(`› ${sent}\n  GPT-6-Astra`, verify.menuRegex)).toBeUndefined();
  });

  it("does not look for a menu at all unless the caller asks (discuss path)", () => {
    const { menuRegex: _unused, ...discussVerify } = verify;
    expect(composerHoldsInput(`${MENU}\n› pending text`, "pending text", discussVerify)).toBe(true);
  });

  it("is not pending for a scrollback echo followed by a dialog with no composer", () => {
    const content = ["› please review this", "• Looks fine.", "Allow this command?", "› 1. Yes", "  2. No", "  3. Always", "  enter select · esc back", "  GPT-6-Astra"].join("\n");
    expect(composerHoldsInput(content, "please review this", { ...verify, menuRegex: undefined })).toBe(false);
  });

  it("reports unknown (not pending) when no prompt line is visible, so no extra Enter is sent", () => {
    expect(composerHoldsInput("partial redraw\nGPT-6-Astra medium", "hi", verify)).toBe(false);
  });

  it("finds a long inline composer's prompt line within the widened window", () => {
    const body = Array.from({ length: 30 }, (_, i) => `step ${i + 1} of the plan`);
    const content = `› ${body[0]}\n${body.slice(1).join("\n")}\n  GPT-6-Astra medium\n  ? for shortcuts`;
    expect(composerHoldsInput(content, body.join("\n"), verify)).toBe(false);
  });
});

describe("findMenu", () => {
  it("returns the options and the selected one", () => {
    const menu = findMenu(MENU, verify.menuRegex);
    expect(menu?.options).toEqual(["1. Use current Git worktree Keep using the cwd", "2. Create new Git worktree Another dir"]);
    expect(menu?.selected).toBe(0);
  });

  it("needs at least two numbered options after the title", () => {
    expect(findMenu("Where should the new conversation run?\n  enter select", verify.menuRegex)).toBeUndefined();
  });
});
