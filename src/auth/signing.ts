import crypto from "crypto";
import type { SigningContext } from "./signing-context";
import { base64ToPkcs8Pem } from "./ed25519-utils";

/**
 * Sign a request payload using HMAC-SHA256.
 *
 * Payload canonicalization: JSON.stringify(body) for POST, JSON.stringify(path) for GET.
 * Returns a lowercase hex string.
 *
 * Used by HttpService when algorithm = "sha256".
 */
export function signRequestBody(requestSecret: string, body: object): string {
  const canonical = JSON.stringify(body);
  return crypto
    .createHmac("sha256", requestSecret)
    .update(canonical)
    .digest("hex");
}

/**
 * Sign a request payload using Ed25519.
 *
 * Accepts the private key in either of two formats:
 *  - Raw base64 body (no PEM headers) — the preferred .env storage format
 *  - Full PKCS#8 PEM string (-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----)
 *
 * The server verifies using the registered Ed25519 public key (SPKI PEM).
 * Server-side: Base64.getDecoder().decode(signatureBase64) → Signature.verify(bytes).
 * Returns a standard base64-encoded string (not URL-safe).
 *
 * Used by HttpService when algorithm = "ed25519".
 */
export function signRequestBodyEd25519(privateKeyInput: string, payload: string): string {
  // Reconstruct full PKCS#8 PEM from raw base64 body or existing PEM
  const privateKeyPem = base64ToPkcs8Pem(privateKeyInput);
  const payloadBytes = Buffer.from(payload, "utf-8");
  const signatureBytes = crypto.sign(null, payloadBytes, privateKeyPem);
  return signatureBytes.toString("base64");
}

/**
 * Unified signing dispatcher.
 *
 * Dispatches to the correct signing function based on the active SigningContext.
 *
 *  sha256  → HMAC-SHA256(signingSecret, payload) → hex
 *  ed25519 → Ed25519.sign(signingSecret as PKCS#8 PEM, payload) → base64
 *
 * In both modes:
 *  - signingSecret = TRADE_API_SECRET
 *  - apiKey        = TRADE_API_KEY (sent as X-Mbx-Apikey)
 *
 * @param ctx     The active signing context (from getSigningContext()).
 * @param payload The string to sign (JSON.stringify(body) for POST, JSON.stringify(path) for GET).
 */
export function signRequest(ctx: SigningContext, payload: string): string {
  if (ctx.algorithm === "ed25519") {
    return signRequestBodyEd25519(ctx.signingSecret, payload);
  }
  return crypto
    .createHmac("sha256", ctx.signingSecret)
    .update(payload)
    .digest("hex");
}
