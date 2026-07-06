import "dotenv/config";

export type PlaidEnvName = "sandbox" | "production";
export type ProviderKind = "plaid" | "mock";

// A linked Plaid Item supplied via the PLAID_ITEMS env var. This lets tokens
// survive an ephemeral filesystem (e.g. Render's free tier), where anything
// written to ./data is wiped on every restart/deploy/spin-down.
export interface SeedItem {
  itemId: string;
  institution: string;
  institutionId?: string;
  accessToken: string;
  linkedAt?: string;
}

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === null ? fallback : v.trim();
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(name: string, fallback: string[] = []): string[] {
  const v = str(name);
  if (!v) return fallback;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(name: string, fallback = false): boolean {
  const v = str(name).toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes";
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

// Parse PLAID_ITEMS: a JSON array of linked items (with plaintext access tokens,
// stored safely in the platform's secret env store). Invalid entries are skipped.
function parseSeedItems(raw: string): SeedItem[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[config] PLAID_ITEMS is not valid JSON — ignoring it.");
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error("[config] PLAID_ITEMS must be a JSON array — ignoring it.");
    return [];
  }
  const items: SeedItem[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const itemId = typeof e.itemId === "string" ? e.itemId : undefined;
    const accessToken = typeof e.accessToken === "string" ? e.accessToken : undefined;
    if (!itemId || !accessToken) continue;
    items.push({
      itemId,
      accessToken,
      institution: typeof e.institution === "string" ? e.institution : "Linked institution",
      institutionId: typeof e.institutionId === "string" ? e.institutionId : undefined,
      linkedAt: typeof e.linkedAt === "string" ? e.linkedAt : undefined,
    });
  }
  return items;
}

const plaidClientId = str("PLAID_CLIENT_ID");
const plaidSecret = str("PLAID_SECRET");

// If Plaid credentials are absent we fall back to a realistic mock provider so
// the whole MCP <-> Poke pipeline can be exercised before you have Plaid keys.
const hasPlaidCreds = Boolean(plaidClientId && plaidSecret);

const rawEnv = str("PLAID_ENV", "sandbox").toLowerCase();
const plaidEnv: PlaidEnvName = rawEnv === "production" ? "production" : "sandbox";

const nodeEnv = str("NODE_ENV", "development");
const port = int("PORT", 3000);
// Default to loopback so a local install is never exposed to the LAN. Hosted
// deployments (Docker/Render/etc.) must set HOST=0.0.0.0 explicitly.
const host = str("HOST", "127.0.0.1");
// Prefer an explicit PUBLIC_BASE_URL, then Render's injected RENDER_EXTERNAL_URL,
// then localhost. This keeps the Host/Origin allowlist correct on hosted platforms
// without any manual configuration.
const publicBaseUrl = (str("PUBLIC_BASE_URL") || str("RENDER_EXTERNAL_URL") || `http://localhost:${port}`).replace(
  /\/+$/,
  "",
);

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"];
const allowedHosts = [
  ...new Set(
    [
      ...LOOPBACK_HOSTS,
      hostnameOf(publicBaseUrl),
      str("RENDER_EXTERNAL_HOSTNAME") || undefined,
      ...list("ALLOWED_HOSTS"),
    ].filter(Boolean) as string[],
  ),
];
const allowedOrigins = [
  ...new Set(
    [
      publicBaseUrl,
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      ...list("ALLOWED_ORIGINS"),
    ].map((o) => o.replace(/\/+$/, "").toLowerCase()),
  ),
];

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  isProduction: boolean;
  publicBaseUrl: string;
  mcpApiKey: string;
  setupToken: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  allowAnyHost: boolean;
  providerKind: ProviderKind;
  plaid: {
    clientId: string;
    secret: string;
    env: PlaidEnvName;
    products: string[];
    countryCodes: string[];
    appName: string;
    redirectUri: string;
  };
  storage: {
    tokenStorePath: string;
    encryptionKey: string;
    seedItems: SeedItem[];
  };
}

export const config: AppConfig = {
  port,
  host,
  nodeEnv,
  isProduction: nodeEnv === "production",
  publicBaseUrl,
  mcpApiKey: str("MCP_API_KEY"),
  setupToken: str("SETUP_TOKEN"),
  allowedHosts,
  allowedOrigins,
  allowAnyHost: bool("ALLOW_ANY_HOST", false),
  providerKind: hasPlaidCreds ? "plaid" : "mock",
  plaid: {
    clientId: plaidClientId,
    secret: plaidSecret,
    env: plaidEnv,
    products: list("PLAID_PRODUCTS", ["investments"]),
    countryCodes: list("PLAID_COUNTRY_CODES", ["US", "CA"]),
    appName: str("PLAID_APP_NAME", "Poke Portfolio"),
    // Required for OAuth institutions (Wealthsimple). Register this exact URL in
    // Plaid Dashboard → Team Settings → API → Allowed redirect URIs.
    redirectUri: str("PLAID_REDIRECT_URI", `${publicBaseUrl}/setup`),
  },
  storage: {
    tokenStorePath: str("TOKEN_STORE_PATH", "./data/items.json"),
    encryptionKey: str("TOKEN_ENCRYPTION_KEY"),
    seedItems: parseSeedItems(str("PLAID_ITEMS")),
  },
};

export const isMockMode = config.providerKind === "mock";
