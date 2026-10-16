/* Pairing protocol primitives: verdict vocabulary and the preamble text sent to the peer harness. */

export const VERDICTS = ["AGREE", "ADJUST", "OBJECT", "ESCALATE"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Returned when a reply has no recognizable `VERDICT:` line. */
export type ParsedVerdict = Verdict | "UNPARSED";

export interface VerdictResult {
  verdict: ParsedVerdict;
  /** The reply with the verdict line removed. */
  rationale: string;
}

/* Matches a line that is (optionally) a bullet/markdown-wrapped `REVIEW:` label, case-insensitive.
 * Tolerates the same leading noise as VERDICT_LINE since peers echo/format similarly. */
const REVIEW_LINE = /^[\s•⏺*_-]*\**\s*review\s*:\**\s*/i;

/* A separator line made of 3+ box-drawing dashes/characters, sometimes emitted by TUIs between
 * the echoed prompt/tool log and the actual final answer. */
const SEPARATOR_LINE = /^[\s─—-]{3,}$/;

/**
 * Lines a TUI emits while a peer harness is working (tool-activity log), which end up sandwiched
 * between the echoed prompt and the peer's actual final answer when extractReply's anchor fails
 * to match (e.g. because the terminal re-wrapped the echoed text). Stripped only on the fallback
 * path — never inside a REVIEW…VERDICT block, where they could be genuine review content.
 */
const TOOL_ACTIVITY_LINE = /^[•⏺]\s*(Ran|Explored|Started|Interacted|Completed|Hook failed)\b|^[└│]|^…\s*\+\d+\s*lines/;

export interface ReviewResult {
  /** The verdict found after the REVIEW marker (or fallback path), if any. */
  verdict: ParsedVerdict;
  /** The extracted rationale block, with markers/noise removed. */
  rationale: string;
}

/**
 * Extracts the peer's actual final answer from a normalized transcript, bracketed by a `REVIEW:`
 * marker line and the `VERDICT:` line that ends it. Falls back, when no `REVIEW:` marker is
 * found, to the text between the last separator line before VERDICT and VERDICT itself, with
 * known tool-activity log lines stripped; if that also yields nothing, falls back further to
 * parseVerdict's plain behavior (whole text minus the VERDICT line).
 */
export function extractReview(normalizedText: string): ReviewResult {
  const lines = normalizedText.split("\n");
  const verdictIndex = lines.findIndex((line) => VERDICT_LINE.test(line));

  const reviewIndices = lines.reduce<number[]>((acc, line, index) => {
    if (REVIEW_LINE.test(line)) acc.push(index);
    return acc;
  }, []);
  const lastReviewIndex = reviewIndices.length > 0 ? reviewIndices.at(-1)! : -1;

  if (lastReviewIndex !== -1 && (verdictIndex === -1 || lastReviewIndex < verdictIndex)) {
    const end = verdictIndex === -1 ? lines.length : verdictIndex;
    const afterMarker = lines[lastReviewIndex]!.replace(REVIEW_LINE, "").trim();
    const body = lines.slice(lastReviewIndex + 1, end).join("\n").trim();
    const rationale = [afterMarker, body].filter((part) => part.length > 0).join("\n").trim();
    return {
      verdict: verdictIndex === -1 ? "UNPARSED" : extractVerdictWord(lines[verdictIndex]!),
      rationale,
    };
  }

  if (verdictIndex !== -1) {
    const separatorIndices = lines
      .slice(0, verdictIndex)
      .reduce<number[]>((acc, line, index) => {
        if (SEPARATOR_LINE.test(line)) acc.push(index);
        return acc;
      }, []);
    if (separatorIndices.length > 0) {
      const lastSeparator = separatorIndices.at(-1)!;
      const rationale = lines
        .slice(lastSeparator + 1, verdictIndex)
        .filter((line) => !TOOL_ACTIVITY_LINE.test(line))
        .join("\n")
        .trim();
      return { verdict: extractVerdictWord(lines[verdictIndex]!), rationale };
    }
  }

  const fallback = parseVerdict(normalizedText);
  const rationale = fallback.rationale
    .split("\n")
    .filter((line) => !TOOL_ACTIVITY_LINE.test(line))
    .join("\n")
    .trim();
  return { verdict: fallback.verdict, rationale };
}

function extractVerdictWord(verdictLine: string): ParsedVerdict {
  const match = VERDICT_LINE.exec(verdictLine);
  if (!match) return "UNPARSED";
  return match[1]!.toUpperCase() as Verdict;
}

/* Matches a line that is (optionally) a bullet/markdown-wrapped `VERDICT:` label, case-insensitive,
 * followed by one of the known verdict words. Captures the verdict word for lookup against VERDICTS. */
const VERDICT_LINE = /^[\s•⏺*_-]*\**\s*verdict\s*:\**\s*(agree|adjust|object|escalate)\b/i;

/**
 * Finds a `VERDICT: <word>` line anywhere in the reply (peers may not put it last, even though
 * the preamble asks for that), tolerating leading bullets/markdown (`• `, `**`). Returns the
 * matched verdict and the rest of the reply with that line stripped.
 */
export function parseVerdict(replyText: string): VerdictResult {
  const lines = replyText.split("\n");
  const matchIndex = lines.findIndex((line) => VERDICT_LINE.test(line));

  if (matchIndex === -1) {
    return { verdict: "UNPARSED", rationale: replyText.trim() };
  }

  const match = VERDICT_LINE.exec(lines[matchIndex]!);
  const verdict = match![1]!.toUpperCase() as Verdict;
  const rationale = lines
    .filter((_, index) => index !== matchIndex)
    .join("\n")
    .trim();

  return { verdict, rationale };
}

/** What the driver is bringing to the peer; picks the one-line framing in the brief. */
export type ReviewKind = "plan" | "implementation" | "question";

const KIND_LINES: Record<ReviewKind, string> = {
  plan: "This is a PLAN, before any code is written: look for gaps, risks and missing considerations.",
  implementation: "This is an IMPLEMENTATION: check the actual diff/code for correctness, security, convention violations and missing tests.",
  question: "This is a QUESTION, not a plan or a diff: answer it directly.",
};

/**
 * Role brief prepended to every `discuss` message, so the peer needs no prior session state: a
 * same-level copilot (not a senior, not an approver), its read-only boundary, and the reply
 * contract. The peer harness has no crossagent skill, so every rule it must obey travels inside
 * this text. Kept short on purpose — it is paid for on every round.
 */
export function briefPreamble(harnessName: string, repoPath: string, kind: ReviewKind): string {
  return [
    `You are ${harnessName}, a same-level copilot (not a senior, not an approver) reviewing for another coding agent, the driver, on the repo at ${repoPath}. Review plans and implementations; read .agents/rules, AGENTS.md and CLAUDE.md if present. You MAY read files and run read-only checks and tests; you MUST NOT edit, create, delete or commit, nor run anything that changes state (installs, migrations, pushes, writes). Disagree when you disagree.`,
    KIND_LINES[kind],
    "Reply with a `REVIEW:` line holding your answer, then end with exactly one final line, nothing after it: `VERDICT: AGREE|ADJUST|OBJECT|ESCALATE`.",
    "AGREE = no corrections. ADJUST = agree if your listed corrections are made. OBJECT = do not proceed. ESCALATE = a decision only the human must make.",
  ].join("\n");
}
