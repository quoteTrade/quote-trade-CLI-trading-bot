import axios, { AxiosInstance } from "axios";
import { Wallet } from "ethers";
import { signRequestBody } from "./signing";

const DEFAULT_AUTH_BASE = "https://bitpaired.com:2053/liquidityApi";

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

/**
 * Wallet login flow (same for new account and existing private key):
 * 1) Resolve wallet (generate new OR derive from WALLET_PRIVATE_KEY)
 * 2) getChallenge(login) with wallet address (use same HTTP client for cookies)
 * 3) Sign challenge with wallet private key (EIP-191 personal_sign)
 * 4) logon(challenge, signature)
 * 5) getUserProfile() → requestToken, requestSecret
 * 6) Use those keys for trading
 */
export type WalletCredentials = { requestToken: string; requestSecret: string; profile?: Record<string, unknown> };

export type LoginWithWalletOptions = {
  /** Pre-fetched challenge (e.g. from getChallengeForAddress). Use same client for logon. */
  challenge?: string;
  /** Axios client that was used to fetch the challenge (keeps session/cookies). */
  client?: AxiosInstance;
  /** When true, backend reported this address as new; we call registerUser before logon. */
  isNewUser?: boolean;
};

/**
 * Step 2: Fetch challenge for a wallet address.
 * Backends often expect lowercase address for storage/compare; we normalize so signature recovery matches.
 */
export async function getChallengeForAddress(
  login: string,
  baseUrl: string = process.env.WALLET_AUTH_BASE_URL || DEFAULT_AUTH_BASE
): Promise<{ challenge: string; client: AxiosInstance; isNewUser?: boolean }> {
  const client = axios.create({
    baseURL: baseUrl.replace(/\/$/, ""),
    withCredentials: true,
    headers: { "Content-Type": "application/json" },
  });
  const loginNormalized = login.startsWith("0x") ? login.toLowerCase() : login;
  if (isDebug()) console.warn("[auth] Step 1: getChallenge → POST", baseUrl + "/getChallenge", "body: { login:", loginNormalized, " }");
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

/**
 * Authenticate via Bitpaired wallet flow:
 * 1. getChallenge(login) — or use pre-fetched challenge+client
 * 2. Sign challenge with private key (EIP-191 personal_sign)
 * 3. If isNewUser: registerUser(challenge, signature, channel LIQUIDITY) then logon; else logon only
 * 4. logon(challenge, signature)
 * 5. getUserProfile() → requestToken, requestSecret
 */
export async function loginWithWallet(
  privateKey: string,
  baseUrl: string = process.env.WALLET_AUTH_BASE_URL || DEFAULT_AUTH_BASE,
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
  if (isNewUser) {
    if (isDebug()) console.warn("[auth] Step 2b: registerUser (new user) → POST /registerUser with challenge + signature + channel");
    try {
      const registerRes = await client.post<Record<string, unknown>>("/registerUser", {
        challenge,
        signature,
        channel: "LIQUIDITY",
      });
      const err = (registerRes.data as any)?.error;
      if (err && typeof err === "string" && !err.toLowerCase().includes("already") && !err.toLowerCase().includes("exist")) {
        if (isDebug()) console.warn("[auth] Step 2b registerUser response error:", err);
      }
    } catch (e: any) {
      const msg = e?.response?.data?.error ?? e?.message ?? String(e);
      if (isDebug()) console.warn("[auth] Step 2b registerUser failed (will try logon):", msg);
    }
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
  return { requestToken, requestSecret, profile: { ...data, requestToken, requestSecret } };
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
