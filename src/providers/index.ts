import { config } from "../config.js";
import { log } from "../logger.js";
import { MockProvider } from "./mock.js";
import { PlaidProvider } from "./plaid.js";
import type { PortfolioProvider } from "./types.js";

let provider: PortfolioProvider | null = null;

export function getProvider(): PortfolioProvider {
  if (provider) return provider;
  if (config.providerKind === "plaid") {
    log.info("Using Plaid provider", { env: config.plaid.env });
    provider = new PlaidProvider();
  } else {
    log.warn("PLAID_CLIENT_ID/PLAID_SECRET not set — using MOCK provider with sample data.");
    provider = new MockProvider();
  }
  return provider;
}

export type { PortfolioProvider } from "./types.js";
