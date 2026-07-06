import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { log } from "./logger.js";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Parse the hostname (no port) from a Host header, handling IPv6 brackets. */
export function parseHostname(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1); // [::1]
  return h.split(":")[0];
}

function isLoopbackRemote(req: Request): boolean {
  const remote = req.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function jsonError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null });
}

/**
 * DNS-rebinding / cross-origin protection. Blocks:
 *  - requests whose Host header is not in the allowlist (unless ALLOW_ANY_HOST), and
 *  - browser requests whose Origin is not in the allowlist.
 * Server-to-server clients (Poke, the tunnel, curl) send no Origin and are unaffected.
 */
export function networkGuard(req: Request, res: Response, next: NextFunction): void {
  if (!config.allowAnyHost) {
    const hostname = parseHostname(req.headers.host);
    const allowed = new Set(config.allowedHosts.map((h) => h.toLowerCase()));
    if (hostname && !allowed.has(hostname)) {
      log.warn("Blocked request: host not allowed", { host: hostname, path: req.path });
      jsonError(res, 403, `Host '${hostname}' is not allowed. Set PUBLIC_BASE_URL / ALLOWED_HOSTS or ALLOW_ANY_HOST.`);
      return;
    }
  }

  const origin = req.headers.origin;
  if (origin) {
    const normalized = origin.replace(/\/+$/, "").toLowerCase();
    if (!config.allowedOrigins.includes(normalized)) {
      log.warn("Blocked request: origin not allowed", { origin: normalized, path: req.path });
      jsonError(res, 403, `Origin '${origin}' is not allowed.`);
      return;
    }
  }

  next();
}

/** Bearer/x-api-key auth for the MCP endpoint (no-op when MCP_API_KEY is unset). */
export function mcpAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.mcpApiKey) return next();
  const auth = req.header("authorization") ?? "";
  const provided = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : (req.header("x-api-key") ?? "").trim();
  if (provided && safeEqual(provided, config.mcpApiKey)) return next();
  jsonError(res, 401, "Unauthorized: missing or invalid API key.");
}

/**
 * Protects the Plaid Link setup routes.
 *  - If SETUP_TOKEN is configured, it is required (header `x-setup-token` or `?token=`).
 *  - Otherwise, allowed only for local (loopback) connections in non-production.
 */
export function setupGuard(req: Request, res: Response, next: NextFunction): void {
  if (config.setupToken) {
    const provided = (req.header("x-setup-token") ?? (req.query.token as string) ?? "").trim();
    if (provided && safeEqual(provided, config.setupToken)) return next();
    jsonError(res, 401, "Setup is protected. Provide the correct setup token (x-setup-token header or ?token=).");
    return;
  }
  if (config.isProduction) {
    jsonError(res, 403, "Setup is disabled on a public server without SETUP_TOKEN. Set SETUP_TOKEN to enable it.");
    return;
  }
  if (isLoopbackRemote(req)) return next();
  jsonError(res, 403, "Setup is only available locally. Set SETUP_TOKEN to allow remote setup.");
}

/** Fatal-in-production security checks. Returns a list of violations. */
export function productionSecurityErrors(): string[] {
  const errors: string[] = [];
  if (!config.isProduction) return errors;

  const hostIsLoopback = LOOPBACK_HOSTNAMES.has(config.host.toLowerCase());
  if (!hostIsLoopback && !config.mcpApiKey) {
    errors.push("MCP_API_KEY must be set when binding to a non-loopback interface (HOST) in production.");
  }
  if (config.providerKind === "plaid" && !config.storage.encryptionKey) {
    errors.push("TOKEN_ENCRYPTION_KEY must be set in production when using Plaid (encrypts access tokens at rest).");
  }
  return errors;
}

/** Non-fatal startup advisories. */
export function securityWarnings(): string[] {
  const warnings: string[] = [];
  const hostIsLoopback = LOOPBACK_HOSTNAMES.has(config.host.toLowerCase());
  if (!hostIsLoopback && !config.mcpApiKey) {
    warnings.push("Server is bound to a non-loopback interface without MCP_API_KEY — the /mcp endpoint is open.");
  }
  if (config.providerKind === "plaid" && !config.storage.encryptionKey) {
    warnings.push("TOKEN_ENCRYPTION_KEY is unset — Plaid access tokens are only obfuscated, not strongly encrypted.");
  }
  return warnings;
}
