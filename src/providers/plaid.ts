import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
  type AccountBase,
  type Holding as PlaidHolding,
  type Security as PlaidSecurity,
  type InvestmentTransaction as PlaidInvestmentTransaction,
} from "plaid";
import { config } from "../config.js";
import { log } from "../logger.js";
import { listItems, upsertItem, type StoredItem } from "../store.js";
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

let client: PlaidApi | null = null;

export function getPlaidClient(): PlaidApi {
  if (client) return client;
  const configuration = new Configuration({
    basePath: PlaidEnvironments[config.plaid.env],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": config.plaid.clientId,
        "PLAID-SECRET": config.plaid.secret,
      },
    },
  });
  client = new PlaidApi(configuration);
  return client;
}

// --- enum mapping -----------------------------------------------------------

export function toProducts(values: string[]): Products[] {
  const valid = new Set<string>(Object.values(Products));
  return values.map((v) => v.toLowerCase()).filter((v) => valid.has(v)) as Products[];
}

export function toCountryCodes(values: string[]): CountryCode[] {
  const valid = new Set<string>(Object.values(CountryCode));
  return values.map((v) => v.toUpperCase()).filter((v) => valid.has(v)) as CountryCode[];
}

// --- error handling ---------------------------------------------------------

export interface PlaidErrorInfo {
  code?: string;
  message: string;
  type?: string;
}

export function extractPlaidError(err: unknown): PlaidErrorInfo {
  const anyErr = err as { response?: { data?: { error_code?: string; error_message?: string; error_type?: string } }; message?: string };
  const data = anyErr?.response?.data;
  if (data?.error_code) {
    return { code: data.error_code, message: data.error_message ?? data.error_code, type: data.error_type };
  }
  return { message: anyErr?.message ?? "Unknown Plaid error" };
}

/** Errors we can safely skip for one item without failing the whole request. */
const SKIPPABLE = new Set([
  "PRODUCT_NOT_READY",
  "NO_INVESTMENT_ACCOUNTS",
  "NO_ACCOUNTS",
  "PRODUCTS_NOT_SUPPORTED",
]);

// --- normalization ----------------------------------------------------------

// The investments endpoints return `InvestmentAccount` while accounts/balance
// return `AccountBase`. They differ only in fields we don't use (e.g.
// verification_status enum), so we normalize against a shared structural subset.
type AccountLike = Pick<AccountBase, "account_id" | "name" | "official_name" | "mask" | "type" | "subtype" | "balances">;

function currencyOf(x: { iso_currency_code?: string | null; unofficial_currency_code?: string | null }): string | undefined {
  return x.iso_currency_code ?? x.unofficial_currency_code ?? undefined;
}

function round(n: number | null | undefined, dp = 2): number | undefined {
  if (n === null || n === undefined || !Number.isFinite(n)) return undefined;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function normalizeAccount(a: AccountLike, item: StoredItem): Account {
  return {
    itemId: item.itemId,
    accountId: a.account_id,
    institution: item.institution,
    name: a.name,
    officialName: a.official_name ?? undefined,
    mask: a.mask ?? undefined,
    type: String(a.type),
    subtype: a.subtype ? String(a.subtype) : undefined,
    currentBalance: round(a.balances.current),
    availableBalance: round(a.balances.available),
    currency: currencyOf(a.balances),
  };
}

function normalizeSecurity(s: PlaidSecurity): Security {
  return {
    securityId: s.security_id,
    name: s.name ?? undefined,
    ticker: s.ticker_symbol ?? undefined,
    type: s.type ?? undefined,
    closePrice: round(s.close_price, 4),
    closePriceAsOf: s.close_price_as_of ?? undefined,
    currency: currencyOf(s),
    isCashEquivalent: s.is_cash_equivalent ?? undefined,
  };
}

function normalizeHolding(
  h: PlaidHolding,
  item: StoredItem,
  accountsById: Map<string, AccountLike>,
  securitiesById: Map<string, PlaidSecurity>,
): Holding {
  const security = securitiesById.get(h.security_id);
  const account = accountsById.get(h.account_id);
  const value = h.institution_value;
  const costBasis = h.cost_basis ?? undefined;
  const unrealizedGain = costBasis !== undefined ? round(value - costBasis) : undefined;
  const unrealizedGainPct =
    costBasis !== undefined && costBasis !== 0 ? round(((value - costBasis) / costBasis) * 100) : undefined;
  return {
    itemId: item.itemId,
    accountId: h.account_id,
    accountName: account?.name ?? h.account_id,
    institution: item.institution,
    securityId: h.security_id,
    ticker: security?.ticker_symbol ?? undefined,
    name: security?.name ?? undefined,
    type: security?.type ?? undefined,
    quantity: round(h.quantity, 6) ?? h.quantity,
    price: round(h.institution_price, 4) ?? h.institution_price,
    priceAsOf: h.institution_price_as_of ?? undefined,
    value: round(value) ?? value,
    costBasis: round(costBasis),
    currency: currencyOf(h),
    unrealizedGain,
    unrealizedGainPct,
    isCashEquivalent: security?.is_cash_equivalent ?? undefined,
  };
}

function normalizeTransaction(
  t: PlaidInvestmentTransaction,
  item: StoredItem,
  accountsById: Map<string, AccountLike>,
  securitiesById: Map<string, PlaidSecurity>,
): InvestmentTransaction {
  const security = t.security_id ? securitiesById.get(t.security_id) : undefined;
  const account = accountsById.get(t.account_id);
  return {
    investmentTransactionId: t.investment_transaction_id,
    itemId: item.itemId,
    accountId: t.account_id,
    accountName: account?.name ?? t.account_id,
    institution: item.institution,
    securityId: t.security_id ?? undefined,
    ticker: security?.ticker_symbol ?? undefined,
    name: t.name,
    date: t.date,
    type: String(t.type),
    subtype: String(t.subtype),
    quantity: round(t.quantity, 6) ?? t.quantity,
    amount: round(t.amount) ?? t.amount,
    price: round(t.price, 4),
    fees: round(t.fees),
    currency: currencyOf(t),
  };
}

// --- provider ---------------------------------------------------------------

export class PlaidProvider implements PortfolioProvider {
  readonly kind = "plaid" as const;

  async isReady(): Promise<boolean> {
    return (await listItems()).length > 0;
  }

  async listLinkedItems(): Promise<LinkedItemInfo[]> {
    const items = await listItems();
    const results: LinkedItemInfo[] = [];
    for (const item of items) {
      let accounts = 0;
      try {
        const res = await getPlaidClient().accountsGet({ access_token: item.accessToken });
        accounts = res.data.accounts.length;
      } catch (err) {
        log.warn("Could not count accounts for item", { itemId: item.itemId, error: extractPlaidError(err).message });
      }
      results.push({ itemId: item.itemId, institution: item.institution, linkedAt: item.linkedAt, accounts });
    }
    return results;
  }

  async listAccounts(): Promise<Account[]> {
    const items = await listItems();
    const out: Account[] = [];
    for (const item of items) {
      try {
        const res = await getPlaidClient().accountsGet({ access_token: item.accessToken });
        for (const a of res.data.accounts) out.push(normalizeAccount(a, item));
      } catch (err) {
        this.handleItemError("accountsGet", item, err);
      }
    }
    return out;
  }

  async getBalances(opts: QueryOptions = {}): Promise<Account[]> {
    const items = await listItems();
    const out: Account[] = [];
    for (const item of items) {
      try {
        const res = await getPlaidClient().accountsBalanceGet({
          access_token: item.accessToken,
          options: opts.accountIds ? { account_ids: opts.accountIds } : undefined,
        });
        for (const a of res.data.accounts) out.push(normalizeAccount(a, item));
      } catch (err) {
        this.handleItemError("accountsBalanceGet", item, err);
      }
    }
    return filterByAccount(out, opts.accountIds, (a) => a.accountId);
  }

  async getHoldings(opts: QueryOptions = {}): Promise<HoldingsResult> {
    const items = await listItems();
    const accounts: Account[] = [];
    const holdings: Holding[] = [];
    const securities = new Map<string, Security>();

    for (const item of items) {
      try {
        const res = await getPlaidClient().investmentsHoldingsGet({
          access_token: item.accessToken,
          options: opts.accountIds ? { account_ids: opts.accountIds } : undefined,
        });
        const accountsById = new Map<string, AccountLike>(res.data.accounts.map((a) => [a.account_id, a]));
        const securitiesById = new Map(res.data.securities.map((s) => [s.security_id, s]));
        for (const a of res.data.accounts) accounts.push(normalizeAccount(a, item));
        for (const s of res.data.securities) securities.set(s.security_id, normalizeSecurity(s));
        for (const h of res.data.holdings) {
          holdings.push(normalizeHolding(h, item, accountsById, securitiesById));
        }
      } catch (err) {
        this.handleItemError("investmentsHoldingsGet", item, err);
      }
    }

    return {
      accounts: filterByAccount(accounts, opts.accountIds, (a) => a.accountId),
      holdings: filterByAccount(holdings, opts.accountIds, (h) => h.accountId),
      securities: [...securities.values()],
    };
  }

  async getInvestmentTransactions(opts: TransactionQueryOptions): Promise<TransactionsResult> {
    const items = await listItems();
    const accounts: Account[] = [];
    const securities = new Map<string, Security>();
    const transactions: InvestmentTransaction[] = [];

    for (const item of items) {
      try {
        const pageSize = 500;
        let offset = 0;
        let total = Infinity;
        const rawSecurities = new Map<string, PlaidSecurity>();
        const rawAccounts = new Map<string, AccountLike>();

        while (offset < total) {
          const res = await getPlaidClient().investmentsTransactionsGet({
            access_token: item.accessToken,
            start_date: opts.startDate,
            end_date: opts.endDate,
            options: {
              count: pageSize,
              offset,
              account_ids: opts.accountIds,
            },
          });
          total = res.data.total_investment_transactions;
          for (const a of res.data.accounts) rawAccounts.set(a.account_id, a);
          for (const s of res.data.securities) rawSecurities.set(s.security_id, s);
          for (const t of res.data.investment_transactions) {
            transactions.push(normalizeTransaction(t, item, rawAccounts, rawSecurities));
          }
          offset += res.data.investment_transactions.length;
          if (res.data.investment_transactions.length === 0) break;
        }

        for (const a of rawAccounts.values()) accounts.push(normalizeAccount(a, item));
        for (const s of rawSecurities.values()) securities.set(s.security_id, normalizeSecurity(s));
      } catch (err) {
        this.handleItemError("investmentsTransactionsGet", item, err);
      }
    }

    return {
      accounts: filterByAccount(accounts, opts.accountIds, (a) => a.accountId),
      securities: [...securities.values()],
      transactions: filterByAccount(transactions, opts.accountIds, (t) => t.accountId).sort((a, b) =>
        b.date.localeCompare(a.date),
      ),
    };
  }

  private handleItemError(op: string, item: StoredItem, err: unknown): void {
    const info = extractPlaidError(err);
    if (info.code && SKIPPABLE.has(info.code)) {
      log.warn(`Skipping item for ${op}`, { itemId: item.itemId, code: info.code });
      return;
    }
    log.error(`Plaid ${op} failed`, { itemId: item.itemId, code: info.code, message: info.message });
    throw new PlaidRequestError(info);
  }
}

export class PlaidRequestError extends Error {
  code?: string;
  type?: string;
  constructor(info: PlaidErrorInfo) {
    super(info.message);
    this.name = "PlaidRequestError";
    this.code = info.code;
    this.type = info.type;
  }
}

function filterByAccount<T>(items: T[], accountIds: string[] | undefined, getId: (t: T) => string): T[] {
  if (!accountIds || accountIds.length === 0) return items;
  const allow = new Set(accountIds);
  return items.filter((i) => allow.has(getId(i)));
}

// --- link / onboarding helpers ---------------------------------------------

export async function createLinkToken(): Promise<string> {
  const res = await getPlaidClient().linkTokenCreate({
    user: { client_user_id: "poke-plaid-mcp-user" },
    client_name: config.plaid.appName,
    language: "en",
    products: toProducts(config.plaid.products),
    country_codes: toCountryCodes(config.plaid.countryCodes),
    // Wealthsimple and other OAuth institutions require a registered redirect URI.
    ...(config.plaid.env === "production" ? { redirect_uri: config.plaid.redirectUri } : {}),
  });
  return res.data.link_token;
}

export async function resolveInstitutionName(institutionId: string | null | undefined): Promise<string> {
  if (!institutionId) return "Unknown institution";
  try {
    const res = await getPlaidClient().institutionsGetById({
      institution_id: institutionId,
      country_codes: toCountryCodes(config.plaid.countryCodes),
    });
    return res.data.institution.name;
  } catch {
    return institutionId;
  }
}

export async function exchangePublicToken(publicToken: string, institutionName?: string): Promise<StoredItem> {
  const exchange = await getPlaidClient().itemPublicTokenExchange({ public_token: publicToken });
  const accessToken = exchange.data.access_token;
  const itemId = exchange.data.item_id;

  let institution = institutionName ?? "";
  if (!institution) {
    const itemRes = await getPlaidClient().itemGet({ access_token: accessToken });
    institution = await resolveInstitutionName(itemRes.data.item.institution_id);
  }

  const stored: StoredItem = {
    itemId,
    institution: institution || "Unknown institution",
    linkedAt: new Date().toISOString(),
    accessToken,
  };
  await upsertItem(stored);
  return stored;
}

/** Sandbox-only: create a linkable item without going through Link in a browser. */
export async function createSandboxItem(institutionId: string): Promise<StoredItem> {
  const pub = await getPlaidClient().sandboxPublicTokenCreate({
    institution_id: institutionId,
    initial_products: toProducts(config.plaid.products),
  });
  const institution = await resolveInstitutionName(institutionId);
  return exchangePublicToken(pub.data.public_token, institution);
}
