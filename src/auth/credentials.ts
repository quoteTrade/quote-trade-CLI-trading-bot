import { setSigningContext } from "./signing-context";
export interface ResolveCredentialsOptions { createAccount?: boolean; existingWallet?: boolean; authBaseUrl?: string; signingAlgorithm?: "sha256" | "ed25519"; }
export async function resolveCredentials(options: ResolveCredentialsOptions = {}): Promise<void> { setSigningContext({ apiKey: process.env.TRADE_API_KEY, signingSecret: process.env.TRADE_API_SECRET, signingAlgorithm: options.signingAlgorithm ?? (process.env.SIGNING_ALGORITHM === "ed25519" ? "ed25519" : "sha256") }); }
export function getResolvedWalletPrivateKey(): string | undefined { return process.env.WALLET_PRIVATE_KEY; }
