import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { log } from "./logger.js";

// Persisted record for one linked Plaid Item (institution login). The Plaid
// access token is encrypted at rest with AES-256-GCM.
export interface StoredItem {
  itemId: string;
  institution: string;
  institutionId?: string;
  linkedAt: string;
  accessToken: string; // decrypted in memory only
}

interface EncryptedBlob {
  iv: string;
  tag: string;
  data: string;
}

interface StoredItemOnDisk extends Omit<StoredItem, "accessToken"> {
  accessToken: EncryptedBlob;
}

interface StoreFile {
  version: 1;
  items: StoredItemOnDisk[];
}

const FILE = path.resolve(config.storage.tokenStorePath);
const ALGO = "aes-256-gcm";

// Derive a stable 32-byte key. A user-provided key is strongly recommended; the
// fallback only obfuscates and is clearly warned about at startup.
let warnedAboutKey = false;
function key(): Buffer {
  const secret = config.storage.encryptionKey;
  if (!secret && !warnedAboutKey) {
    warnedAboutKey = true;
    log.warn(
      "TOKEN_ENCRYPTION_KEY is not set — access tokens are obfuscated but not strongly encrypted. Set it for production.",
    );
  }
  return crypto.scryptSync(secret || "poke-plaid-mcp-insecure-default", "poke-plaid-mcp-salt", 32);
}

function encrypt(plaintext: string): EncryptedBlob {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decrypt(blob: EncryptedBlob): string {
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(blob.data, "base64")), decipher.final()]).toString("utf8");
}

async function readFile(): Promise<StoreFile> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    if (!parsed.items) return { version: 1, items: [] };
    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, items: [] };
    throw err;
  }
}

async function writeFile(store: StoreFile): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true, mode: 0o700 });
  await fs.writeFile(FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export async function listItems(): Promise<StoredItem[]> {
  const store = await readFile();
  const items: StoredItem[] = [];
  for (const it of store.items) {
    try {
      items.push({ ...it, accessToken: decrypt(it.accessToken) });
    } catch (err) {
      log.error("Failed to decrypt a stored item (wrong TOKEN_ENCRYPTION_KEY?)", {
        itemId: it.itemId,
        error: (err as Error).message,
      });
    }
  }
  return items;
}

export async function upsertItem(item: StoredItem): Promise<void> {
  const store = await readFile();
  const onDisk: StoredItemOnDisk = {
    itemId: item.itemId,
    institution: item.institution,
    institutionId: item.institutionId,
    linkedAt: item.linkedAt,
    accessToken: encrypt(item.accessToken),
  };
  const idx = store.items.findIndex((i) => i.itemId === item.itemId);
  if (idx >= 0) store.items[idx] = onDisk;
  else store.items.push(onDisk);
  await writeFile(store);
  log.info("Stored linked item", { itemId: item.itemId, institution: item.institution });
}

export async function removeItem(itemId: string): Promise<boolean> {
  const store = await readFile();
  const before = store.items.length;
  store.items = store.items.filter((i) => i.itemId !== itemId);
  const removed = store.items.length < before;
  if (removed) await writeFile(store);
  return removed;
}
