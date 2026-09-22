# Manual setup

`npx -y crossagent-mcp setup` (no `--link`) prints, without writing, the exact
snippets to wire crossagent into each harness. The equivalents are below if
you'd rather copy them directly.

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
