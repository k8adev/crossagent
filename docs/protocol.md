# Pairing protocol

How `discuss` implements review on top of the raw MCP primitives.

`discuss` implements a lightweight review protocol on top of the raw
`send`/`read`/`wait_reply` primitives. The peer pane is a **same-level
copilot**, not a senior and not an approver — it may read the repo and run
read-only commands/tests (it shares the driver's cwd) but must never write.
Because the peer harness has no crossagent skill of its own, every rule it
must follow travels inside every message `discuss` sends it.

**Roles**: the driver calls the tools and implements; the peer reviews plans
and implementations for gaps, security flaws, convention violations,
business-logic errors, and missing tests, and disagrees when it disagrees.

**Reply shape**: every peer reply is bracketed by a `REVIEW:` line (the actual
answer — analysis or findings) and ends
with a `VERDICT: <word>` line, with nothing after it. `extractReview` finds
the LAST `REVIEW:` line and the first `VERDICT:` line after it and returns
the text between as the rationale; a peer that skips the `REVIEW:` marker
falls back to the text between the last separator line (e.g. `───`) before
`VERDICT:` and `VERDICT:` itself, with known tool-activity log lines (`•
Ran …`, `└ …`, `… +N lines`) stripped — this keeps a TUI's echoed prompt and
tool-activity log out of the rationale when the coarse echo-anchor in
`extractReply` doesn't cleanly separate them.

**Verdicts**: every peer reply ends with one `VERDICT: <word>` line —

- `AGREE` — no corrections.
- `ADJUST` — agree if the listed corrections are made.
- `OBJECT` — do not proceed; reasons given.
- `ESCALATE` — a decision only the human requester can make (product/scope,
  irreversible, conflicts with their instruction, data only they have).
- `UNPARSED` — the reply had no recognizable `VERDICT:` line (returned by
  `parseVerdict`, along with the raw reply, so the caller can retry or ask
  again).

**Flow**: `discuss(pane, message, kind)` sends one review round as a single
message: a short role brief (same-level read-only copilot, the
`REVIEW:`/`VERDICT:` contract, one framing line for the `kind`) followed by
your message. The brief travels with every round, so the peer needs no
session state and there is no acknowledgement round-trip. `brief(pane)` is
reset-only: it sends the harness's `reset_command` (if configured), waits for
the pane to settle, and restarts that pane's round counter. `ask_review` is
`discuss` with `kind: "implementation"`.

**Submit verification**: text goes in through a tmux paste buffer
(`load-buffer` + `paste-buffer -p`) followed by Enter. Where the harness has a
`composer_regex`, the pane is captured after Enter; if the input box still
holds the text, Enter is sent once more after a longer pause, and a second
failure raises `prompt not submitted` instead of waiting out the idle
timeout. This applies to the reset command too.

**Consensus loop and escalation are driven by the caller** (e.g. a skill
wrapping these tools): keep calling `discuss` with follow-ups until the
verdict is `AGREE`, or stop and surface the question to the human requester
on `ESCALATE`. crossagent itself does not loop or escalate on its own.
