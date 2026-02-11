import { Contract, Wallet, JsonRpcProvider, parseUnits } from "ethers";
import { HttpSvc } from "../services/http.service";

const DEPOSIT_TOKENS = ["USDC", "USDT"] as const;
const ERC20_DECIMALS = 6;

export type DepositCurrency = (typeof DEPOSIT_TOKENS)[number];

export type ChainConfig = {
  name: string;
  nativeSymbol: string;
  rpcUrl: string;
  usdcContractAddress: string | null;
  usdtContractAddress: string | null;
};

/** Build chain config from env (DEPOSIT_NETWORK, RPC, contract addresses). */
export function getDepositChainConfig(): ChainConfig {
  const network = (process.env.DEPOSIT_NETWORK ?? "mainnet").toLowerCase();
  const rpcUrl =
    process.env.DEPOSIT_RPC_URL ??
    (network === "mainnet"
      ? "https://eth.merkle.io"
      : network === "sepolia"
        ? "https://sepolia.drpc.org"
        : network === "polygon"
          ? "https://polygon-rpc.com"
          : "https://eth.merkle.io");
  const isPolygonLike = network === "polygon" || network === "amoy";
  return {
    name: network === "mainnet" ? "Ethereum" : network === "sepolia" ? "Sepolia" : network === "polygon" ? "Polygon" : network,
    nativeSymbol: isPolygonLike ? "POL" : "ETH",
    rpcUrl,
    usdcContractAddress: process.env.USDC_CONTRACT_ADDRESS ?? process.env.USDC_CONTRACT_ADDRESS_MAINNET ?? null,
    usdtContractAddress: process.env.USDT_CONTRACT_ADDRESS ?? process.env.USDT_CONTRACT_ADDRESS_MAINNET ?? null,
  };
}

/** Fetch platform deposit address (authenticated). */
export async function getDepositAddress(): Promise<{ address: string }> {
  const data = (await HttpSvc.get("/getDepositAddress")) as any;
  const address = data?.address ?? data?.walletAddress;
  if (!address || typeof address !== "string") {
    throw new Error("getDepositAddress did not return an address");
  }
  return { address };
}

/** Send ERC20 (USDC or USDT) from wallet to deposit address. Same flow as telegram bot. */
export async function transferERC20ToDeposit(
  chainConfig: ChainConfig,
  privateKey: string,
  token: DepositCurrency,
  amount: number,
  toAddress: string
): Promise<string> {
  const pk = privateKey.startsWith("0x") ? privateKey : "0x" + privateKey;
  const contractAddress =
    token === "USDC" ? chainConfig.usdcContractAddress : chainConfig.usdtContractAddress;
  if (!contractAddress) {
    throw new Error(
      `No contract address configured for ${token}. Set USDC_CONTRACT_ADDRESS / USDT_CONTRACT_ADDRESS or DEPOSIT_NETWORK in .env`
    );
  }

  const provider = new JsonRpcProvider(chainConfig.rpcUrl);
  const wallet = new Wallet(pk, provider);
  const abi = ["function transfer(address to, uint256 amount) returns (bool)"];
  const contract = new Contract(contractAddress, abi, wallet);
  const parsedAmount = parseUnits(amount.toString(), ERC20_DECIMALS);

  const tx = await contract.transfer(toAddress, parsedAmount);
  await tx.wait();
  return tx.hash;
}

export function isDepositToken(s: string): s is DepositCurrency {
  return DEPOSIT_TOKENS.includes(s as DepositCurrency);
}

export { DEPOSIT_TOKENS };
