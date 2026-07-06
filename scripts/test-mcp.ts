/**
 * End-to-end smoke test: boots the real HTTP server, connects a real MCP client
 * over Streamable HTTP, lists tools, and calls each read tool. Works out of the
 * box in mock mode (no Plaid keys needed).
 *
 *   npm run test:mcp
 */
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "../src/config.js";
import { createApp } from "../src/server.js";

function short(text: string, max = 900): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]` : text;
}

async function main(): Promise<void> {
  const app = createApp();
  const httpServer = app.listen(0);
  await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
  const { port } = httpServer.address() as AddressInfo;
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  console.log(`Server up on ${url.href} (provider: ${config.providerKind})\n`);

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: config.mcpApiKey ? { headers: { Authorization: `Bearer ${config.mcpApiKey}` } } : undefined,
  });
  const client = new Client({ name: "poke-plaid-mcp-tester", version: "1.0.0" });

  let failures = 0;
  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    console.log(`✓ tools/list → ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}\n`);

    const calls: { name: string; args: Record<string, unknown> }[] = [
      { name: "check_connection", args: {} },
      { name: "list_accounts", args: {} },
      { name: "portfolio_summary", args: {} },
      { name: "list_holdings", args: { sort_by: "gain_pct" } },
      { name: "get_balances", args: {} },
      { name: "list_investment_transactions", args: {} },
      { name: "get_dividend_income", args: {} },
    ];

    for (const call of calls) {
      try {
        const res = await client.callTool({ name: call.name, arguments: call.args });
        const text = (res.content as { type: string; text?: string }[])
          .map((c) => c.text ?? "")
          .join("\n");
        const flag = res.isError ? "✗ (isError)" : "✓";
        if (res.isError) failures++;
        console.log(`${flag} ${call.name}(${JSON.stringify(call.args)})`);
        console.log(short(text));
        console.log("");
      } catch (err) {
        failures++;
        console.log(`✗ ${call.name} threw: ${(err as Error).message}\n`);
      }
    }
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  if (failures > 0) {
    console.error(`\n${failures} tool call(s) failed.`);
    process.exit(1);
  }
  console.log("All tool calls succeeded.");
  process.exit(0);
}

void main();
