# crossagent

[![npm version](https://img.shields.io/npm/v/crossagent-mcp)](https://www.npmjs.com/package/crossagent-mcp)
[![CI](https://github.com/k8adev/crossagent/actions/workflows/ci.yml/badge.svg)](https://github.com/k8adev/crossagent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

crossagent pairs two coding agents running in adjacent tmux panes: one drives, the other reviews. Every plan and diff goes through the peer before it ships, and the reply always ends in a verdict. tmux is the only transport — no network, no shared file, no socket.

## Install

Requirements: Node.js 22 or newer, tmux, and two panes each running a coding agent (Claude Code, Codex CLI), both inside the same git repository for automatic peer discovery. Each agent must call `ping` once — registration happens on that call, not on server startup.

Run `npx` from outside a clone of this repo — inside it, `npx` resolves the local package instead of the published one.

Step 1. Add the MCP server to each agent.

```
claude mcp add crossagent -- npx -y crossagent-mcp
codex mcp add crossagent -- npx -y crossagent-mcp
```

Step 2. Link the pair skill so both agents load the pairing protocol proactively.

```
npx -y crossagent-mcp setup --link
```

This symlinks `skills/pair` into `~/.claude/skills/pair`, `~/.codex/skills/pair` (or `$CODEX_HOME/skills/pair`) and `~/.agents/skills/pair`. `setup --unlink` reverses it, removing only the symlinks it created.

Without step 2, the protocol is still available as the `pair` MCP prompt (`/mcp__crossagent__pair` in Claude Code). Details in [docs/skill.md](docs/skill.md).

Briefing sends the harness's reset command to the peer pane (`/clear` for Claude Code, `/new` for Codex), clearing its current conversation — this also happens automatically the first time `discuss` briefs an unbriefed peer, not only on an explicit `brief` call.

## How it works

- **ping** — each agent registers its pane, harness and repository so the peer can be found.
- **brief** — sets the peer's role: a same-level copilot or reviewer bound to the `VERDICT:` contract. It does not send the task. `discuss` calls it automatically on the first round; call it by hand only with `force: true` to reset a stale peer.
- **discuss** — every round's task and context go here. It briefs the peer automatically if needed, and every plan or diff sent this way ends in one verdict line.

The last line of every review is `VERDICT: <word>`:

| Verdict | Meaning | Driver does |
| --- | --- | --- |
| `AGREE` | No corrections. | Ships it as is. |
| `ADJUST` | Fine once the listed items are fixed. | Fixes them, or argues back when one is wrong. |
| `OBJECT` | Do not proceed as written, reasons included. | Reworks the plan and asks again. |
| `ESCALATE` | Only the human can call this one. | Stops and brings it to the user. |
| `UNPARSED` | Not a verdict — reply had no readable `VERDICT:` line. | Asks again. |

The full round format, review extraction and verdict parsing are in [docs/protocol.md](docs/protocol.md).

## Tools

| Tool | Description |
| --- | --- |
| `ping` | Registers this pane's identity and returns pane/harness/repo/mode. |
| `list_peers` | Lists other crossagent-visible tmux panes. |
| `send` | Sends literal text + Enter to a tmux pane. |
| `read` | Captures the last N lines from a tmux pane. |
| `wait_reply` | Waits until the peer pane's harness looks idle, returns the new content. |
| `brief` | Sends the pairing-protocol role brief to a pane and waits for `VERDICT: AGREE`. |
| `discuss` | Auto-briefs the pane if needed, sends a review round, parses the `VERDICT:` line. |
| `ask_review` | Alias of `discuss` with `kind: "implementation"`. |
| `pair` (prompt) | The full pairing protocol as a single user message. |

Arguments and defaults: [docs/tools.md](docs/tools.md).

## Configuration

Optional config lives at `~/.config/crossagent/config.toml`. Each harness's idle/busy detection regexes and its reset command (sent before the role brief, e.g. `/clear` for Claude Code, `/new` for Codex) are overridable per harness, with tunable defaults for timeout, quiet period, and tail-window size. See [docs/configuration.md](docs/configuration.md) for the full reference and examples.

## How it finds the other pane

Each pane resolves its own tmux pane id, harness, and repo identity when `ping` is called, then self-declares them as tmux pane options so `list_peers` can find it. Codex CLI starts MCP servers lazily, so a Codex pane may not be discoverable by its declared identity until its first tool call. See [docs/discovery.md](docs/discovery.md) for the full resolution logic and fallbacks.

## Contributing

Bug reports, harness support, and protocol improvements are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, tests, and how to add a new harness. This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

Using another coding agent? Adding a harness means a detection entry in `src/harness.ts` and a config block; see CONTRIBUTING.md.

## License

MIT
