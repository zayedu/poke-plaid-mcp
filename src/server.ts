import express, { type Express, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { buildMcpServer } from "./mcp.js";
import { linkRouter } from "./routes/link.js";
import { mcpAuth, networkGuard, setupGuard } from "./security.js";

const MCP_PATH = "/mcp";

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST for MCP requests." },
    id: null,
  });
}

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "4mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", provider: config.providerKind, env: config.plaid.env });
  });

  app.get("/", (_req: Request, res: Response) => {
    res.json({
      name: "poke-plaid-portfolio",
      description: "MCP server exposing your Plaid-linked investment portfolio to Poke.",
      provider: config.providerKind,
      mcpEndpoint: `${config.publicBaseUrl}${MCP_PATH}`,
      setup: `${config.publicBaseUrl}/setup`,
    });
  });

  // Stateless Streamable HTTP MCP endpoint: a fresh server + transport per request.
  app.post(MCP_PATH, networkGuard, mcpAuth, async (req: Request, res: Response) => {
    const server = buildMcpServer();
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error("MCP request handling failed", { error: (err as Error).message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });
  app.get(MCP_PATH, methodNotAllowed);
  app.delete(MCP_PATH, methodNotAllowed);

  // Plaid Link setup UI + endpoints, protected by network + setup guards.
  app.use("/setup", networkGuard, setupGuard);
  app.use(linkRouter());

  return app;
}
