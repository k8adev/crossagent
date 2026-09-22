# Skill

How the `pair` skill and the zero-setup MCP prompt get the pairing protocol into a driver agent.

`skills/pair/SKILL.md` teaches a driver agent how to use the crossagent tools:
brief the peer pane as a same-level copilot, call `discuss` at the right
moments (plan, implementation, architectural fork), handle each verdict, and
escalate to the human on decisions that aren't the agent's to make.

Both Claude Code and Codex CLI read the same `SKILL.md` format (YAML
frontmatter with `name` and `description`), and both follow symlinked skill
directories, so one skill directory serves both hosts.

## Zero-setup: MCP prompt

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
