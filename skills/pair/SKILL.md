---
name: pair
description: Pair-program with the peer coding agent in another tmux pane via the crossagent MCP — brief it as a same-level copilot, get its verdict on plans and implementations, iterate to consensus, stop only on decisions the human must make. Not for solo work or when no peer pane exists.
---

# pair

You are the **driver**: you plan, implement, and decide. The peer pane running in
another tmux tab/window is a **same-level copilot and reviewer** — it reads the
repo and runs read-only checks, but it never writes, and it is not an approver
and not a senior. Treat its disagreement as signal, not as a veto you must
satisfy before proceeding.

## Setup

1. Call `ping` once to register your own pane identity.
2. Call `list_peers` with `scope: "repo"`.
   - Exactly one peer → use it for the rest of the session.
   - No peers → tell the user there is no peer pane and continue solo.
   - More than one peer → ask the user which pane to pair with.
3. `brief` the target pane once per session. `discuss` auto-briefs it if it
   hasn't been briefed yet, so an explicit `brief` call is only needed up
   front or to reset a polluted/stale peer session — use `force: true` in
   that case.

## When to call `discuss`

- **`kind: "plan"`** — after drafting a plan, before writing any code.
- **`kind: "implementation"`** — after implementing and tests pass, before
  committing or opening a PR. Include what changed, how it was verified, and
  either the diff or precise `file:line` pointers.
- **`kind: "question"`** — on a genuine two-way architectural fork you cannot
  resolve alone.

Always give the peer concrete paths and the diff — never make it hunt for
context across the repo.

## Verdict handling

- **AGREE** — proceed.
- **ADJUST** — apply the listed corrections, or argue back with facts if one
  is wrong, then re-`discuss` the delta (not the whole thing again).
- **OBJECT** — do not proceed as-is. Fix the issue or argue against it, then
  re-`discuss`.
- **ESCALATE** — stop. Put the peer's exact question to the user, with both
  positions and what each costs. Never resolve it yourself by picking one.
- **UNPARSED** — ask the peer to re-send its reply with a proper `REVIEW:` /
  `VERDICT:` block.

## Consensus loop

Cap at **3 rounds per topic**. If round 3 still isn't AGREE, stop looping —
report both positions to the user in a few lines. Do not average them, and
do not keep re-asking hoping for a different answer.

## Always the human's call — ESCALATE, don't decide

- Product or scope decisions.
- Irreversible actions: deploys, migrations, deletes, pushes to shared
  branches.
- Anything that conflicts with an explicit user instruction.
- Data only the user has access to.

## Hygiene

- Keep every message to the peer self-contained — it has its own context and
  has not seen your earlier turns beyond what you send it in this session.
- Never send secrets or personal data to the peer pane.
- Never ask the peer to edit, create, or delete anything — it is read-only
  by role, even though the tool layer does not enforce that.
