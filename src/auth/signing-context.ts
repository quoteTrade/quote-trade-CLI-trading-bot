import * as dotenv from "dotenv";
dotenv.config();

/**
 * Signing algorithm for API request headers.
 *
 *  sha256  — HMAC-SHA256(TRADE_API_SECRET, payload) → hex
 *            X-Mbx-Apikey = TRADE_API_KEY
 *
 *  ed25519 — Ed25519.sign(TRADE_API_SECRET as PKCS#8 PEM, payload) → base64
 *            X-Mbx-Apikey = TRADE_API_KEY
 *
 * In both modes the same TRADE_API_KEY / TRADE_API_SECRET env vars are used.
 * The algorithm flag (SIGNING_ALGORITHM) controls how the secret is interpreted:
 *  sha256  → secret is an HMAC key string
 *  ed25519 → secret is a PKCS#8 PEM private key
 */
export type SigningAlgorithm = "sha256" | "ed25519";

/**
 * Process-wide signing context.
 *
 * Populated once by resolveCredentials() (or setSigningContext()) before any
 * trading requests are made. All consumers (HttpService, ListenKeyFeedBus)
 * read from this context via getSigningContext().
 *
 * Fields:
 *  algorithm     — which algorithm to use
 *  apiKey        — sent as X-Mbx-Apikey header and WS requestToken (TRADE_API_KEY)
 *  signingSecret — sha256: HMAC secret (TRADE_API_SECRET)
 *                  ed25519: PKCS#8 PEM private key (TRADE_API_SECRET)
 */
export type SigningContext = {
  algorithm: SigningAlgorithm;
  /** The API key sent as X-Mbx-Apikey header and WS requestToken. */
  apiKey: string;
  /**
   * SHA256 mode: HMAC secret (TRADE_API_SECRET).
   * Ed25519 mode: PKCS#8 PEM private key (TRADE_API_SECRET).
   */
  signingSecret: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Singleton state
// ─────────────────────────────────────────────────────────────────────────────

let _context: SigningContext | null = null;

/**
 * Set the active signing context.
 * Called once by resolveCredentials() after credentials are resolved.
 * Subsequent calls overwrite the previous context (e.g. for testing).
 */
export function setSigningContext(ctx: SigningContext): void {
  _context = ctx;
}

/**
 * Get the active signing context.
 *
 * Falls back to reading from environment variables if setSigningContext()
 * has not been called yet. This allows HttpService to work even when
 * resolveCredentials() was not called (e.g. in tests or legacy usage).
 *
 * Throws if neither the context nor the required env vars are available.
 */
export function getSigningContext(): SigningContext {
  if (_context) return _context;

  // Lazy fallback: build from env vars
  const algorithm = resolveSigningAlgorithmFromEnv();
  const apiKey = process.env.TRADE_API_KEY?.trim() ?? "";
  const signingSecret = process.env.TRADE_API_SECRET?.trim() ?? "";

  _context = { algorithm, apiKey, signingSecret };
  return _context;
}

/**
 * Clear the signing context (useful for testing or re-authentication).
 */
export function clearSigningContext(): void {
  _context = null;
}

/**
 * Resolve the signing algorithm from environment variables.
 * Priority: SIGNING_ALGORITHM env var → default "sha256".
 */
export function resolveSigningAlgorithmFromEnv(): SigningAlgorithm {
  const raw = process.env.SIGNING_ALGORITHM?.trim().toLowerCase();
  if (raw === "ed25519") return "ed25519";
  return "sha256";
}
