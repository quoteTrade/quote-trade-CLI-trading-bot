import * as dotenv from "dotenv";
import { loginWithWallet } from "./wallet-auth";
import { generateWallet, getAddressFromPrivateKey, printWalletAddress, printWalletDetails } from "./wallet-utils";
import { fetchAndPrintBalances, fetchAndPrintBlockchainBalances } from "./balances";

dotenv.config();

export type TradeCredentials = { requestToken: string; requestSecret: string };

export type ResolveOptions = { createAccount?: boolean };

let resolved: TradeCredentials | null = null;
/** Set when credentials were resolved via wallet login (for deposit flow). Not persisted. */
let resolvedWalletPrivateKey: string | null = null;

/** Keys we consider safe to show (public profile only). No tokens, secrets, or PII. Case-insensitive. */
const PUBLIC_PROFILE_KEYS = new Set([
  "id", "login", "address", "aliasusername", "roles", "channel", "status", "feetier",
]);

/** Print only public user profile fields. Balances (USDC/USDT/ETH) are shown right after via fetchAndPrintBalances(). */
function printUserProfileTable(profile: Record<string, unknown>): void {
  const display: Record<string, string> = {};
  for (const [k, v] of Object.entries(profile)) {
    if (v === undefined || v === null) continue;
    const keyLower = k.toLowerCase();
    if (!PUBLIC_PROFILE_KEYS.has(keyLower)) continue;
    display[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  if (Object.keys(display).length === 0) return;
  console.log("\nProfile (public):");
  console.table(display);
}

/**
 * Resolve trading credentials:
 * - If createAccount and no WALLET_PRIVATE_KEY: generate wallet (keep in memory), same login flow, then show new wallet details + balances.
 * - If WALLET_PRIVATE_KEY is set: show derived address, same login flow, then show balances.
 * - If TRADE_API_KEY and TRADE_API_SECRET: use them; optionally show balances.
 * Idempotent: after first successful resolution, the same credentials are returned.
 */
export async function resolveCredentials(options: ResolveOptions = {}): Promise<TradeCredentials> {
  if (resolved) return resolved;

  const walletKey = process.env.WALLET_PRIVATE_KEY?.trim();
  const apiKey = process.env.TRADE_API_KEY?.trim();
  const apiSecret = process.env.TRADE_API_SECRET?.trim();
  const createAccount = options.createAccount === true;
  const debug = process.env.CLI_DEBUG === "1";
  if (debug) console.warn("[auth] Resolving credentials: createAccount=" + createAccount + ", hasWALLET_PRIVATE_KEY=" + !!walletKey + ", hasAPIKeys=" + !!(apiKey && apiSecret));

  // Same flow for both: get wallet (generate or from env), then getChallenge → sign → logon → getProfile.
  // Only difference: create-account uses an in-memory generated wallet; we print its details after successful login.
  let privateKeyToUse: string | null = null;
  let newWalletForDisplay: { address: string; privateKey: string } | null = null;

  if (createAccount && !walletKey) {
    const newWallet = generateWallet();
    privateKeyToUse = newWallet.privateKey;
    newWalletForDisplay = { address: newWallet.address, privateKey: newWallet.privateKey };
    if (debug) console.warn("[auth] Generated new wallet, address:", newWallet.address);
  } else if (walletKey) {
    printWalletAddress(getAddressFromPrivateKey(walletKey));
    privateKeyToUse = walletKey;
  }

  if (privateKeyToUse) {
    try {
      const creds = await loginWithWallet(privateKeyToUse);
      resolved = { requestToken: creds.requestToken, requestSecret: creds.requestSecret };
      resolvedWalletPrivateKey = privateKeyToUse;
      process.env.TRADE_API_KEY = creds.requestToken;
      process.env.TRADE_API_SECRET = creds.requestSecret;
      if (newWalletForDisplay) {
        printWalletDetails(newWalletForDisplay, { isNew: true });
      }
      if (creds.profile && Object.keys(creds.profile).length > 0) {
        console.log("\nCredentials: wallet login OK");
        printUserProfileTable(creds.profile);
      } else {
        console.log("\nCredentials: wallet login OK");
      }
      await fetchAndPrintBalances();
      await fetchAndPrintBlockchainBalances(getResolvedWalletAddress());
      return resolved;
    } catch (e: any) {
      throw new Error("Wallet login failed: " + (e?.message ?? String(e)));
    }
  }

  if (apiKey && apiSecret) {
    resolved = { requestToken: apiKey, requestSecret: apiSecret };
    resolvedWalletPrivateKey = null;
    console.log("\nCredentials: using TRADE_API_KEY / TRADE_API_SECRET");
    await fetchAndPrintBalances();
    return resolved;
  }

  if (createAccount && !walletKey) {
    throw new Error("Create account flow failed (no wallet key and generation path did not run).");
  }

  throw new Error(
    "Missing credentials. Set WALLET_PRIVATE_KEY (or use --create-account to generate one), or set both TRADE_API_KEY and TRADE_API_SECRET in .env"
  );
}

/**
 * Return currently resolved credentials or null if not yet resolved.
 * Use resolveCredentials() before trading to ensure credentials are loaded.
 */
export function getResolvedCredentials(): TradeCredentials | null {
  return resolved;
}

/**
 * Return the wallet private key used for login, if credentials were resolved via wallet.
 * Used by deposit flow to sign the ERC20 transfer. Do not log or expose.
 */
export function getResolvedWalletPrivateKey(): string | null {
  return resolvedWalletPrivateKey;
}

/**
 * Return the wallet address used for login, if credentials were resolved via wallet.
 * Used for blockchain balance display.
 */
export function getResolvedWalletAddress(): string | null {
  if (!resolvedWalletPrivateKey) return null;
  return getAddressFromPrivateKey(resolvedWalletPrivateKey);
}
