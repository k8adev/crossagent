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
composer_regex = "^❯\\s+(?!Try \")\\S"
reset_command = "/clear"

[harness.codex]
idle_regex = "^›\\s*(Ask Codex to do anything)?\\s*$"
busy_regex = "esc to interrupt"
composer_regex = "^›\\s+(?!Ask Codex to do anything)\\S"
reset_command = "/new"

[defaults]
timeout_ms = 300000
quiet_ms = 1500
tail_lines = 8
```

`reset_command` is what `brief` sends (and waits on) to clear a stale peer
conversation. It defaults to `/clear` for `claude`, `/new` for `codex`, and
none for `unknown` harnesses.

`composer_regex` matches the prompt line of an input box that holds text
(not the empty placeholder). After sending, crossagent checks that the last
prompt line in the tail does not match it; if it does, the prompt was not
submitted, so Enter is retried once and then an error is raised. Without it
(`unknown` harnesses) submit verification is skipped.

`placeholder_regex` matches the empty-composer placeholder (`› Ask Codex to do
anything`, `❯ Try "..."`), which counts as an empty input box.
`reset_menu_regex` matches a menu the reset command may open (Codex's `/new`
asks "Where should the new conversation run?"). `reset_menu_choice_regex`
matches the option `brief` picks (`Use current Git worktree`): Enter when it is
already selected, otherwise its number; no matching option raises an error.

The built-in `idle_regex`/`busy_regex` defaults are a **best-effort guess**
at each harness's idle/busy prompt shape, captured from live panes — they
are still expected to be tuned by hand once you can watch a live session.
