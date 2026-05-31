export function maskSecret(value: string): string { return value ? `${value.slice(0,4)}...${value.slice(-4)}` : ""; }
