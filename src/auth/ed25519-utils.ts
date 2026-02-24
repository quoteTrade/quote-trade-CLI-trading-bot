import crypto from "crypto";
import fs from "fs";
import path from "path";

export type Ed25519KeyPair = {
  /** PEM-encoded public key (SPKI format, single-line for API transport) */
  publicKeyPem: string;
  /**
   * PEM-encoded private key (PKCS#8 format).
   * When stored in .env as TRADE_API_SECRET, only the base64 body is stored
   * (no -----BEGIN/END PRIVATE KEY----- headers). Use base64ToPkcs8Pem() to
   * reconstruct the full PEM before passing to crypto.sign().
   */
  privateKeyPem: string;
};

/**
 * Extract the base64 body from a PKCS#8 PEM private key.
 * Strips the -----BEGIN PRIVATE KEY----- / -----END PRIVATE KEY----- headers
 * and all whitespace, returning a single base64 string suitable for .env storage.
 *
 * Input: full multi-line or single-line PKCS#8 PEM
 * Output: raw base64 body (no headers, no newlines)
 */
export function pkcs8PemToBase64Body(pem: string): string {
  return pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
}

/**
 * Reconstruct a full PKCS#8 PEM private key from a raw base64 body.
 * Accepts:
 *  - A raw base64 string (no headers) — wraps with PKCS#8 headers
 *  - A full PEM string (already has headers) — returned as-is (normalised)
 *
 * This is the inverse of pkcs8PemToBase64Body().
 */
export function base64ToPkcs8Pem(input: string): string {
  const trimmed = input.trim();
  // Already a full PEM — normalise and return
  if (trimmed.startsWith("-----BEGIN PRIVATE KEY-----")) {
    return singleLinePemToMultiLine(trimmed);
  }
  // Raw base64 body — wrap with PKCS#8 headers
  const body = trimmed.replace(/\s+/g, "");
  const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Return true when the string looks like a raw base64 Ed25519 PKCS#8 private key body
 * (no PEM headers, only base64 characters).
 */
export function isRawBase64PrivateKey(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.startsWith("-----")) return false;
  return /^[A-Za-z0-9+/]+=*$/.test(trimmed) && trimmed.length >= 44;
}

/**
 * Generate a new Ed25519 key pair.
 * Returns PEM strings (multi-line, standard format).
 */
export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/**
 * Collapse a PEM string to a single line (spaces between header/body/footer).
 * The API example shows the public key as a single space-separated string.
 * e.g. "-----BEGIN PUBLIC KEY----- MCow... -----END PUBLIC KEY-----"
 */
export function pemToSingleLine(pem: string): string {
  return pem
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Restore a single-line PEM back to multi-line (for crypto operations).
 */
export function singleLinePemToMultiLine(singleLine: string): string {
  // Already multi-line
  if (singleLine.includes("\n")) return singleLine;
  // Split on PEM markers
  const match = singleLine.match(
    /^(-----BEGIN [^-]+-----)\s+([\s\S]+?)\s+(-----END [^-]+-----)$/
  );
  if (!match) return singleLine;
  const [, header, body, footer] = match;
  // Wrap body at 64 chars
  const wrapped = body.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? body;
  return `${header}\n${wrapped}\n${footer}\n`;
}

/**
 * Load an Ed25519 public key from:
 *  1. A file path (if the value looks like a path and the file exists)
 *  2. A PEM string (multi-line or single-line)
 *  3. A base64-encoded DER blob
 * Returns the single-line PEM string suitable for the API payload.
 */
export function resolveEd25519PublicKey(input: string): string {
  const trimmed = input.trim();

  // File path?
  if (!trimmed.startsWith("-----") && !isBase64(trimmed)) {
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved)) {
      const content = fs.readFileSync(resolved, "utf8").trim();
      return pemToSingleLine(content);
    }
  }

  // Already a PEM (multi or single line)?
  if (trimmed.startsWith("-----BEGIN")) {
    return pemToSingleLine(trimmed);
  }

  // Base64 DER → wrap as PEM
  if (isBase64(trimmed)) {
    const pem = `-----BEGIN PUBLIC KEY-----\n${trimmed.match(/.{1,64}/g)?.join("\n") ?? trimmed}\n-----END PUBLIC KEY-----\n`;
    return pemToSingleLine(pem);
  }

  throw new Error(
    "Cannot resolve ed25519 public key: expected a PEM string, a base64 DER blob, or a path to a PEM file."
  );
}

function isBase64(s: string): boolean {
  return /^[A-Za-z0-9+/]+=*$/.test(s) && s.length % 4 === 0 && s.length >= 44;
}

/**
 * Print generated Ed25519 key pair details to the console.
 * Private key is shown once — user must save it.
 */
export function printEd25519KeyPairDetails(pair: Ed25519KeyPair, keyName: string): void {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  NEW Ed25519 KEY PAIR GENERATED");
  console.log("  Key name: " + keyName);
  console.log("  Save the private key below; it cannot be recovered.");
  console.log("  You can pass the public key via --ed25519-public-key or");
  console.log("  set ED25519_PUBLIC_KEY in .env for future registrations.");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("\n  Public key (PEM):\n");
  console.log(pair.publicKeyPem);
  console.log("  Private key (PEM) — KEEP SECRET:\n");
  console.log(pair.privateKeyPem);
  console.log("───────────────────────────────────────────────────────────");
  console.log("  ⚠️  Copy both keys and store them securely.");
  console.log("═══════════════════════════════════════════════════════════\n");
}
