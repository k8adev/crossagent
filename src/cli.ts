#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { applyLink, applyUnlink, describeOutcome, planLinks } from "./link.js";

const SETUP_SNIPPET = `crossagent-mcp setup

## Claude Code (.mcp.json)

{
  "mcpServers": {
    "crossagent": {
      "command": "npx",
      "args": ["-y", "crossagent-mcp"]
    }
  }
}

## Codex CLI

codex mcp add crossagent -- npx -y crossagent-mcp

Or, in ~/.codex/config.toml:

[mcp_servers.crossagent]
command = "npx"
args = ["-y", "crossagent-mcp"]

## Skill

The \`pair\` skill (skills/pair/SKILL.md) teaches the driver agent how to use these
tools to pair-program with a peer pane.

It is also exposed as an MCP prompt named \`pair\`, so \`mcp add\` alone is enough —
in Claude Code, run it as /mcp__crossagent__pair. That prompt is Claude Code only
and user-invoked; the server \`instructions\` and tool descriptions are what carry
the protocol to the model in both hosts.

Link the skill into your personal skill dirs to have it proactively loaded instead:

  crossagent-mcp setup --link

Or manually:

  ln -s <package-root>/skills/pair ~/.claude/skills/pair
  ln -s <package-root>/skills/pair ~/.codex/skills/pair
  ln -s <package-root>/skills/pair ~/.agents/skills/pair

Both hosts follow symlinked skill directories, and the SKILL.md frontmatter
(name + description) is shared across them.
`;

/** Package root is one level above this module's directory (dist/cli.js or src/cli.ts via tsx), both from a local checkout and an npm install. */
function findPackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..");
}

function runLink(unlink: boolean): void {
  const packageRoot = findPackageRoot();
  const sourceDir = join(packageRoot, "skills", "pair");
  const codexHome = process.env.CODEX_HOME;
  const targets = planLinks(homedir(), codexHome);

  for (const target of targets) {
    const outcome = unlink ? applyUnlink(target, sourceDir) : applyLink(target, sourceDir);
    console.log(describeOutcome(outcome));
  }
}

async function main(): Promise<void> {
  const [, , command, flag] = process.argv;

  if (command === "setup" && flag === "--link") {
    runLink(false);
    return;
  }

  if (command === "setup" && flag === "--unlink") {
    runLink(true);
    return;
  }

  if (command === "setup") {
    /* Print-only for v1 — the user copies these into their harness config by hand. */
    console.log(SETUP_SNIPPET);
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("crossagent-mcp: listening on stdio");
}

main().catch((error) => {
  console.error("crossagent-mcp: fatal error", error);
  process.exit(1);
});
