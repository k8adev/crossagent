import { describe, expect, it, vi } from "vitest";
import { waitIdle, WaitIdleTimeoutError, normalize, extractReply } from "../tmux.js";

describe("waitIdle", () => {
  it("resolves once the last line matches idleRegex and content has been stable for quietMs", async () => {
    vi.useFakeTimers();
    const captures = ["running...\n$ ", "running...\n$ ", "running...\n$ "];
    let call = 0;
    const capturePane = vi.fn(async () => captures[Math.min(call++, captures.length - 1)] ?? "");

    const promise = waitIdle(capturePane, {
      idleRegex: /^\$\s*$/,
      timeoutMs: 10_000,
      pollMs: 100,
      quietMs: 300,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe("running...\n$ ");
    vi.useRealTimers();
  });

  it("keeps waiting while content keeps changing, then resolves once stable", async () => {
    vi.useFakeTimers();
    const captures = ["a", "b", "c", "c", "c", "c"];
    let call = 0;
    const capturePane = vi.fn(async () => captures[Math.min(call++, captures.length - 1)] ?? "c");

    const promise = waitIdle(capturePane, {
      idleRegex: /^c$/,
      timeoutMs: 10_000,
      pollMs: 100,
      quietMs: 250,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe("c");
    vi.useRealTimers();
  });

  it("rejects with WaitIdleTimeoutError and the last tail when it never becomes idle", async () => {
    vi.useFakeTimers();
    const capturePane = vi.fn(async () => "still running...\n");

    const promise = waitIdle(capturePane, {
      idleRegex: /^\$\s*$/,
      timeoutMs: 500,
      pollMs: 100,
      quietMs: 100,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(WaitIdleTimeoutError);

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });

  it("matches idleRegex against a tail window when the prompt is not the last line (Claude Code shape)", async () => {
    vi.useFakeTimers();
    const claudeIdleTail = [
      "some output",
      "❯",
      "──────────────",
      "  getsolu (main) +0 -0",
      "  Fable 5.1 5% · 1m",
      "  auto mode on (shift+tab to cycle) · 1 agent",
    ].join("\n");
    const capturePane = vi.fn(async () => claudeIdleTail);

    const promise = waitIdle(capturePane, {
      idleRegex: /^❯\s*$/,
      timeoutMs: 10_000,
      pollMs: 100,
      quietMs: 200,
      tailLines: 8,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe(claudeIdleTail);
    vi.useRealTimers();
  });

  it("stays busy when busyRegex matches anywhere in the tail window, even if idleRegex also matches", async () => {
    vi.useFakeTimers();
    const busyTail = ["❯", "spinner... esc to interrupt"].join("\n");
    const idleTail = ["❯", "──────────────"].join("\n");
    const captures = [busyTail, busyTail, busyTail, idleTail, idleTail, idleTail];
    let call = 0;
    const capturePane = vi.fn(async () => captures[Math.min(call++, captures.length - 1)] ?? idleTail);

    const promise = waitIdle(capturePane, {
      idleRegex: /^❯\s*$/,
      busyRegex: /esc to interrupt/,
      timeoutMs: 10_000,
      pollMs: 100,
      quietMs: 200,
      tailLines: 8,
    });

    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toBe(idleTail);
    vi.useRealTimers();
  });

  it("ignores animated braille noise when checking stability (Codex spinner)", async () => {
    vi.useFakeTimers();
    // Same visible content, different braille frames each poll — should still be considered stable.
    const frames = [
      "› Ask Codex to do anything⠁⠀  ⠂\n  getsolu · main",
      "› Ask Codex to do anything⠠⡀  ⠐\n  getsolu · main",
      "› Ask Codex to do anything⠈⠂  ⠄\n  getsolu · main",
    ];
    let call = 0;
    const capturePane = vi.fn(async () => frames[Math.min(call++, frames.length - 1)] ?? frames[0]!);

    const promise = waitIdle(capturePane, {
      idleRegex: /^›\s*(Ask Codex to do anything)?\s*$/,
      timeoutMs: 10_000,
      pollMs: 100,
      quietMs: 250,
      tailLines: 8,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe(frames[frames.length - 1]);
    vi.useRealTimers();
  });

  it("matches codex idle prompt with and without the placeholder text", async () => {
    vi.useFakeTimers();
    const withPlaceholder = "› Ask Codex to do anything\n  getsolu · main";
    const withoutPlaceholder = "› \n  getsolu · main";
    const idleRegex = /^›\s*(Ask Codex to do anything)?\s*$/;

    const capturePane1 = vi.fn(async () => withPlaceholder);
    const promise1 = waitIdle(capturePane1, {
      idleRegex,
      timeoutMs: 10_000,
      pollMs: 100,
      quietMs: 200,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise1).toBe(withPlaceholder);

    const capturePane2 = vi.fn(async () => withoutPlaceholder);
    const promise2 = waitIdle(capturePane2, {
      idleRegex,
      timeoutMs: 10_000,
      pollMs: 100,
      quietMs: 200,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise2).toBe(withoutPlaceholder);

    vi.useRealTimers();
  });
});

describe("normalize", () => {
  it("strips braille block chars, collapses whitespace, trims lines, and drops empty lines", () => {
    const input = "line one⠀⣿   with   spaces  \n\n  \n› Ask Codex\n";
    expect(normalize(input)).toBe("line one with spaces\n› Ask Codex");
  });
});

describe("extractReply", () => {
  it("extracts only the reply from a Codex transcript (banner, echoed prompt, reply, idle prompt, status line)", () => {
    const sentText = "You are reviewing a change from a peer coding agent over crossagent. Reply with concrete, actionable feedback.\n\nplease review";
    const before = "› Ask Codex to do anything\n  getsolu · main";
    const after = [
      "codex banner v1.2.3",
      "› You are reviewing a change from a peer coding agent over crossagent. Reply with",
      "concrete, actionable feedback.",
      "",
      "please review",
      "You are reviewing a change from a peer coding agent over crossagent. Reply with concrete,",
      "actionable feedback.",
      "",
      "please review",
      "• OK crossagent",
      "› Ask Codex to do anything",
      "  getsolu · main",
    ].join("\n");
    const codexIdleRegex = /^›\s*(Ask Codex to do anything)?\s*$/;

    const result = extractReply({ sentText, before, after, idleRegex: codexIdleRegex });

    expect(result.reply).toBe("• OK crossagent");
    expect(result.rawTail).toBeUndefined();
  });

  it("extracts only the reply from a Claude-shaped transcript (⏺ reply, ❯, then status lines)", () => {
    const sentText = "please review this change";
    const before = "❯\n──────────────\n  getsolu (main) +0 -0";
    const after = [
      "please review this change",
      "⏺ Looks good, ship it.",
      "❯",
      "──────────────",
      "  getsolu (main) +0 -0",
      "  Fable 5.1 5% · 1m",
    ].join("\n");
    const claudeIdleRegex = /^❯\s*$/;

    const result = extractReply({ sentText, before, after, idleRegex: claudeIdleRegex, tailLines: 8 });

    expect(result.reply).toBe("⏺ Looks good, ship it.");
  });

  it("falls back to the new-content-since-before diff when the sent text is not found in the capture", () => {
    const sentText = "this text scrolled out of the capture window";
    const before = "old line 1\nold line 2";
    const after = "old line 1\nold line 2\nnew reply line\n❯";
    const idle = /^❯\s*$/;

    const result = extractReply({ sentText, before, after, idleRegex: idle });

    expect(result.reply).toBe("new reply line");
  });

  it("finds the echoed prompt even when the TUI re-wraps its last line across multiple screen lines", () => {
    const sentText = "please review this long implementation message that will definitely get wrapped by a narrow terminal";
    const before = "❯\n──────────────";
    const after = [
      "please review this long implementation message that will",
      "definitely get wrapped by a narrow terminal",
      "⏺ Looks solid, ship it.",
      "❯",
      "──────────────",
    ].join("\n");
    const idle = /^❯\s*$/;

    const result = extractReply({ sentText, before, after, idleRegex: idle, tailLines: 8 });

    expect(result.reply).toBe("⏺ Looks solid, ship it.");
  });

  it("returns rawTail when the extracted reply is empty, for debugging", () => {
    const sentText = "hello";
    const before = "";
    const after = "hello\n❯";
    const idle = /^❯\s*$/;

    const result = extractReply({ sentText, before, after, idleRegex: idle, tailLines: 8 });

    expect(result.reply).toBe("");
    expect(result.rawTail).toBe("hello\n❯");
  });
});
