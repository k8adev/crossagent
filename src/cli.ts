#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

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
`;

async function main(): Promise<void> {
  const [, , command] = process.argv;

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
