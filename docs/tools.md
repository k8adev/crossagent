# Tools

Full reference for every crossagent MCP tool: arguments, defaults, and description.

| Tool | Input | Description |
| --- | --- | --- |
| `ping` | — | Registers this pane's identity and returns pane/harness/repo/mode. |
| `list_peers` | `scope?: "repo" \| "window" \| "all"` (default `repo`) | Lists other crossagent-visible tmux panes. |
| `send` | `pane, text` | Sends literal text + Enter to a tmux pane. |
| `read` | `pane, lines?` (default 200) | Captures the last N lines from a tmux pane. |
| `wait_reply` | `pane, timeout_ms?` | Waits until the peer pane's harness looks idle, returns the new content. |
| `brief` | `pane?, force?` | Reset-only: sends the harness's `reset_command` (if known) to clear the pane's conversation, waits for it to settle and restarts the round counter. Sends no role text; `discuss` needs no setup. `force` is accepted for compatibility and ignored. |
| `discuss` | `pane?, message, kind?: "plan" \| "implementation" \| "question", timeout_ms?` | Sends a short role brief + kind line + message in one go, waits for the reply, and parses its `VERDICT:` line. Tracks a per-pane round counter (reset by `brief`). |
| `ask_review` | `pane?, prompt, timeout_ms?` | Thin alias of `discuss` with `kind: "implementation"`, kept for compatibility. |

## Prompts

| Prompt | Arguments | Description |
| --- | --- | --- |
| `pair` | `pane?` (e.g. `%13`), `kind?: "plan" \| "implementation" \| "question"` | The full pairing protocol (the `pair` skill body) as a single user message. |

## Errors

All tool errors come back as `isError: true` content — no thrown exceptions
cross the MCP boundary.
