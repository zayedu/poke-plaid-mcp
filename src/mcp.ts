import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "./config.js";
import { log } from "./logger.js";
import { getProvider } from "./providers/index.js";
import { PlaidRequestError } from "./providers/plaid.js";
import { summarizeDividends, summarizePortfolio } from "./portfolio-math.js";

type TextResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function jsonResult(data: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string, extra?: Record<string, unknown>): TextResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }, null, 2) }],
    isError: true,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function safe(fn: () => Promise<TextResult>): Promise<TextResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PlaidRequestError) {
      const guidance =
        err.code === "ITEM_LOGIN_REQUIRED"
          ? "The institution needs to be re-linked. Re-run the setup flow."
          : err.code === "PRODUCT_NOT_READY"
            ? "Investment data is still being prepared by Plaid. Try again shortly."
            : undefined;
      return errorResult(`Plaid error: ${err.message}`, { code: err.code, guidance });
    }
    log.error("Tool execution failed", { error: (err as Error).message });
    return errorResult((err as Error).message ?? "Unknown error");
  }
}

const accountIdsSchema = z
  .array(z.string())
  .optional()
  .describe("Optional list of account IDs to restrict results to. Omit to include all linked accounts.");

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "poke-plaid-portfolio", version: "1.0.0" },
    {
      instructions:
        "Read-only access to the user's investment portfolio via Plaid (holdings, balances, " +
        "dividends, and investment transactions across all linked brokerage/retirement accounts). " +
        "Use portfolio_summary for a quick net-worth style snapshot, list_holdings for position-level " +
        "detail, and get_dividend_income to see dividends received over a period. All monetary values " +
        "are in each account's native currency. Call check_connection first if a tool reports no data.",
    },
  );

  const provider = getProvider();

  server.registerTool(
    "check_connection",
    {
      title: "Check portfolio connection",
      description:
        "Verify the portfolio data source is connected and report which institutions/accounts are linked. " +
        "Call this first if other tools return no data.",
      inputSchema: {},
      annotations: { title: "Check portfolio connection", readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      safe(async () => {
        const ready = await provider.isReady();
        const items = await provider.listLinkedItems();
        return jsonResult({
          summary: ready
            ? `Connected via ${provider.kind}. ${items.length} institution(s) linked.`
            : provider.kind === "mock"
              ? "Running in MOCK mode (no Plaid credentials configured)."
              : "No institutions linked yet. Open the setup page to connect an account.",
          provider: provider.kind,
          ready,
          mockMode: provider.kind === "mock",
          linkedInstitutions: items,
          setupUrl: provider.kind === "plaid" ? `${config.publicBaseUrl}/setup` : undefined,
        });
      }),
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List investment accounts",
      description:
        "List all linked investment/brokerage/retirement accounts with their institution, type, and last-known balance.",
      inputSchema: {},
      annotations: { title: "List investment accounts", readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      safe(async () => {
        const accounts = await provider.listAccounts();
        return jsonResult({
          summary: `${accounts.length} account(s) linked across ${
            new Set(accounts.map((a) => a.institution)).size
          } institution(s).`,
          accounts,
        });
      }),
  );

  server.registerTool(
    "get_balances",
    {
      title: "Get real-time balances",
      description:
        "Fetch up-to-date balances for linked accounts. Forces a fresh balance read from the institution when supported.",
      inputSchema: { account_ids: accountIdsSchema },
      annotations: { title: "Get real-time balances", readOnlyHint: true, openWorldHint: true },
    },
    async ({ account_ids }) =>
      safe(async () => {
        const accounts = await provider.getBalances({ accountIds: account_ids });
        const total = accounts.reduce((sum, a) => sum + (a.currentBalance ?? 0), 0);
        return jsonResult({
          summary: `${accounts.length} account(s); combined current balance ≈ ${total.toFixed(2)} (mixed currencies not converted).`,
          accounts,
        });
      }),
  );

  server.registerTool(
    "portfolio_summary",
    {
      title: "Portfolio summary",
      description:
        "A high-level snapshot of the whole portfolio: total market value and unrealized gain/loss by currency, " +
        "per-account breakdown, asset allocation by security type, and the largest holdings. Best starting point " +
        "for 'how is my portfolio doing / how much do I have' questions.",
      inputSchema: { account_ids: accountIdsSchema },
      annotations: { title: "Portfolio summary", readOnlyHint: true, openWorldHint: true },
    },
    async ({ account_ids }) =>
      safe(async () => {
        const { holdings, accounts } = await provider.getHoldings({ accountIds: account_ids });
        return jsonResult(summarizePortfolio(holdings, accounts));
      }),
  );

  server.registerTool(
    "list_holdings",
    {
      title: "List holdings",
      description:
        "Position-level detail for every holding: ticker, name, type, quantity, price, market value, cost basis, " +
        "and unrealized gain/loss. Optionally filter by account or a minimum market value, and sort.",
      inputSchema: {
        account_ids: accountIdsSchema,
        min_value: z.number().optional().describe("Only include holdings with market value >= this amount."),
        sort_by: z
          .enum(["value", "gain", "gain_pct"])
          .optional()
          .describe("Sort order (default: value). 'gain' = unrealized $ gain, 'gain_pct' = unrealized % gain."),
      },
      annotations: { title: "List holdings", readOnlyHint: true, openWorldHint: true },
    },
    async ({ account_ids, min_value, sort_by }) =>
      safe(async () => {
        const { holdings } = await provider.getHoldings({ accountIds: account_ids });
        let rows = holdings;
        if (min_value !== undefined) rows = rows.filter((h) => h.value >= min_value);
        const key = sort_by ?? "value";
        rows = [...rows].sort((a, b) => {
          if (key === "gain") return (b.unrealizedGain ?? -Infinity) - (a.unrealizedGain ?? -Infinity);
          if (key === "gain_pct") return (b.unrealizedGainPct ?? -Infinity) - (a.unrealizedGainPct ?? -Infinity);
          return b.value - a.value;
        });
        return jsonResult({
          summary: `${rows.length} holding(s)${min_value !== undefined ? ` with value >= ${min_value}` : ""}, sorted by ${key}.`,
          holdings: rows,
        });
      }),
  );

  server.registerTool(
    "list_investment_transactions",
    {
      title: "List investment transactions",
      description:
        "Investment transactions (buys, sells, dividends, contributions, fees, transfers) within a date range. " +
        "Defaults to the last 30 days. Optionally filter by account or transaction type/subtype.",
      inputSchema: {
        start_date: z
          .string()
          .regex(DATE_RE, "Use YYYY-MM-DD")
          .optional()
          .describe("Start date (YYYY-MM-DD). Default: 30 days ago."),
        end_date: z.string().regex(DATE_RE, "Use YYYY-MM-DD").optional().describe("End date (YYYY-MM-DD). Default: today."),
        account_ids: accountIdsSchema,
        types: z
          .array(z.string())
          .optional()
          .describe("Filter by transaction type or subtype, e.g. ['buy','sell','dividend','fee']."),
      },
      annotations: { title: "List investment transactions", readOnlyHint: true, openWorldHint: true },
    },
    async ({ start_date, end_date, account_ids, types }) =>
      safe(async () => {
        const startDate = start_date ?? daysAgo(30);
        const endDate = end_date ?? today();
        const { transactions } = await provider.getInvestmentTransactions({
          startDate,
          endDate,
          accountIds: account_ids,
        });
        let rows = transactions;
        if (types && types.length > 0) {
          const wanted = new Set(types.map((t) => t.toLowerCase()));
          rows = rows.filter((t) => wanted.has(t.type.toLowerCase()) || wanted.has(t.subtype.toLowerCase()));
        }
        return jsonResult({
          summary: `${rows.length} transaction(s) between ${startDate} and ${endDate}.`,
          startDate,
          endDate,
          transactions: rows,
        });
      }),
  );

  server.registerTool(
    "get_dividend_income",
    {
      title: "Get dividend income",
      description:
        "Total dividends received over a period, broken down by security and by currency, plus each individual " +
        "payment. Defaults to the last 90 days. Great for 'how much dividend income did I get' questions.",
      inputSchema: {
        start_date: z
          .string()
          .regex(DATE_RE, "Use YYYY-MM-DD")
          .optional()
          .describe("Start date (YYYY-MM-DD). Default: 90 days ago."),
        end_date: z.string().regex(DATE_RE, "Use YYYY-MM-DD").optional().describe("End date (YYYY-MM-DD). Default: today."),
        account_ids: accountIdsSchema,
      },
      annotations: { title: "Get dividend income", readOnlyHint: true, openWorldHint: true },
    },
    async ({ start_date, end_date, account_ids }) =>
      safe(async () => {
        const startDate = start_date ?? daysAgo(90);
        const endDate = end_date ?? today();
        const { transactions } = await provider.getInvestmentTransactions({
          startDate,
          endDate,
          accountIds: account_ids,
        });
        return jsonResult(summarizeDividends(transactions, startDate, endDate));
      }),
  );

  return server;
}
