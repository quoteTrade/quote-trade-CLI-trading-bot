import * as dotenv from "dotenv";
import { loginWithWallet } from "./wallet-auth";
import type { Ed25519Options, Ed25519RegisterResult } from "./wallet-auth";
import { generateWallet, getAddressFromPrivateKey, printWalletAddress, printWalletDetails } from "./wallet-utils";
import { fetchAndPrintBalances, fetchAndPrintBlockchainBalances } from "./balances";
import {
  setSigningContext,
  resolveSigningAlgorithmFromEnv,
  clearSigningContext,
} from "./signing-context";
import type { SigningAlgorithm } from "./signing-context";
import { pkcs8PemToBase64Body } from "./ed25519-utils";

dotenv.config();

export type TradeCredentials = { requestToken: string; requestSecret: string };

/**
 * Options for resolveCredentials().
 *
 * Auth mode selection (mutually exclusive; evaluated in priority order):
 *  1. createAccount=true  → generate a brand-new wallet, register + login
 *  2. existingWallet=true → use WALLET_PRIVATE_KEY from .env, register (if new) + login
 *  3. (default)           → use TRADE_API_KEY / TRADE_API_SECRET from .env
 *
 * ed25519 options are forwarded to registerUser when a wallet-based registration occurs.
 *
 * Signing algorithm:
 *  Both SHA256 and Ed25519 modes use the same TRADE_API_KEY / TRADE_API_SECRET env vars.
 *  SIGNING_ALGORITHM (or --signing-algorithm CLI flag) controls how the secret is used:
 *    sha256  → TRADE_API_SECRET is an HMAC key
 *    ed25519 → TRADE_API_SECRET is a PKCS#8 PEM private key
 */
export type ResolveOptions = {
  /** Generate a new wallet, register it, and login. Mutually exclusive with existingWallet. */
  createAccount?: boolean;
  /** Use WALLET_PRIVATE_KEY from .env to register (if new) and login. */
  existingWallet?: boolean;
  /** Optional Ed25519 public key to attach during registration. */
  ed25519?: Ed25519Options;
  /**
   * When --generate-ed25519-key was used, the generated private key PEM is passed here
   * so it can be included in the printed summary alongside the Ed25519 API key.
   */
  generatedEd25519PrivateKeyPem?: string;
  /**
   * Wallet auth base URL override.
   * Priority: this value → API_BASE_URL env var → error.
   * No hardcoded default — must be configured explicitly.
   */
  authBaseUrl?: string;
  /**
   * Signing algorithm for API requests.
   * Priority: this value → SIGNING_ALGORITHM env var → default "sha256".
   *
   *  sha256  — HMAC-SHA256 (default). TRADE_API_SECRET is the HMAC key.
   *  ed25519 — Ed25519 signing. TRADE_API_SECRET is the PKCS#8 PEM private key.
   *
   * In both modes TRADE_API_KEY is sent as X-Mbx-Apikey.
   */
  signingAlgorithm?: SigningAlgorithm;
};

let resolved: TradeCredentials | null = null;
/** Set when credentials were resolved via wallet login (for deposit flow). Not persisted. */
let resolvedWalletPrivateKey: string | null = null;
/** Signing algorithm resolved during the last resolveCredentials() call. */
let resolvedSigningAlgorithm: SigningAlgorithm = "sha256";

/** Keys we consider safe to show (public profile only). No tokens, secrets, or PII. Case-insensitive. */
const PUBLIC_PROFILE_KEYS = new Set([
  "id", "login", "address", "aliasusername", "roles", "channel", "status", "feetier",
]);

/** Print only public user profile fields. Balances are shown right after via fetchAndPrintBalances(). */
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
 * Print the SHA256 API keys (requestToken / requestSecret) that were generated during registration.
 * These are the keys the user should save to .env for future headless runs.
 */
function printSha256ApiKeyDetails(requestToken: string, requestSecret: string): void {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  KEY SET 1 — SHA256 / HMAC-SHA256 Trading Keys");
  console.log("  Use these for standard trading API calls.");
  console.log("  Save to .env — you will NOT need WALLET_PRIVATE_KEY once set.");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TRADE_API_KEY    =", requestToken);
  console.log("  TRADE_API_SECRET =", requestSecret);
  console.log("═══════════════════════════════════════════════════════════\n");
}

/**
 * Print the Ed25519 API key returned by the registerUser endpoint.
 *
 * When using Ed25519 signing, set:
 *   TRADE_API_KEY     = Ed25519 API key (printed below)
 *   TRADE_API_SECRET  = Ed25519 private key — base64 body only, no PEM headers (printed below)
 *   SIGNING_ALGORITHM = ed25519
 *
 * The platform never sees or stores the private key.
 */
function printEd25519ApiKeyDetails(
  result: Ed25519RegisterResult,
  generatedPrivateKeyPem?: string
): void {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  KEY SET 2 — Ed25519 API Key");
  console.log("  Key name: " + result.ed25519KeyName);
  console.log("  To use Ed25519 signing, set in .env:");
  console.log("    TRADE_API_KEY     = Ed25519 API key (below)");
  console.log("    TRADE_API_SECRET  = Ed25519 private key base64 body (below)");
  console.log("    SIGNING_ALGORITHM = ed25519");
  console.log("═══════════════════════════════════════════════════════════");

  if (result.ed25519ApiKey) {
    console.log("  Ed25519 API Key  =", result.ed25519ApiKey);
  } else {
    console.log("  ⚠️  The platform did not return an Ed25519 API key in the registration response.");
    console.log("      Check your account dashboard or contact support.");
  }

  console.log("───────────────────────────────────────────────────────────");
  if (generatedPrivateKeyPem) {
    // Print only the base64 body — no PEM headers — for easy .env pasting
    const base64Body = pkcs8PemToBase64Body(generatedPrivateKeyPem);
    console.log("  Ed25519 Private Key — base64 body (SECRET — KEEP SECURE):");
    console.log("  Paste this as TRADE_API_SECRET in .env (no headers needed).");
    console.log("  The platform does NOT store this. Save it now.\n");
    console.log("  " + base64Body);
    console.log("\n  ⚠️  Copy the private key and store it securely before continuing.");
  } else {
    console.log("  Ed25519 Private Key: you provided your own public key,");
    console.log("  so the corresponding private key is already in your possession.");
    console.log("  Set TRADE_API_SECRET = base64 body of your PKCS#8 private key.");
  }
  console.log("═══════════════════════════════════════════════════════════\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: wallet-based login (shared by existingWallet + createAccount paths)
// ─────────────────────────────────────────────────────────────────────────────

async function loginViaWallet(
  privateKey: string,
  isNewWallet: boolean,
  walletDisplayDetails: { address: string; privateKey: string } | null,
  ed25519: Ed25519Options | undefined,
  generatedEd25519PrivateKeyPem: string | undefined,
  authBaseUrl: string | undefined,
  signingAlgorithm: SigningAlgorithm,
  debug: boolean
): Promise<TradeCredentials> {
  const creds = await loginWithWallet(privateKey, authBaseUrl, { ed25519 });
  resolved = { requestToken: creds.requestToken, requestSecret: creds.requestSecret };
  resolvedWalletPrivateKey = privateKey;
  resolvedSigningAlgorithm = signingAlgorithm;

  // Propagate SHA256 keys to env (always — user may want to save them)
  process.env.TRADE_API_KEY = creds.requestToken;
  process.env.TRADE_API_SECRET = creds.requestSecret;

  if (walletDisplayDetails) {
    printWalletDetails(walletDisplayDetails, { isNew: isNewWallet });
  }

  if (creds.profile && Object.keys(creds.profile).length > 0) {
    console.log("\nCredentials: wallet login OK");
    printUserProfileTable(creds.profile);
  } else {
    console.log("\nCredentials: wallet login OK");
  }

  // Always print the SHA256 API keys so the user can save them
  printSha256ApiKeyDetails(creds.requestToken, creds.requestSecret);

  // If an Ed25519 key was attached during registration, print the Ed25519 API key
  if (creds.ed25519Result) {
    printEd25519ApiKeyDetails(creds.ed25519Result, generatedEd25519PrivateKeyPem);
  }

  // ── Populate the signing context ──────────────────────────────────────────
  if (signingAlgorithm === "ed25519" && creds.ed25519Result?.ed25519ApiKey) {
    // Ed25519 mode: use the platform-issued Ed25519 API key + the private key.
    // TRADE_API_SECRET stores the raw base64 body (no PEM headers).
    // signRequestBodyEd25519() accepts raw base64 and reconstructs the PEM internally.
    const ed25519PrivateKeyBase64 = generatedEd25519PrivateKeyPem
      ? pkcs8PemToBase64Body(generatedEd25519PrivateKeyPem)
      : (process.env.TRADE_API_SECRET?.trim() ?? "");

    if (!ed25519PrivateKeyBase64) {
      console.warn(
        "⚠️  SIGNING_ALGORITHM=ed25519 but no Ed25519 private key is available.\n" +
        "   Falling back to SHA256 signing.\n" +
        "   To use Ed25519 signing, use --generate-ed25519-key and set SIGNING_ALGORITHM=ed25519."
      );
      setSigningContext({
        algorithm: "sha256",
        apiKey: creds.requestToken,
        signingSecret: creds.requestSecret,
      });
    } else {
      // Override TRADE_API_KEY / TRADE_API_SECRET with Ed25519 credentials
      process.env.TRADE_API_KEY = creds.ed25519Result.ed25519ApiKey;
      process.env.TRADE_API_SECRET = ed25519PrivateKeyBase64;
      setSigningContext({
        algorithm: "ed25519",
        apiKey: creds.ed25519Result.ed25519ApiKey,
        signingSecret: ed25519PrivateKeyBase64,
      });
      console.log(`\n🔑 Signing algorithm: Ed25519 (API key: ${creds.ed25519Result.ed25519ApiKey})`);
    }
  } else if (signingAlgorithm === "ed25519") {
    // Ed25519 requested but no Ed25519 result from registration.
    // Use TRADE_API_SECRET as-is (raw base64 body or full PEM — both accepted by signRequestBodyEd25519).
    const existingSecret = process.env.TRADE_API_SECRET?.trim() ?? "";
    if (existingSecret) {
      setSigningContext({
        algorithm: "ed25519",
        apiKey: creds.requestToken,
        signingSecret: existingSecret,
      });
      console.log(`\n🔑 Signing algorithm: Ed25519 (using TRADE_API_SECRET as private key)`);
    } else {
      console.warn(
        "⚠️  SIGNING_ALGORITHM=ed25519 but TRADE_API_SECRET is not set.\n" +
        "   Falling back to SHA256 signing."
      );
      setSigningContext({
        algorithm: "sha256",
        apiKey: creds.requestToken,
        signingSecret: creds.requestSecret,
      });
    }
  } else {
    // Default: SHA256
    setSigningContext({
      algorithm: "sha256",
      apiKey: creds.requestToken,
      signingSecret: creds.requestSecret,
    });
  }

  await fetchAndPrintBalances();
  await fetchAndPrintBlockchainBalances(getResolvedWalletAddress());
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve trading credentials using one of three modes:
 *
 * Mode A — API keys (.env):
 *   TRADE_API_KEY + TRADE_API_SECRET are set in .env.
 *   No wallet interaction. Fastest path for users already registered via UI.
 *   SIGNING_ALGORITHM controls how TRADE_API_SECRET is used:
 *     sha256  → HMAC key (default)
 *     ed25519 → PKCS#8 PEM private key
 *
 * Mode B — Existing wallet (.env or --existing-wallet flag):
 *   WALLET_PRIVATE_KEY is set in .env (or existingWallet=true is passed).
 *   Derives wallet address, calls getChallenge → sign → registerUser (if new) → logon → getUserProfile.
 *   Prints the resulting SHA256 API keys for the user to save.
 *   If an Ed25519 key was attached, also prints the Ed25519 API key + private key reminder.
 *
 * Mode C — New wallet (--create-wallet flag):
 *   No WALLET_PRIVATE_KEY in .env, createAccount=true.
 *   Generates a fresh wallet, same flow as Mode B.
 *   Prints wallet address + private key + SHA256 API keys + Ed25519 API key (if applicable).
 *
 * Ed25519 options (optional, any wallet mode):
 *   When ed25519.ed25519PublicKey is provided, it is attached to the registerUser call.
 *   ed25519PublicKeyName defaults to "QuoteTrade-BOT".
 *   The Ed25519 API key returned by the platform is printed alongside the SHA256 keys.
 *
 * Idempotent: after first successful resolution, the same credentials are returned.
 */
export async function resolveCredentials(options: ResolveOptions = {}): Promise<TradeCredentials> {
  if (resolved) return resolved;

  const walletKey = process.env.WALLET_PRIVATE_KEY?.trim();
  const apiKey = process.env.TRADE_API_KEY?.trim();
  const apiSecret = process.env.TRADE_API_SECRET?.trim();
  const createAccount = options.createAccount === true;
  const existingWallet = options.existingWallet === true;
  const ed25519 = options.ed25519;
  const generatedEd25519PrivateKeyPem = options.generatedEd25519PrivateKeyPem;
  const authBaseUrl = options.authBaseUrl;
  const signingAlgorithm: SigningAlgorithm = options.signingAlgorithm ?? resolveSigningAlgorithmFromEnv();
  const debug = process.env.CLI_DEBUG === "1";

  if (debug) {
    console.warn(
      "[auth] Resolving credentials: createAccount=" + createAccount +
      ", existingWallet=" + existingWallet +
      ", hasWALLET_PRIVATE_KEY=" + !!walletKey +
      ", hasAPIKeys=" + !!(apiKey && apiSecret) +
      ", hasEd25519=" + !!(ed25519?.ed25519PublicKey) +
      ", signingAlgorithm=" + signingAlgorithm +
      ", authBaseUrl=" + (authBaseUrl ?? process.env.API_BASE_URL ?? "(not set)")
    );
  }

  // ── Mode C: Generate new wallet ──────────────────────────────────────────
  if (createAccount && !walletKey) {
    const newWallet = generateWallet();
    if (debug) console.warn("[auth] Generated new wallet, address:", newWallet.address);
    try {
      return await loginViaWallet(
        newWallet.privateKey,
        true,
        { address: newWallet.address, privateKey: newWallet.privateKey },
        ed25519,
        generatedEd25519PrivateKeyPem,
        authBaseUrl,
        signingAlgorithm,
        debug
      );
    } catch (e: any) {
      throw new Error("New wallet registration/login failed: " + (e?.message ?? String(e)));
    }
  }

  // ── Mode B: Existing wallet from .env ────────────────────────────────────
  // Triggered by: --existing-wallet flag OR WALLET_PRIVATE_KEY set in .env
  if (existingWallet || walletKey) {
    const key = walletKey;
    if (!key) {
      throw new Error(
        "Existing wallet login requires WALLET_PRIVATE_KEY to be set in .env.\n" +
        "Add: WALLET_PRIVATE_KEY=0x<your-private-key>"
      );
    }
    const address = getAddressFromPrivateKey(key);
    printWalletAddress(address);
    try {
      return await loginViaWallet(key, false, null, ed25519, generatedEd25519PrivateKeyPem, authBaseUrl, signingAlgorithm, debug);
    } catch (e: any) {
      throw new Error("Wallet login failed: " + (e?.message ?? String(e)));
    }
  }

  // ── Mode A: API keys from .env ───────────────────────────────────────────
  if (apiKey && apiSecret) {
    resolved = { requestToken: apiKey, requestSecret: apiSecret };
    resolvedWalletPrivateKey = null;
    resolvedSigningAlgorithm = signingAlgorithm;

    if (signingAlgorithm === "ed25519") {
      // Ed25519 mode: TRADE_API_SECRET is the raw base64 body of the PKCS#8 private key
      // (no PEM headers). signRequestBodyEd25519() accepts raw base64 and reconstructs
      // the full PEM internally. Full PEM strings are also accepted for backward compat.
      setSigningContext({
        algorithm: "ed25519",
        apiKey,
        signingSecret: apiSecret,
      });
      console.log(`\nCredentials: using TRADE_API_KEY / TRADE_API_SECRET from .env (Ed25519 signing)`);
    } else {
      setSigningContext({ algorithm: "sha256", apiKey, signingSecret: apiSecret });
      console.log("\nCredentials: using TRADE_API_KEY / TRADE_API_SECRET from .env");
    }

    await fetchAndPrintBalances();
    return resolved;
  }

  // ── Nothing matched ──────────────────────────────────────────────────────
  throw new Error(
    "No credentials found. Choose one of:\n" +
    "  1. Set TRADE_API_KEY + TRADE_API_SECRET in .env  (registered via UI)\n" +
    "  2. Set WALLET_PRIVATE_KEY in .env and use --existing-wallet  (existing wallet)\n" +
    "  3. Use --create-wallet  (generate a new wallet on the fly)"
  );
}

/**
 * Return currently resolved credentials or null if not yet resolved.
 * Call resolveCredentials() before trading to ensure credentials are loaded.
 */
export function getResolvedCredentials(): TradeCredentials | null {
  return resolved;
}

/**
 * Return the signing algorithm that was active when credentials were last resolved.
 */
export function getResolvedSigningAlgorithm(): SigningAlgorithm {
  return resolvedSigningAlgorithm;
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

/**
 * Reset all resolved state (credentials + signing context).
 * Useful for re-authentication flows.
 */
export function resetCredentials(): void {
  resolved = null;
  resolvedWalletPrivateKey = null;
  resolvedSigningAlgorithm = "sha256";
  clearSigningContext();
}
