import { config } from "./config.js";
import { log } from "./logger.js";
import { createApp } from "./server.js";
import { productionSecurityErrors, securityWarnings } from "./security.js";

function main(): void {
  const fatal = productionSecurityErrors();
  if (fatal.length > 0) {
    for (const e of fatal) log.error(`Security check failed: ${e}`);
    log.error("Refusing to start. Fix the above (or unset NODE_ENV=production for local use).");
    process.exit(1);
  }
  for (const w of securityWarnings()) log.warn(w);

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    log.info("poke-plaid-mcp started", {
      host: config.host,
      port: config.port,
      provider: config.providerKind,
      env: config.plaid.env,
      mcpEndpoint: `${config.publicBaseUrl}/mcp`,
      setup: `${config.publicBaseUrl}/setup`,
      authRequired: Boolean(config.mcpApiKey),
      setupProtected: Boolean(config.setupToken) || config.isProduction,
    });
    if (config.providerKind === "mock") {
      log.warn("MOCK MODE: serving sample portfolio data. Add PLAID_CLIENT_ID/PLAID_SECRET to use real data.");
    }
  });

  const shutdown = (signal: string) => {
    log.info("Shutting down", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
