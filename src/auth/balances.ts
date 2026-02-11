import WebSocket from "ws";
import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { getDepositChainConfig } from "./deposit";

const LISTEN_KEY_WS_TIMEOUT_MS = 15000;
const ERC20_DECIMALS = 6;
const BALANCE_OF_ABI = ["function balanceOf(address owner) view returns (uint256)"];

/** Assets to show: wallet balances from a.B + ETH position from a.P */
const ASSETS_TO_SHOW = ["USD", "USDC", "USDT", "ETH"];

/**
 * Parse ACCOUNT_UPDATE payload from listenKey WS into a flat balance map.
 * a.B = wallet balances (a = asset, wb = wallet balance).
 * a.P = positions (s = symbol e.g. T_ETH/USD, pa = position amount).
 */
function parseAccountUpdate(data: {
  a?: { B?: Array<{ a?: string; wb?: string | number }>; P?: Array<{ s?: string; pa?: string | number }> };
}): Record<string, string> {
  const out: Record<string, string> = {};
  const a = data?.a;
  if (!a) return out;

  for (const r of a.B ?? []) {
    if (!r || typeof r !== "object") continue;
    const asset = (r.a ?? "").toUpperCase();
    const wb = r.wb;
    if (asset && (wb !== undefined && wb !== null)) {
      if (ASSETS_TO_SHOW.includes(asset)) out[asset] = String(wb);
    }
  }

  for (const r of a.P ?? []) {
    if (!r || typeof r !== "object") continue;
    const sym = (r.s ?? "").toUpperCase();
    const pa = r.pa;
    if (pa === undefined || pa === null) continue;
    if (sym.includes("ETH")) {
      out["ETH"] = typeof pa === "number" ? String(pa) : pa;
      break;
    }
  }

  return out;
}

/**
 * Fetch and print on-chain balances (USDC, USDT, ETH) for the given wallet address.
 * Uses DEPOSIT_NETWORK / DEPOSIT_RPC_URL / USDC_CONTRACT_ADDRESS / USDT_CONTRACT_ADDRESS from env.
 * No-op if walletAddress is null (e.g. API-key-only login).
 */
export async function fetchAndPrintBlockchainBalances(walletAddress: string | null): Promise<void> {
  if (!walletAddress) {
    console.log("\nBalances (blockchain): (wallet login required to show)");
    return;
  }
  const chainConfig = getDepositChainConfig();
  if (!chainConfig.usdcContractAddress && !chainConfig.usdtContractAddress) {
    console.log("\nBalances (blockchain): (set USDC_CONTRACT_ADDRESS / USDT_CONTRACT_ADDRESS in .env to show)");
    return;
  }
  try {
    const provider = new JsonRpcProvider(chainConfig.rpcUrl);
    const out: Record<string, string> = {};

    if (chainConfig.usdcContractAddress) {
      try {
        const contract = new Contract(chainConfig.usdcContractAddress, BALANCE_OF_ABI, provider);
        const raw = await contract.balanceOf(walletAddress);
        out["USDC"] = formatUnits(raw, ERC20_DECIMALS);
      } catch (e: any) {
        console.warn("USDC balance fetch failed:", e?.message ?? e);
        out["USDC"] = "—";
      }
    }
    if (chainConfig.usdtContractAddress) {
      try {
        const contract = new Contract(chainConfig.usdtContractAddress, BALANCE_OF_ABI, provider);
        const raw = await contract.balanceOf(walletAddress);
        out["USDT"] = formatUnits(raw, ERC20_DECIMALS);
      } catch (e: any) {
        console.warn("USDT balance fetch failed:", e?.message ?? e);
        out["USDT"] = "—";
      }
    }

    try {
      const ethBal = await provider.getBalance(walletAddress);
      out[chainConfig.nativeSymbol] = formatUnits(ethBal, 18);
    } catch {
      out[chainConfig.nativeSymbol] = "—";
    }

    if (Object.keys(out).length === 0) return;
    console.log("\nBalances (blockchain — " + chainConfig.name + "):");
    console.table(out);
  } catch (e: any) {
    console.warn("Could not fetch blockchain balances:", e?.message ?? e);
  }
}

/**
 * Fetch trade balances from listenKey WebSocket (ACCOUNT_UPDATE).
 * Uses LISTEN_KEY_WS_URL and TRADE_API_KEY (requestToken). Shows USD, USDC, USDT, ETH.
 */
export async function fetchAndPrintBalances(): Promise<void> {
  const url = process.env.LISTEN_KEY_WS_URL?.trim();
  const requestToken = process.env.TRADE_API_KEY?.trim();
  if (!url || !requestToken) {
    console.warn("\nBalances: LISTEN_KEY_WS_URL and credentials required (login first).");
    return;
  }

  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let handled = false;
    const timeout = setTimeout(() => {
      if (handled) return;
      handled = true;
      if (ws.readyState === WebSocket.OPEN) ws.close();
      console.warn("\nBalances (USDC / USDT / ETH): timeout waiting for ACCOUNT_UPDATE.");
      resolve();
    }, LISTEN_KEY_WS_TIMEOUT_MS);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          account: "",
          unsubscribe: 0,
          requestToken,
          channel: "LIQUIDITY",
        })
      );
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      if (handled) return;
      try {
        const data = JSON.parse(raw.toString()) as any;
        if (data?.e !== "ACCOUNT_UPDATE" || !data?.a) return;
        handled = true;
        clearTimeout(timeout);
        ws.close();
        const balances = parseAccountUpdate(data);
        if (Object.keys(balances).length === 0) {
          console.log("\nBalances (USD / USDC / USDT / ETH): (no data in ACCOUNT_UPDATE)");
        } else {
          console.log("\nBalances (trade — from listenKey):");
          console.table(balances);
        }
        resolve();
      } catch {
        // ignore non-JSON / other events
      }
    });

    ws.on("error", () => {
      clearTimeout(timeout);
      console.warn("Could not fetch balances: WebSocket error.");
      resolve();
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
