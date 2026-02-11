import crypto from "crypto";

/**
 * Sign a request body for API authentication (Binance-style).
 * Same canonicalization as Orders: HMAC-SHA256(requestSecret, JSON.stringify(body)) → hex.
 * Used by both trading POST requests and auth getUserProfile.
 */
export function signRequestBody(requestSecret: string, body: object): string {
  const canonical = JSON.stringify(body);
  return crypto
    .createHmac("sha256", requestSecret)
    .update(canonical)
    .digest("hex");
}
