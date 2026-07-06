import type {
  Account,
  Holding,
  HoldingsResult,
  InvestmentTransaction,
  LinkedItemInfo,
  PortfolioProvider,
  QueryOptions,
  Security,
  TransactionQueryOptions,
  TransactionsResult,
} from "./types.js";

const ITEM_ID = "mock-item-wealthsimple";
const INSTITUTION = "Wealthsimple (Demo)";
const CURRENCY = "CAD";

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

interface HoldingSeed {
  accountId: string;
  securityId: string;
  ticker?: string;
  name: string;
  type: string;
  quantity: number;
  price: number;
  costBasis: number;
  isCashEquivalent?: boolean;
}

const ACCOUNTS: Account[] = [
  {
    itemId: ITEM_ID,
    accountId: "mock-acc-tfsa",
    institution: INSTITUTION,
    name: "TFSA",
    officialName: "Tax-Free Savings Account",
    mask: "0001",
    type: "investment",
    subtype: "tfsa",
    currency: CURRENCY,
  },
  {
    itemId: ITEM_ID,
    accountId: "mock-acc-rrsp",
    institution: INSTITUTION,
    name: "RRSP",
    officialName: "Registered Retirement Savings Plan",
    mask: "0002",
    type: "investment",
    subtype: "rrsp",
    currency: CURRENCY,
  },
  {
    itemId: ITEM_ID,
    accountId: "mock-acc-personal",
    institution: INSTITUTION,
    name: "Personal (Non-Registered)",
    officialName: "Self-Directed Personal Account",
    mask: "0003",
    type: "investment",
    subtype: "brokerage",
    currency: CURRENCY,
  },
];

const HOLDING_SEEDS: HoldingSeed[] = [
  // TFSA
  { accountId: "mock-acc-tfsa", securityId: "sec-vfv", ticker: "VFV.TO", name: "Vanguard S&P 500 Index ETF", type: "etf", quantity: 42, price: 128.35, costBasis: 4200 },
  { accountId: "mock-acc-tfsa", securityId: "sec-xeqt", ticker: "XEQT.TO", name: "iShares Core Equity ETF Portfolio", type: "etf", quantity: 110, price: 33.4, costBasis: 3300 },
  { accountId: "mock-acc-tfsa", securityId: "sec-aapl", ticker: "AAPL", name: "Apple Inc.", type: "equity", quantity: 12, price: 315.4, costBasis: 2600 },
  { accountId: "mock-acc-tfsa", securityId: "sec-cash", name: "CAD Cash", type: "cash", quantity: 640.25, price: 1, costBasis: 640.25, isCashEquivalent: true },
  // RRSP
  { accountId: "mock-acc-rrsp", securityId: "sec-vdy", ticker: "VDY.TO", name: "Vanguard FTSE Canadian High Dividend Yield ETF", type: "etf", quantity: 65, price: 47.1, costBasis: 2600 },
  { accountId: "mock-acc-rrsp", securityId: "sec-td", ticker: "TD.TO", name: "Toronto-Dominion Bank", type: "equity", quantity: 30, price: 88.2, costBasis: 2400 },
  { accountId: "mock-acc-rrsp", securityId: "sec-cash", name: "CAD Cash", type: "cash", quantity: 120.5, price: 1, costBasis: 120.5, isCashEquivalent: true },
  // Personal
  { accountId: "mock-acc-personal", securityId: "sec-shop", ticker: "SHOP", name: "Shopify Inc.", type: "equity", quantity: 18, price: 142.8, costBasis: 1450 },
  { accountId: "mock-acc-personal", securityId: "sec-nvda", ticker: "NVDA", name: "NVIDIA Corporation", type: "equity", quantity: 9, price: 178.6, costBasis: 900 },
];

const SECURITIES: Security[] = [
  { securityId: "sec-vfv", ticker: "VFV.TO", name: "Vanguard S&P 500 Index ETF", type: "etf", closePrice: 128.35, closePriceAsOf: daysAgo(1), currency: CURRENCY, isCashEquivalent: false },
  { securityId: "sec-xeqt", ticker: "XEQT.TO", name: "iShares Core Equity ETF Portfolio", type: "etf", closePrice: 33.4, closePriceAsOf: daysAgo(1), currency: CURRENCY, isCashEquivalent: false },
  { securityId: "sec-aapl", ticker: "AAPL", name: "Apple Inc.", type: "equity", closePrice: 315.4, closePriceAsOf: daysAgo(1), currency: CURRENCY, isCashEquivalent: false },
  { securityId: "sec-vdy", ticker: "VDY.TO", name: "Vanguard FTSE Canadian High Dividend Yield ETF", type: "etf", closePrice: 47.1, closePriceAsOf: daysAgo(1), currency: CURRENCY, isCashEquivalent: false },
  { securityId: "sec-td", ticker: "TD.TO", name: "Toronto-Dominion Bank", type: "equity", closePrice: 88.2, closePriceAsOf: daysAgo(1), currency: CURRENCY, isCashEquivalent: false },
  { securityId: "sec-shop", ticker: "SHOP", name: "Shopify Inc.", type: "equity", closePrice: 142.8, closePriceAsOf: daysAgo(1), currency: CURRENCY, isCashEquivalent: false },
  { securityId: "sec-nvda", ticker: "NVDA", name: "NVIDIA Corporation", type: "equity", closePrice: 178.6, closePriceAsOf: daysAgo(1), currency: CURRENCY, isCashEquivalent: false },
  { securityId: "sec-cash", name: "CAD Cash", type: "cash", closePrice: 1, currency: CURRENCY, isCashEquivalent: true },
];

function buildHoldings(): Holding[] {
  const accountsById = new Map(ACCOUNTS.map((a) => [a.accountId, a]));
  return HOLDING_SEEDS.map((s) => {
    const value = Math.round(s.quantity * s.price * 100) / 100;
    const unrealizedGain = Math.round((value - s.costBasis) * 100) / 100;
    const unrealizedGainPct = s.costBasis ? Math.round((unrealizedGain / s.costBasis) * 10000) / 100 : undefined;
    const account = accountsById.get(s.accountId)!;
    return {
      itemId: ITEM_ID,
      accountId: s.accountId,
      accountName: account.name,
      institution: INSTITUTION,
      securityId: s.securityId,
      ticker: s.ticker,
      name: s.name,
      type: s.type,
      quantity: s.quantity,
      price: s.price,
      priceAsOf: daysAgo(1),
      value,
      costBasis: s.costBasis,
      currency: CURRENCY,
      unrealizedGain,
      unrealizedGainPct,
      isCashEquivalent: s.isCashEquivalent ?? false,
    };
  });
}

function accountBalances(): Account[] {
  const holdings = buildHoldings();
  return ACCOUNTS.map((a) => {
    const current = Math.round(
      holdings.filter((h) => h.accountId === a.accountId).reduce((sum, h) => sum + h.value, 0) * 100,
    ) / 100;
    return { ...a, currentBalance: current, availableBalance: current };
  });
}

function buildTransactions(): InvestmentTransaction[] {
  const mk = (
    id: string,
    accountId: string,
    date: string,
    type: string,
    subtype: string,
    name: string,
    amount: number,
    extra: Partial<InvestmentTransaction> = {},
  ): InvestmentTransaction => {
    const account = ACCOUNTS.find((a) => a.accountId === accountId)!;
    return {
      investmentTransactionId: id,
      itemId: ITEM_ID,
      accountId,
      accountName: account.name,
      institution: INSTITUTION,
      date,
      type,
      subtype,
      name,
      amount,
      quantity: extra.quantity ?? 0,
      currency: CURRENCY,
      ...extra,
    };
  };

  return [
    mk("mtx-1", "mock-acc-tfsa", daysAgo(3), "buy", "buy", "Buy VFV.TO", 642.0, { securityId: "sec-vfv", ticker: "VFV.TO", quantity: 5, price: 128.4 }),
    mk("mtx-2", "mock-acc-rrsp", daysAgo(8), "cash", "dividend", "Dividend VDY.TO", -38.55, { securityId: "sec-vdy", ticker: "VDY.TO" }),
    mk("mtx-3", "mock-acc-tfsa", daysAgo(12), "cash", "dividend", "Dividend VFV.TO", -21.4, { securityId: "sec-vfv", ticker: "VFV.TO" }),
    mk("mtx-4", "mock-acc-personal", daysAgo(18), "sell", "sell", "Sell SHOP", -285.6, { securityId: "sec-shop", ticker: "SHOP", quantity: -2, price: 142.8 }),
    mk("mtx-5", "mock-acc-tfsa", daysAgo(25), "cash", "contribution", "Contribution", -500.0),
    mk("mtx-6", "mock-acc-rrsp", daysAgo(30), "cash", "dividend", "Dividend TD.TO", -30.6, { securityId: "sec-td", ticker: "TD.TO" }),
    mk("mtx-7", "mock-acc-personal", daysAgo(33), "buy", "buy", "Buy NVDA", 357.2, { securityId: "sec-nvda", ticker: "NVDA", quantity: 2, price: 178.6 }),
    mk("mtx-8", "mock-acc-personal", daysAgo(45), "fee", "management fee", "Management fee", 3.15),
    mk("mtx-9", "mock-acc-tfsa", daysAgo(60), "cash", "dividend", "Dividend AAPL", -6.0, { securityId: "sec-aapl", ticker: "AAPL" }),
    mk("mtx-10", "mock-acc-rrsp", daysAgo(75), "buy", "buy", "Buy VDY.TO", 471.0, { securityId: "sec-vdy", ticker: "VDY.TO", quantity: 10, price: 47.1 }),
  ];
}

function filterByAccount<T>(items: T[], accountIds: string[] | undefined, getId: (t: T) => string): T[] {
  if (!accountIds || accountIds.length === 0) return items;
  const allow = new Set(accountIds);
  return items.filter((i) => allow.has(getId(i)));
}

export class MockProvider implements PortfolioProvider {
  readonly kind = "mock" as const;

  async isReady(): Promise<boolean> {
    return true;
  }

  async listLinkedItems(): Promise<LinkedItemInfo[]> {
    return [{ itemId: ITEM_ID, institution: INSTITUTION, linkedAt: daysAgo(90), accounts: ACCOUNTS.length }];
  }

  async listAccounts(): Promise<Account[]> {
    return accountBalances();
  }

  async getBalances(opts: QueryOptions = {}): Promise<Account[]> {
    return filterByAccount(accountBalances(), opts.accountIds, (a) => a.accountId);
  }

  async getHoldings(opts: QueryOptions = {}): Promise<HoldingsResult> {
    const holdings = filterByAccount(buildHoldings(), opts.accountIds, (h) => h.accountId);
    const usedSecurities = new Set(holdings.map((h) => h.securityId));
    return {
      accounts: filterByAccount(accountBalances(), opts.accountIds, (a) => a.accountId),
      holdings,
      securities: SECURITIES.filter((s) => usedSecurities.has(s.securityId)),
    };
  }

  async getInvestmentTransactions(opts: TransactionQueryOptions): Promise<TransactionsResult> {
    let txns = buildTransactions().filter((t) => t.date >= opts.startDate && t.date <= opts.endDate);
    txns = filterByAccount(txns, opts.accountIds, (t) => t.accountId);
    txns.sort((a, b) => b.date.localeCompare(a.date));
    const usedSecurities = new Set(txns.map((t) => t.securityId).filter(Boolean) as string[]);
    return {
      accounts: filterByAccount(accountBalances(), opts.accountIds, (a) => a.accountId),
      securities: SECURITIES.filter((s) => usedSecurities.has(s.securityId)),
      transactions: txns,
    };
  }
}
