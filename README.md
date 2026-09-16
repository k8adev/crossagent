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
| `ask_review` | `pane?, prompt, timeout_ms?` | Sends a review preamble + prompt to a pane (or the sole repo-scoped peer if `pane` is omitted), then waits for the reply. |

All tool errors come back as `isError: true` content — no thrown exceptions
cross the MCP boundary.

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

[harness.codex]
idle_regex = "^›\\s*(Ask Codex to do anything)?\\s*$"
busy_regex = "esc to interrupt"

[defaults]
timeout_ms = 300000
quiet_ms = 1500
tail_lines = 8
```

The built-in `idle_regex`/`busy_regex` defaults are a **best-effort guess**
at each harness's idle/busy prompt shape, captured from live panes — they
are still expected to be tuned by hand once you can watch a live session.

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
