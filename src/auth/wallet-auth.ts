import axios, { AxiosInstance } from "axios";
import { Wallet } from "ethers";
import { signRequestBody } from "./signing";

/**
 * Resolve the wallet auth base URL.
 * Priority:
 *  1. Explicit argument (from --auth-base-url CLI flag)
 *  2. API_BASE_URL env var (wallet auth endpoints live at the same base as the trading API)
 *
 * Throws a clear error only when neither is set.
 */
export function resolveAuthBaseUrl(explicit?: string): string {
  const url = explicit?.trim() || process.env.API_BASE_URL?.trim();
  if (!url) {
    throw new Error(
      "API base URL is not configured.\n" +
      "Set API_BASE_URL in .env (e.g. https://app.quote.trade/api)\n" +
      "or pass --auth-base-url on the CLI."
    );
  }
  return url.replace(/\/$/, "");
}

function isDebug(): boolean {
  return process.env.CLI_DEBUG === "1" || process.env.WALLET_AUTH_DEBUG === "1";
}

/** Redact object for debug log: mask requestToken, requestSecret, signature, private keys. */
function redactForLog(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) { out[k] = v; continue; }
    const key = k.toLowerCase();
    if (key.includes("secret") || key.includes("token") || key.includes("signature") || key.includes("private")) {
      out[k] = typeof v === "string" && v.length > 8 ? v.slice(0, 4) + "…" + v.slice(-4) : "***";
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Ed25519 API key returned by the registerUser endpoint when an Ed25519 public key is attached.
 * - ed25519ApiKey: the API key issued by the platform for Ed25519-signed requests
 * - ed25519KeyName: the name that was registered
 *
 * The corresponding SECRET for this key is the Ed25519 PRIVATE KEY held by the user.
 * The platform never sees or stores the private key.
 */
export type Ed25519RegisterResult = {
  /** API key issued by the platform for Ed25519-signed requests. */
  ed25519ApiKey: string;
  /** The key name that was registered (echoed back from the response). */
  ed25519KeyName: string;
};

export type WalletCredentials = {
  /** SHA256 (HMAC) request token — use for standard trading API calls. */
  requestToken: string;
  /** SHA256 (HMAC) request secret — sign request bodies with HMAC-SHA256(secret, body). */
  requestSecret: string;
  /** Public user profile fields. */
  profile?: Record<string, unknown>;
  /**
   * Ed25519 API key returned by registerUser when an Ed25519 public key was attached.
   * Present only when registration included an ed25519PublicKey.
   * The SECRET for this key is the Ed25519 private key held by the user.
   */
  ed25519Result?: Ed25519RegisterResult;
};

/**
 * Optional Ed25519 public key to attach during registration.
 * When provided, the registerUser payload includes ed25519PublicKey and ed25519PublicKeyName.
 * ed25519PublicKeyName defaults to "QuoteTrade-BOT" when omitted.
 */
export type Ed25519Options = {
  /** Single-line PEM public key string, e.g. "-----BEGIN PUBLIC KEY----- MCow... -----END PUBLIC KEY-----" */
  ed25519PublicKey: string;
  /** Human-readable name for the key. Defaults to "QuoteTrade-BOT". */
  ed25519PublicKeyName?: string;
};

export type LoginWithWalletOptions = {
  /** Pre-fetched challenge (e.g. from getChallengeForAddress). Use same client for logon. */
  challenge?: string;
  /** Axios client that was used to fetch the challenge (keeps session/cookies). */
  client?: AxiosInstance;
  /** When true, backend reported this address as new; we call registerUser before logon. */
  isNewUser?: boolean;
  /** Optional Ed25519 key to attach during registerUser. */
  ed25519?: Ed25519Options;
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: getChallenge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch challenge for a wallet address.
 * Backends often expect lowercase address for storage/compare; we normalize so signature recovery matches.
 */
export async function getChallengeForAddress(
  login: string,
  baseUrl?: string
): Promise<{ challenge: string; client: AxiosInstance; isNewUser?: boolean }> {
  const resolvedBase = resolveAuthBaseUrl(baseUrl);
  const client = axios.create({
    baseURL: resolvedBase,
    withCredentials: true,
    headers: { "Content-Type": "application/json" },
  });
  const loginNormalized = login.startsWith("0x") ? login.toLowerCase() : login;
  if (isDebug()) console.warn("[auth] Step 1: getChallenge → POST", resolvedBase + "/getChallenge", "body: { login:", loginNormalized, " }");
  const res = await client.post<{ challenge: string; isNewUser?: boolean }>("/getChallenge", {
    login: loginNormalized,
  });
  const challenge = res.data?.challenge;
  if (!challenge || typeof challenge !== "string") {
    if (isDebug()) console.warn("[auth] Step 1 FAILED: getChallenge response:", JSON.stringify(res.data));
    throw new Error("getChallenge did not return a challenge");
  }
  if (isDebug()) {
    const snippet = challenge.length <= 80 ? challenge : challenge.slice(0, 50) + "…" + challenge.slice(-30);
    const looksLikeHex = /^0x[0-9a-fA-F]+$/.test(challenge);
    console.warn("[auth] Step 1 OK: challenge length=" + challenge.length + ", isNewUser=" + res.data?.isNewUser + ", looksLikeHex=" + looksLikeHex);
    console.warn("[auth] Challenge snippet:", snippet);
  }
  return { challenge, client, isNewUser: res.data?.isNewUser };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2b: registerUser (new user only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register a new user with the backend.
 *
 * Payload always includes: referredByCode, challenge, signature, channel.
 * When ed25519 options are provided, also includes ed25519PublicKey and ed25519PublicKeyName.
 *
 * Example full payload:
 * {
 *   "referredByCode": null,
 *   "challenge": "Sign auth token: ...",
 *   "signature": "0x...",
 *   "channel": "LIQUIDITY",
 *   "ed25519PublicKey": "-----BEGIN PUBLIC KEY----- MCow... -----END PUBLIC KEY-----",
 *   "ed25519PublicKeyName": "QuoteTrade-BOT"
 * }
 *
 * Returns the Ed25519 API key from the response when an Ed25519 key was attached,
 * or undefined when no Ed25519 key was included.
 *
 * The Ed25519 API key is the platform-issued identifier for Ed25519-signed requests.
 * The SECRET for that key is the Ed25519 PRIVATE KEY held by the user — the platform
 * never sees or stores it.
 */
export async function registerUser(
  client: AxiosInstance,
  challenge: string,
  signature: string,
  ed25519?: Ed25519Options
): Promise<Ed25519RegisterResult | undefined> {
  const payload: Record<string, unknown> = {
    referredByCode: null,
    challenge,
    signature,
    channel: "LIQUIDITY",
  };

  const hasEd25519 = !!(ed25519?.ed25519PublicKey);
  const keyName = ed25519?.ed25519PublicKeyName ?? "QuoteTrade-BOT";

  if (hasEd25519) {
    payload.ed25519PublicKey = ed25519!.ed25519PublicKey;
    payload.ed25519PublicKeyName = keyName;
  }

  if (isDebug()) {
    const safePayload = { ...payload, signature: "***" };
    console.warn("[auth] Step 2b: registerUser → POST /registerUser body:", JSON.stringify(safePayload));
  }

  try {
    const registerRes = await client.post<Record<string, unknown>>("/registerUser", payload);
    const data = registerRes.data ?? {};

    if (isDebug()) {
      console.warn("[auth] Step 2b registerUser response keys:", Object.keys(data).join(", "));
    }

    const err = (data as any)?.error;
    if (err && typeof err === "string" && !err.toLowerCase().includes("already") && !err.toLowerCase().includes("exist")) {
      if (isDebug()) console.warn("[auth] Step 2b registerUser response error:", err);
    }

    // Extract the Ed25519 API key from the response.
    // The platform may return it under various field names; we check common candidates.
    if (hasEd25519) {
      const ed25519ApiKey =
        (data as any).ed25519ApiKey ??
        (data as any).ed25519Key ??
        (data as any).apiKey ??
        (data as any).requestToken ??
        (data as any).key ??
        null;

      if (ed25519ApiKey && typeof ed25519ApiKey === "string") {
        if (isDebug()) console.warn("[auth] Step 2b: Ed25519 API key received from registerUser");
        return { ed25519ApiKey, ed25519KeyName: keyName };
      }

      // If the platform embeds it in a nested object (e.g. data.data or data.result)
      const nested = (data as any).data ?? (data as any).result;
      if (nested && typeof nested === "object") {
        const nestedKey =
          nested.ed25519ApiKey ?? nested.ed25519Key ?? nested.apiKey ?? nested.requestToken ?? nested.key;
        if (nestedKey && typeof nestedKey === "string") {
          if (isDebug()) console.warn("[auth] Step 2b: Ed25519 API key received from registerUser (nested)");
          return { ed25519ApiKey: nestedKey, ed25519KeyName: keyName };
        }
      }

      // Key was attached but not returned in response — inform caller
      if (isDebug()) console.warn("[auth] Step 2b: Ed25519 key was attached but no ed25519ApiKey found in response. Full response:", JSON.stringify(data));
      // Return a sentinel so the caller knows registration included an Ed25519 key
      // but the API key was not returned (may be retrieved later via profile/key-list endpoint)
      return { ed25519ApiKey: "", ed25519KeyName: keyName };
    }

    return undefined;
  } catch (e: any) {
    const msg = e?.response?.data?.error ?? e?.message ?? String(e);
    if (isDebug()) console.warn("[auth] Step 2b registerUser failed (will try logon):", msg);
    // Non-fatal: proceed to logon even if register fails (may already be registered)
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main: loginWithWallet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authenticate via wallet flow:
 * 1. getChallenge(login) — or use pre-fetched challenge+client
 * 2. Sign challenge with private key (EIP-191 personal_sign)
 * 3. If isNewUser: registerUser(challenge, signature, channel, [ed25519]) then logon; else logon only
 * 4. logon(challenge, signature)
 * 5. getUserProfile() → requestToken, requestSecret
 *
 * When an Ed25519 key is attached during registration, the resulting Ed25519 API key
 * is returned in WalletCredentials.ed25519Result.
 */
export async function loginWithWallet(
  privateKey: string,
  baseUrl?: string,
  options: LoginWithWalletOptions = {}
): Promise<WalletCredentials> {
  const wallet = new Wallet(privateKey.startsWith("0x") ? privateKey : "0x" + privateKey);
  const login = wallet.address;

  let client: AxiosInstance;
  let challenge: string;
  let isNewUser = false;

  if (options.challenge && options.client) {
    challenge = options.challenge;
    client = options.client;
    isNewUser = options.isNewUser ?? false;
  } else {
    const fetched = await getChallengeForAddress(login, baseUrl);
    challenge = fetched.challenge;
    client = fetched.client;
    isNewUser = fetched.isNewUser ?? false;
  }

  // Sign challenge (EIP-191 personal_sign — same as MetaMask "Sign message")
  if (isDebug()) console.warn("[auth] Step 2: Signing challenge (length " + challenge.length + ") with wallet");
  const signature = await wallet.signMessage(challenge);
  if (isDebug()) console.warn("[auth] Step 2 OK: signature length=" + signature.length + ", prefix=" + signature.slice(0, 10) + "…");

  // When backend says new user, register first (same as UI "connect wallet" flow) then logon
  let ed25519Result: Ed25519RegisterResult | undefined;
  if (isNewUser) {
    ed25519Result = await registerUser(client, challenge, signature, options.ed25519);
  }

  // Logon: exactly { challenge, signature } (signature with 0x) to match typical backend
  if (isDebug()) console.warn("[auth] Step 3: logon → POST /logon with challenge + signature");
  const logonRes = await client.post<Record<string, unknown>>("/logon", { challenge, signature });
  const logonData = logonRes.data ?? {};

  if ((logonData as any).error) {
    if (isDebug()) console.warn("[auth] Step 3 FAILED: logon response:", JSON.stringify(redactForLog(logonData as Record<string, unknown>)));
    throw new Error("Logon rejected: " + String((logonData as any).error));
  }
  if (isDebug()) {
    const hasId = (logonData as any).id != null;
    const hasToken = !!pickTokens(logonData).requestToken;
    const hasSecret = !!pickTokens(logonData).requestSecret;
    console.warn("[auth] Step 3 OK: id=" + (logonData as any).id + ", hasRequestToken=" + hasToken + ", hasRequestSecret=" + hasSecret);
  }

  // 4. Get user profile: POST with body { userId }, same signature as Orders (HMAC-SHA256(secret, JSON.stringify(body)))
  const userId = (logonData as any).id;
  if (userId == null) {
    throw new Error("Logon response missing id (userId) for getUserProfile");
  }
  const fromLogon = pickTokens(logonData);
  const requestTokenForProfile = fromLogon.requestToken;
  const requestSecretForProfile = fromLogon.requestSecret;
  if (!requestTokenForProfile || !requestSecretForProfile) {
    throw new Error("Logon response missing requestToken/requestSecret (required for getUserProfile)");
  }
  const profileBody = { userId };
  const signatureHeader = signRequestBody(requestSecretForProfile, profileBody);
  if (isDebug()) console.warn("[auth] Step 4: getUserProfile → POST /getUserProfile body:", profileBody);
  const profileRes = await client.post<Record<string, unknown>>("/getUserProfile", profileBody, {
    headers: {
      "x-mbx-apikey": requestTokenForProfile,
      signature: signatureHeader,
    },
  });
  const profileData = profileRes.data ?? {};
  if (isDebug()) console.warn("[auth] Step 4 OK: profile keys=" + Object.keys(profileData).join(", "));

  // Tokens: prefer profile (source of truth), fallback to logon
  const fromProfile = pickTokens(profileData);
  const requestToken = fromProfile.requestToken ?? fromLogon.requestToken;
  const requestSecret = fromProfile.requestSecret ?? fromLogon.requestSecret;

  if (!requestToken || !requestSecret) {
    const got = JSON.stringify({ logon: logonData, getUserProfile: profileData }, null, 2);
    throw new Error(
      "getUserProfile/logon did not return requestToken and requestSecret. Got: " + got.slice(0, 500)
    );
  }

  const data = Object.keys(profileData).length > 0 ? profileData : logonData;
  return {
    requestToken,
    requestSecret,
    profile: { ...data, requestToken, requestSecret },
    ed25519Result,
  };
}

function pickTokens(obj: Record<string, unknown>): { requestToken?: string; requestSecret?: string } {
  const token = obj.requestToken ?? (obj as any).request_token;
  const secret = obj.requestSecret ?? (obj as any).request_secret;
  const fromNested = obj.data && typeof obj.data === "object" ? pickTokens(obj.data as Record<string, unknown>) : {};
  return {
    requestToken: (typeof token === "string" ? token : undefined) ?? fromNested.requestToken,
    requestSecret: (typeof secret === "string" ? secret : undefined) ?? fromNested.requestSecret,
  };
}
