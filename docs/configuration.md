# Configuration

Tuning idle/busy detection, reset commands, and defaults per harness.

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
