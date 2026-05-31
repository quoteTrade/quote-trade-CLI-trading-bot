export const DEPOSIT_TOKENS = ["USDC", "USDT"]; export function isDepositToken(token:string): boolean { return DEPOSIT_TOKENS.includes(String(token).toUpperCase()); }
