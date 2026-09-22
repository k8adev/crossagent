# Discovery and self-declaration

How each crossagent pane figures out its own identity and finds its peer.

Each pane running crossagent computes its own identity when `ping` is called:

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

## Lazy-start caveat (Codex)

Codex CLI starts MCP servers **lazily**, only on first tool call. That means
a Codex pane's `@crossagent_harness` option may not exist yet even though
crossagent is configured for it — registration only happens once some tool
(most simply `ping`) actually runs. Until then, that pane is discoverable
only via the repo-path heuristic above, not by its declared identity.
