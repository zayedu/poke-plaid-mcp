import { Router, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { log } from "../logger.js";
import { getProvider } from "../providers/index.js";
import { createLinkToken, exchangePublicToken, extractPlaidError } from "../providers/plaid.js";
import { listItems, removeItem } from "../store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// setup.html lives in src/public; after build it is copied next to dist/routes.
const PUBLIC_DIR = path.resolve(__dirname, "../public");

function requirePlaid(res: Response): boolean {
  if (config.providerKind !== "plaid") {
    res.status(400).json({
      error:
        "Server is running in MOCK mode. Set PLAID_CLIENT_ID and PLAID_SECRET in your .env and restart to link a real account.",
    });
    return false;
  }
  return true;
}

export function linkRouter(): Router {
  const router = Router();

  router.get("/setup", (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "setup.html"));
  });

  router.get("/setup/status", async (_req: Request, res: Response) => {
    try {
      const provider = getProvider();
      const items = await provider.listLinkedItems();
      res.json({
        mode: config.providerKind,
        env: config.plaid.env,
        products: config.plaid.products,
        countryCodes: config.plaid.countryCodes,
        linkedItems: items,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/setup/link-token", async (_req: Request, res: Response) => {
    if (!requirePlaid(res)) return;
    try {
      const linkToken = await createLinkToken();
      res.json({ linkToken });
    } catch (err) {
      const info = extractPlaidError(err);
      log.error("link-token creation failed", { code: info.code, message: info.message });
      res.status(502).json({ error: info.message, code: info.code });
    }
  });

  router.post("/setup/exchange", async (req: Request, res: Response) => {
    if (!requirePlaid(res)) return;
    const publicToken = req.body?.public_token as string | undefined;
    const institution = req.body?.institution as string | undefined;
    if (!publicToken) {
      res.status(400).json({ error: "Missing public_token" });
      return;
    }
    try {
      const item = await exchangePublicToken(publicToken, institution);
      res.json({ itemId: item.itemId, institution: item.institution });
    } catch (err) {
      const info = extractPlaidError(err);
      log.error("public_token exchange failed", { code: info.code, message: info.message });
      res.status(502).json({ error: info.message, code: info.code });
    }
  });

  router.post("/setup/remove", async (req: Request, res: Response) => {
    const itemId = req.body?.itemId as string | undefined;
    if (!itemId) {
      res.status(400).json({ error: "Missing itemId" });
      return;
    }
    const removed = await removeItem(itemId);
    res.json({ removed });
  });

  // Returns linked items as PLAID_ITEMS JSON for copying into Render env (survives
  // ephemeral disk). Protected by the same setup token as other /setup routes.
  router.get("/setup/export-seed", async (_req: Request, res: Response) => {
    if (!requirePlaid(res)) return;
    try {
      const items = await listItems();
      const seed = items.map(({ itemId, institution, institutionId, linkedAt, accessToken }) => ({
        itemId,
        institution,
        ...(institutionId ? { institutionId } : {}),
        accessToken,
        linkedAt,
      }));
      res.json({ plaidItems: JSON.stringify(seed) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
