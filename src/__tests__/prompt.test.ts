import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { GetPromptResultSchema, type GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer, SERVER_INSTRUCTIONS } from "../server.js";

/** Narrows the prompt's single message to its text, failing loudly on any other content type. */
function soleText(result: GetPromptResult): string {
  expect(result.messages).toHaveLength(1);
  const message = result.messages[0]!;
  expect(message.role).toBe("user");
  if (message.content.type !== "text") {
    throw new Error(`expected a text content block, got ${message.content.type}`);
  }
  return message.content.text;
}

/* Drives the real server over the SDK's in-memory transport, so this covers the wire shape
 * (capability declaration, prompts/list, prompts/get) rather than the registration call alone. */
async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([createServer().connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("pair prompt over MCP", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connectedClient();
  });

  it("declares the prompts capability and lists `pair` with its optional arguments", async () => {
    expect(client.getServerCapabilities()?.prompts).toBeDefined();

    const { prompts } = await client.listPrompts();
    const pair = prompts.find((prompt) => prompt.name === "pair");

    expect(pair).toBeDefined();
    expect(pair!.title).toBe("Pair with the agent in the next tmux pane");
    expect(pair!.arguments?.map((argument) => argument.name).sort()).toEqual(["kind", "pane"]);
    expect(pair!.arguments?.every((argument) => argument.required !== true)).toBe(true);
  });

  it("returns the skill body as one user message, without frontmatter", async () => {
    const text = soleText(await client.getPrompt({ name: "pair" }));

    expect(text).toContain("VERDICT");
    expect(text).not.toContain("description:");
    expect(text.startsWith("# pair")).toBe(true);
  });

  it("prepends a preamble naming the given pane and kind", async () => {
    const text = soleText(await client.getPrompt({ name: "pair", arguments: { pane: "%13", kind: "plan" } }));

    expect(text).toContain("%13");
    expect(text).toContain("plan");
    expect(text).toContain("VERDICT");
  });

  /* Claude Code omits `arguments` entirely for a no-input slash command, which the spec allows
   * when every declared argument is optional (anthropics/claude-code#5597). */
  it("accepts a prompts/get that omits the arguments object entirely", async () => {
    const result = await client.request(
      { method: "prompts/get", params: { name: "pair" } },
      GetPromptResultSchema,
    );

    expect(soleText(result)).toContain("VERDICT");
  });

  it("sends instructions that fit the host budget and carry the verdict contract", async () => {
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    /* Claude Code silently truncates server instructions at 2048 characters. */
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
    expect(SERVER_INSTRUCTIONS).toContain("VERDICT");
    expect(SERVER_INSTRUCTIONS).toContain("ESCALATE");
  });
});
