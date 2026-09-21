# crossagent

`crossagent-mcp` is a stdio MCP server that lets two coding-agent harnesses
(Claude Code, Codex CLI, …) running in different tmux panes pair-program:
one drives, the other reviews. Both harnesses load the same server binary.
All communication between the two agents goes through tmux — there is no
network transport, no shared file, no socket.

## How discovery and self-declaration work

Each pane running crossagent computes its own identity on startup:

- **pane** — resolution does not rely on environment variables alone.
  It prefers `$TMUX_PANE`, but falls back to walking the ancestor pid chain
  (the same `ps`-based lookup used for harness detection) and intersecting
  it with live `pane_pid`s from `tmux list-panes -a`; the first ancestor
  that matches a pane_pid identifies the pane. This matters because some
  harnesses start the MCP server with a filtered environment — e.g. Codex
  CLI with `shell_environment_policy.inherit = "core"` strips `TMUX_PANE`
  even though the process is genuinely running inside a tmux pane. `ping`
  reports which path resolved the pane via `pane_source: "env" |
  "process-tree" | null`. If neither path finds a pane (no tmux server
  reachable, or no ancestor matches a live pane), the server runs in
  **degraded mode**: it still starts and answers MCP requests, but any tool
  that needs a pane returns a clear "not inside tmux" error, and `ping`
  includes a `reason` string explaining what failed.
- **harness** — detected by walking up the process tree from `process.ppid`
  with `ps -o ppid=,comm=,args= -p <pid>` until a known binary is found
  (`claude`, `codex`, `gemini`, `opencode`, `cursor-agent`). Unknown → `unknown`.
- **repo** — `git rev-parse --path-format=absolute --git-common-dir` run
  from the process cwd, so worktrees of the same repo share one identity;
  falls back to the raw cwd outside a git repo.

The pane then **self-declares** this identity onto its own tmux pane as
user options: `@crossagent_harness`, `@crossagent_repo`, `@crossagent_pid`.
Peer discovery (`list_peers`) reads these options off every pane via
`tmux list-panes -a`. A peer that hasn't declared yet is still visible, but
marked `declared: false`; scope `repo` then falls back to a heuristic (does
the peer's current directory resolve to the same git common dir?).

### Lazy-start caveat (Codex)

Codex CLI starts MCP servers **lazily**, only on first tool call. That means
a Codex pane's `@crossagent_harness` option may not exist yet even though
crossagent is configured for it — registration only happens once some tool
(most simply `ping`) actually runs. Until then, that pane is discoverable
only via the repo-path heuristic above, not by its declared identity.

## Tools

| Tool | Input | Description |
| --- | --- | --- |
| `ping` | — | Registers this pane's identity and returns pane/harness/repo/mode. |
| `list_peers` | `scope?: "repo" \| "window" \| "all"` (default `repo`) | Lists other crossagent-visible tmux panes. |
| `send` | `pane, text` | Sends literal text + Enter to a tmux pane. |
| `read` | `pane, lines?` (default 200) | Captures the last N lines from a tmux pane. |
| `wait_reply` | `pane, timeout_ms?` | Waits until the peer pane's harness looks idle, returns the new content. |
| `brief` | `pane?, force?` | Sends the pairing-protocol role brief to a pane (resetting its conversation first, if a `reset_command` is known) and waits for `VERDICT: AGREE`. Idempotent; `force: true` re-briefs an already-briefed pane. |
| `discuss` | `pane?, message, kind?: "plan" \| "implementation" \| "question", timeout_ms?` | Auto-briefs the pane if it hasn't been briefed, sends a review preamble + message, waits for the reply, and parses its `VERDICT:` line. Tracks a per-pane round counter (reset by `brief`). |
| `ask_review` | `pane?, prompt, timeout_ms?` | Thin alias of `discuss` with `kind: "implementation"`, kept for compatibility. |

All tool errors come back as `isError: true` content — no thrown exceptions
cross the MCP boundary.

## Prompts

| Prompt | Arguments | Description |
| --- | --- | --- |
| `pair` | `pane?` (e.g. `%13`), `kind?: "plan" \| "implementation" \| "question"` | The full pairing protocol (the `pair` skill body) as a single user message. |

## Pairing protocol

`brief` and `discuss` implement a lightweight review protocol on top of the raw
`send`/`read`/`wait_reply` primitives. The peer pane is a **same-level
copilot**, not a senior and not an approver — it may read the repo and run
read-only commands/tests (it shares the driver's cwd) but must never write.
Because the peer harness has no crossagent skill of its own, every rule it
must follow travels inside the messages `brief`/`discuss` send it.

**Roles**: the driver calls the tools and implements; the peer reviews plans
and implementations for gaps, security flaws, convention violations,
business-logic errors, and missing tests, and disagrees when it disagrees.

**Reply shape**: every peer reply is bracketed by a `REVIEW:` line (the actual
answer — analysis, findings, or just "understood" for a brief ack) and ends
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

**Flow**: `brief(pane)` once per pane — resets the peer's conversation (if a
`reset_command` is configured for its harness), sends the role brief, and
marks the pane briefed on `AGREE`. `discuss(pane, message, kind)` sends a
review round; if the pane was never briefed, it briefs it first
automatically. `ask_review` is `discuss` with `kind: "implementation"`.

**Consensus loop and escalation are driven by the caller** (e.g. a skill
wrapping these tools): keep calling `discuss` with follow-ups until the
verdict is `AGREE`, or stop and surface the question to the human requester
on `ESCALATE`. crossagent itself does not loop or escalate on its own.

## Config

Idle detection evaluates `idle_regex` (and, if set, `busy_regex`) against a
**tail window** of the last `tail_lines` non-empty captured lines — not just
the last line, since a harness's prompt may sit above trailing status lines
(Claude Code's `❯` prompt, for example, is followed by a few status lines).
`busy_regex` overrides `idle_regex` whenever it matches anywhere in the tail
window, so a spinner line (e.g. containing "esc to interrupt") keeps the pane
busy even if a stale idle-looking line is still present. Before the
stability/regex comparison, captured content is normalized: animated braille
spinner glyphs (U+2800–U+28FF) are stripped, whitespace runs are collapsed,
line ends are trimmed, and empty lines are dropped — this keeps a
constantly-redrawing spinner from defeating the `quiet_ms` stability check.

Optional `~/.config/crossagent/config.toml`:

```toml
[harness.claude]
idle_regex = "^❯\\s*$"
busy_regex = "esc to interrupt"
reset_command = "/clear"

[harness.codex]
idle_regex = "^›\\s*(Ask Codex to do anything)?\\s*$"
busy_regex = "esc to interrupt"
reset_command = "/new"

[defaults]
timeout_ms = 300000
quiet_ms = 1500
tail_lines = 8
```

`reset_command` is sent (and waited on) by `brief` before the role preamble,
so a prior unrelated conversation on the peer pane doesn't bleed into the
protocol. It defaults to `/clear` for `claude`, `/new` for `codex`, and
none for `unknown` harnesses.

The built-in `idle_regex`/`busy_regex` defaults are a **best-effort guess**
at each harness's idle/busy prompt shape, captured from live panes — they
are still expected to be tuned by hand once you can watch a live session.

## Skill

`skills/pair/SKILL.md` teaches a driver agent how to use the crossagent tools:
brief the peer pane as a same-level copilot, call `discuss` at the right
moments (plan, implementation, architectural fork), handle each verdict, and
escalate to the human on decisions that aren't the agent's to make.

Both Claude Code and Codex CLI read the same `SKILL.md` format (YAML
frontmatter with `name` and `description`), and both follow symlinked skill
directories, so one skill directory serves both hosts.

### Zero-setup: MCP prompt

The same protocol ships as an MCP prompt named `pair`, so `mcp add` alone is
enough — no symlink required. In Claude Code it shows up as the slash command
`/mcp__crossagent__pair`, with optional `pane` (e.g. `%13`) and `kind`
(`plan` | `implementation` | `question`) arguments. Note this is **Claude Code
only and user-invoked**: Codex CLI does not expose MCP prompts yet, and the
prompt's text is not visible to the model until the user runs it.

What actually makes `mcp add` sufficient in both hosts is the server
`instructions` sent on `initialize` plus the tool descriptions — together they
carry when to pair, the `list_peers → brief → discuss` sequence, the
`VERDICT: AGREE|ADJUST|OBJECT|ESCALATE` contract and what each verdict means,
the 3-round cap, and that `ESCALATE` means stop and ask the human.

`setup --link` remains the way to have the skill proactively loaded in both
Claude Code and Codex, rather than only on demand.

Link it into your personal skill dirs:

```
crossagent-mcp setup --link
```

This symlinks `skills/pair` into `~/.claude/skills/pair`,
`~/.codex/skills/pair` (or `$CODEX_HOME/skills/pair` if set), and
`~/.agents/skills/pair`. A target that's missing gets a symlink created; one
already linked to this package is left alone; a real file/directory or a
symlink pointing elsewhere is never touched — it's reported so you can
resolve it by hand. `crossagent-mcp setup --unlink` reverses this, removing
only the symlinks it created.

To link manually instead:

```
ln -s <path-to-this-repo>/skills/pair ~/.claude/skills/pair
ln -s <path-to-this-repo>/skills/pair ~/.codex/skills/pair
ln -s <path-to-this-repo>/skills/pair ~/.agents/skills/pair
```

## Setup

```
node --import tsx src/cli.ts setup
```

prints (does not write) the exact snippets to wire crossagent into each
harness:

**Claude Code** (`.mcp.json`):

```json
{
  "mcpServers": {
    "crossagent": {
      "command": "npx",
      "args": ["-y", "crossagent-mcp"]
    }
  }
}
```

**Codex CLI**:

```
codex mcp add crossagent -- npx -y crossagent-mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.crossagent]
command = "npx"
args = ["-y", "crossagent-mcp"]
```
