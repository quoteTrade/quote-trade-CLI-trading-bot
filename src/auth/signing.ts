import { createHmac, createPrivateKey, sign as nodeSign } from "node:crypto";
import type { SigningContext } from "./signing-context";
function toPemPrivateKey(secret: string): string { if (secret.includes("BEGIN PRIVATE KEY")) return secret.replace(/\\n/g, "\n"); return `-----BEGIN PRIVATE KEY-----\n${secret.match(/.{1,64}/g)?.join("\n") ?? secret}\n-----END PRIVATE KEY-----`; }
export function signRequest(ctx: SigningContext, payload: string): string { if (!ctx.signingSecret) return ""; if (ctx.signingAlgorithm === "ed25519") return nodeSign(null, Buffer.from(payload), createPrivateKey(toPemPrivateKey(ctx.signingSecret))).toString("base64"); return createHmac("sha256", ctx.signingSecret).update(payload).digest("hex"); }
