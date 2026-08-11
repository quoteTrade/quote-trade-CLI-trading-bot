export type SigningAlgorithm = "sha256" | "ed25519";
export interface SigningContext {
  apiKey?: string;
  signingSecret?: string;
  signingAlgorithm: SigningAlgorithm;
}
let activeContext: SigningContext = {
  apiKey: process.env.TRADE_API_KEY,
  signingSecret: process.env.TRADE_API_SECRET,
  signingAlgorithm: process.env.SIGNING_ALGORITHM === "ed25519" ? "ed25519" : "sha256",
};
export function setSigningContext(ctx: Partial<SigningContext>): void {
  activeContext = { ...activeContext, ...ctx };
}
export function getSigningContext(): SigningContext {
  return activeContext;
}
