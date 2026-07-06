import type { Account, Holding, InvestmentTransaction } from "./providers/types.js";

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export interface CurrencyTotals {
  currency: string;
  marketValue: number;
  costBasis: number;
  unrealizedGain: number;
  unrealizedGainPct: number | null;
  cashValue: number;
}

export interface AccountSummary {
  accountId: string;
  institution: string;
  name: string;
  subtype?: string;
  currency: string;
  marketValue: number;
  costBasis: number;
  unrealizedGain: number;
  unrealizedGainPct: number | null;
  holdingsCount: number;
}

export interface AllocationSlice {
  type: string;
  currency: string;
  value: number;
  pct: number;
}

export interface TopHolding {
  ticker?: string;
  name?: string;
  accountName: string;
  currency: string;
  value: number;
  unrealizedGain?: number;
  unrealizedGainPct?: number;
}

export interface PortfolioSummary {
  summary: string;
  totalsByCurrency: CurrencyTotals[];
  accounts: AccountSummary[];
  allocationByType: AllocationSlice[];
  topHoldings: TopHolding[];
  holdingsCount: number;
  accountsCount: number;
  institutions: string[];
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function summarizePortfolio(holdings: Holding[], accounts: Account[], topN = 10): PortfolioSummary {
  const byCurrency = new Map<string, { value: number; cost: number; cash: number }>();
  const byType = new Map<string, number>(); // key: `${currency}:${type}`
  const byAccount = new Map<string, { value: number; cost: number; count: number }>();

  for (const h of holdings) {
    const currency = h.currency ?? "UNKNOWN";
    const cur = byCurrency.get(currency) ?? { value: 0, cost: 0, cash: 0 };
    cur.value += h.value;
    if (h.costBasis !== undefined) cur.cost += h.costBasis;
    if (h.isCashEquivalent || h.type === "cash") cur.cash += h.value;
    byCurrency.set(currency, cur);

    const type = h.type ?? "other";
    const tKey = `${currency}:${type}`;
    byType.set(tKey, (byType.get(tKey) ?? 0) + h.value);

    const acc = byAccount.get(h.accountId) ?? { value: 0, cost: 0, count: 0 };
    acc.value += h.value;
    if (h.costBasis !== undefined) acc.cost += h.costBasis;
    acc.count += 1;
    byAccount.set(h.accountId, acc);
  }

  const totalsByCurrency: CurrencyTotals[] = [...byCurrency.entries()]
    .map(([currency, v]) => {
      const gain = v.value - v.cost;
      return {
        currency,
        marketValue: round(v.value),
        costBasis: round(v.cost),
        unrealizedGain: round(gain),
        unrealizedGainPct: v.cost > 0 ? round((gain / v.cost) * 100) : null,
        cashValue: round(v.cash),
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue);

  const accountsById = new Map(accounts.map((a) => [a.accountId, a]));
  const accountSummaries: AccountSummary[] = [...byAccount.entries()]
    .map(([accountId, v]) => {
      const a = accountsById.get(accountId);
      const gain = v.value - v.cost;
      return {
        accountId,
        institution: a?.institution ?? "Unknown",
        name: a?.name ?? accountId,
        subtype: a?.subtype,
        currency: a?.currency ?? "UNKNOWN",
        marketValue: round(v.value),
        costBasis: round(v.cost),
        unrealizedGain: round(gain),
        unrealizedGainPct: v.cost > 0 ? round((gain / v.cost) * 100) : null,
        holdingsCount: v.count,
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue);

  // Include accounts that have a balance but no holdings (e.g. pure cash).
  for (const a of accounts) {
    if (byAccount.has(a.accountId)) continue;
    if (a.currentBalance === undefined) continue;
    accountSummaries.push({
      accountId: a.accountId,
      institution: a.institution,
      name: a.name,
      subtype: a.subtype,
      currency: a.currency ?? "UNKNOWN",
      marketValue: round(a.currentBalance),
      costBasis: 0,
      unrealizedGain: 0,
      unrealizedGainPct: null,
      holdingsCount: 0,
    });
  }

  const allocationByType: AllocationSlice[] = [...byType.entries()]
    .map(([key, value]) => {
      const [currency, type] = key.split(":");
      const total = byCurrency.get(currency)?.value ?? 0;
      return { type, currency, value: round(value), pct: total > 0 ? round((value / total) * 100) : 0 };
    })
    .sort((a, b) => b.value - a.value);

  const topHoldings: TopHolding[] = [...holdings]
    .sort((a, b) => b.value - a.value)
    .slice(0, topN)
    .map((h) => ({
      ticker: h.ticker,
      name: h.name,
      accountName: h.accountName,
      currency: h.currency ?? "UNKNOWN",
      value: h.value,
      unrealizedGain: h.unrealizedGain,
      unrealizedGainPct: h.unrealizedGainPct,
    }));

  const institutions = [...new Set(accounts.map((a) => a.institution))];
  const accountsCount = new Set([...accounts.map((a) => a.accountId), ...holdings.map((h) => h.accountId)]).size;

  const summaryParts = totalsByCurrency.map((t) => {
    const gainStr =
      t.unrealizedGainPct === null
        ? ""
        : ` (unrealized ${t.unrealizedGain >= 0 ? "+" : ""}${fmt(t.unrealizedGain)} ${t.currency}, ${
            t.unrealizedGainPct >= 0 ? "+" : ""
          }${t.unrealizedGainPct}%)`;
    return `${t.currency} ${fmt(t.marketValue)}${gainStr}`;
  });
  const summary =
    holdings.length === 0
      ? `No holdings found across ${accountsCount} account(s).`
      : `Total portfolio value: ${summaryParts.join(" + ")} across ${accountsCount} account(s) at ${institutions.join(
          ", ",
        )}.`;

  return {
    summary,
    totalsByCurrency,
    accounts: accountSummaries,
    allocationByType,
    topHoldings,
    holdingsCount: holdings.length,
    accountsCount,
    institutions,
  };
}

export interface DividendBySecurity {
  ticker?: string;
  name?: string;
  currency: string;
  total: number;
  count: number;
}

export interface DividendSummary {
  summary: string;
  startDate: string;
  endDate: string;
  totalsByCurrency: { currency: string; total: number; count: number }[];
  bySecurity: DividendBySecurity[];
  payments: {
    date: string;
    ticker?: string;
    name?: string;
    accountName: string;
    amount: number;
    currency: string;
  }[];
}

const DIVIDEND_SUBTYPES = new Set(["dividend", "qualified dividend", "non-qualified dividend"]);

export function isDividend(t: InvestmentTransaction): boolean {
  return DIVIDEND_SUBTYPES.has(t.subtype.toLowerCase());
}

export function summarizeDividends(
  txns: InvestmentTransaction[],
  startDate: string,
  endDate: string,
): DividendSummary {
  const dividends = txns.filter(isDividend);
  const byCurrency = new Map<string, { total: number; count: number }>();
  const bySecurity = new Map<string, DividendBySecurity>();

  for (const t of dividends) {
    // Plaid represents dividend inflow as a negative amount; income is the magnitude.
    const income = Math.abs(t.amount);
    const currency = t.currency ?? "UNKNOWN";

    const cur = byCurrency.get(currency) ?? { total: 0, count: 0 };
    cur.total += income;
    cur.count += 1;
    byCurrency.set(currency, cur);

    const key = t.securityId ?? t.ticker ?? t.name ?? "unknown";
    const sec = bySecurity.get(key) ?? { ticker: t.ticker, name: t.name, currency, total: 0, count: 0 };
    sec.total += income;
    sec.count += 1;
    bySecurity.set(key, sec);
  }

  const totalsByCurrency = [...byCurrency.entries()]
    .map(([currency, v]) => ({ currency, total: round(v.total), count: v.count }))
    .sort((a, b) => b.total - a.total);

  const summary =
    dividends.length === 0
      ? `No dividends received between ${startDate} and ${endDate}.`
      : `Received ${totalsByCurrency
          .map((t) => `${t.currency} ${fmt(t.total)}`)
          .join(" + ")} in dividends (${dividends.length} payment(s)) between ${startDate} and ${endDate}.`;

  return {
    summary,
    startDate,
    endDate,
    totalsByCurrency,
    bySecurity: [...bySecurity.values()].map((s) => ({ ...s, total: round(s.total) })).sort((a, b) => b.total - a.total),
    payments: dividends
      .map((t) => ({
        date: t.date,
        ticker: t.ticker,
        name: t.name,
        accountName: t.accountName,
        amount: round(Math.abs(t.amount)),
        currency: t.currency ?? "UNKNOWN",
      }))
      .sort((a, b) => b.date.localeCompare(a.date)),
  };
}
