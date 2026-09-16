import { describe, expect, it } from "vitest";
import { parseVerdict, extractReview, briefPreamble, reviewPreamble } from "../protocol.js";

describe("parseVerdict", () => {
  it("parses a plain VERDICT line", () => {
    const result = parseVerdict("Looks fine to me.\n\nVERDICT: AGREE");
    expect(result.verdict).toBe("AGREE");
    expect(result.rationale).toBe("Looks fine to me.");
  });

  it("parses Codex bullet style", () => {
    const result = parseVerdict("Some analysis here.\n• VERDICT: ADJUST\nExtra text ignored by the regex line match.");
    expect(result.verdict).toBe("ADJUST");
    expect(result.rationale).not.toContain("VERDICT");
  });

  it("parses Claude's ⏺ bullet style", () => {
    const result = parseVerdict("⏺ VERDICT: OBJECT\n\nThis breaks the auth flow.");
    expect(result.verdict).toBe("OBJECT");
    expect(result.rationale).toContain("breaks the auth flow");
  });

  it("parses a markdown-bolded verdict label", () => {
    const result = parseVerdict("**VERDICT:** ESCALATE\n\nOnly the requester can decide pricing.");
    expect(result.verdict).toBe("ESCALATE");
  });

  it("returns UNPARSED when no verdict line is present", () => {
    const result = parseVerdict("I looked at this but forgot to conclude.");
    expect(result.verdict).toBe("UNPARSED");
    expect(result.rationale).toBe("I looked at this but forgot to conclude.");
  });

  it("finds the verdict even when it is not the last line", () => {
    const result = parseVerdict("VERDICT: AGREE\n\nAdditional trailing notes after the verdict line.");
    expect(result.verdict).toBe("AGREE");
    expect(result.rationale).toContain("Additional trailing notes");
  });

  it("is case-insensitive on both the label and the verdict word", () => {
    const result = parseVerdict("verdict: agree");
    expect(result.verdict).toBe("AGREE");
  });
});

describe("extractReview", () => {
  it("extracts only the final answer from a transcript with echoed preamble, tool-activity log, and separator before the answer (live-observed shape)", () => {
    const transcript = [
      "line and nothing after it.",
      "please review this implementation",
      "• Ran ls -la",
      "└ total 12 files",
      "• Explored src/",
      "│ reading protocol.ts",
      "… +40 lines",
      "───────────",
      "This looks solid overall. One nit: the retry loop could leak a timer.",
      "VERDICT: ADJUST",
    ].join("\n");

    const result = extractReview(transcript);

    expect(result.verdict).toBe("ADJUST");
    expect(result.rationale).toBe("This looks solid overall. One nit: the retry loop could leak a timer.");
    expect(result.rationale).not.toContain("Ran ls");
    expect(result.rationale).not.toContain("───");
  });

  it("extracts the exact REVIEW…VERDICT block when the REVIEW marker is present", () => {
    const transcript = [
      "some echoed noise before",
      "• Ran a command",
      "REVIEW: The auth check is missing on the new endpoint.",
      "This could allow unauthenticated access.",
      "VERDICT: OBJECT",
    ].join("\n");

    const result = extractReview(transcript);

    expect(result.verdict).toBe("OBJECT");
    expect(result.rationale).toBe("The auth check is missing on the new endpoint.\nThis could allow unauthenticated access.");
  });

  it("does not strip tool-activity-looking lines from inside a REVIEW…VERDICT block", () => {
    const transcript = [
      "REVIEW: The function does this: └ recurses on failure, which • Ran fine in my test.",
      "VERDICT: AGREE",
    ].join("\n");

    const result = extractReview(transcript);

    expect(result.verdict).toBe("AGREE");
    expect(result.rationale).toContain("• Ran fine");
    expect(result.rationale).toContain("└ recurses");
  });

  it("returns a short/empty rationale for a brief ack", () => {
    const transcript = "REVIEW: understood\nVERDICT: AGREE";

    const result = extractReview(transcript);

    expect(result.verdict).toBe("AGREE");
    expect(result.rationale).toBe("understood");
  });

  it("falls back to parseVerdict-like behavior when no REVIEW marker or separator is present", () => {
    const result = extractReview("Looks fine to me.\n\nVERDICT: AGREE");

    expect(result.verdict).toBe("AGREE");
    expect(result.rationale).toBe("Looks fine to me.");
  });
});

describe("briefPreamble", () => {
  it("states the must-not-write rule and the verdict instruction", () => {
    const text = briefPreamble("codex", "/repo/path");
    expect(text).toContain("MUST NOT edit, create, or delete files, commit");
    expect(text).toContain("REVIEW:");
    expect(text).toContain("VERDICT: AGREE|ADJUST|OBJECT|ESCALATE");
    expect(text).toContain("codex");
    expect(text).toContain("/repo/path");
  });
});

describe("reviewPreamble", () => {
  it("reminds about the REVIEW/VERDICT shape for each kind", () => {
    for (const kind of ["plan", "implementation", "question"] as const) {
      expect(reviewPreamble(kind)).toContain("REVIEW:");
      expect(reviewPreamble(kind)).toContain("VERDICT: AGREE|ADJUST|OBJECT|ESCALATE");
    }
  });
});
