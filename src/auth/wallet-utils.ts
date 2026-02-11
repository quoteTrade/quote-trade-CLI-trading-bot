import { Wallet } from "ethers";

export type WalletDetails = { address: string; privateKey: string };

/** Generate a new random Ethereum wallet. */
export function generateWallet(): WalletDetails {
  const wallet = Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
}

/** Derive address from an existing private key. */
export function getAddressFromPrivateKey(privateKey: string): string {
  const key = privateKey.startsWith("0x") ? privateKey : "0x" + privateKey;
  return new Wallet(key).address;
}

/**
 * Print wallet details to the console.
 * For new accounts (isNew: true), show address + full private key with a strong warning.
 * For existing key from env (isNew: false), show only the derived address (private key not printed).
 */
export function printWalletDetails(details: WalletDetails, options: { isNew?: boolean } = {}): void {
  const { address, privateKey } = details;
  const isNew = options.isNew ?? false;

  console.log("\n═══════════════════════════════════════════════════════════");
  if (isNew) {
    console.log("  NEW WALLET CREATED");
    console.log("  Save the private key below; it cannot be recovered.");
    console.log("  Add it to .env as WALLET_PRIVATE_KEY=0x... for future runs.");
  } else {
    console.log("  WALLET (derived from WALLET_PRIVATE_KEY in .env)");
  }
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Address:     ", address);
  if (isNew) {
    console.log("  Private key: ", privateKey);
    console.log("───────────────────────────────────────────────────────────");
    console.log("  ⚠️  Copy the private key and store it securely before continuing.");
  }
  console.log("═══════════════════════════════════════════════════════════\n");
}

/** Print only the wallet address (e.g. when using key from env). */
export function printWalletAddress(address: string): void {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  WALLET (derived from WALLET_PRIVATE_KEY in .env)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Address:     ", address);
  console.log("═══════════════════════════════════════════════════════════\n");
}
