#!/usr/bin/env node
import { Command } from "commander";
import * as dotenv from "dotenv";
dotenv.config();

import { LiquidityFeed } from "./feeds/liquidity-feed";
import { RSIRunner } from "./rsi-runner";
import { BLUE, RED, RESET } from "./ANSI";
import { HelpText } from "./constant/cli-text";
import { getInstrumentMeta, tfToMs } from "./utils";
import { TradeExecutor } from "./execution/executor";
import { ListenKeyFeedBus } from "./feeds/listenkey-feed-bus";
import { logOrderUpdate, logPositionChange, logPositionSnapshot } from "./log/trade-logger";
import { resolveCredentials, getResolvedWalletPrivateKey } from "./auth/credentials";
import type { SigningAlgorithm } from "./auth/signing-context";
import {
  getDepositAddress,
  getDepositChainConfig,
  transferERC20ToDeposit,
  isDepositToken,
  DEPOSIT_TOKENS,
} from "./auth/deposit";
import {
  generateEd25519KeyPair,
  resolveEd25519PublicKey,
  printEd25519KeyPairDetails,
  pemToSingleLine,
} from "./auth/ed25519-utils";
import type { Ed25519Options } from "./auth/wallet-auth";

type RunnerKey = string;
const runners = new Map<RunnerKey, RSIRunner>();

const program = new Command();

program
  .name("Quote.Trade-cli-bot")
  .description("Headless CLI RSI trading bot");

// 🔒 Disable Commander's built-in help + version
program.helpOption(false);
program.addHelpCommand(false);
program.version("", "", "");

// ─────────────────────────────────────────────────────────────────────────────
// Global options
// ─────────────────────────────────────────────────────────────────────────────
program.option("--debug", "Enable debug logging (auth steps, no secrets)");
program.option(
  "--auth-base-url <url>",
  "Wallet auth API base URL (overrides API_BASE_URL in .env, e.g. https://app.quote.trade/api)"
);
program.option(
  "--signing-algorithm <algorithm>",
  "Signing algorithm for API requests: sha256 (default) or ed25519 (overrides SIGNING_ALGORITHM in .env)"
);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type Ed25519Resolution = {
  ed25519: Ed25519Options;
  /** PEM of the generated private key — only set when --generate-ed25519-key was used. */
  generatedPrivateKeyPem?: string;
} | undefined;

/**
 * Resolve Ed25519 options from CLI flags.
 *
 * Priority:
 *  1. --generate-ed25519-key  → generate a new key pair, print it, use the public key
 *  2. --ed25519-public-key    → load/parse the provided key
 *  3. ED25519_PUBLIC_KEY env  → fallback from .env
 *
 * Returns undefined when no Ed25519 options are provided.
 * When --generate-ed25519-key is used, the generated private key PEM is returned
 * so it can be included in the final printed summary.
 */
function resolveEd25519Options(opts: {
  ed25519PublicKey?: string;
  ed25519PublicKeyName?: string;
  generateEd25519Key?: boolean;
}): Ed25519Resolution {
  const keyName = opts.ed25519PublicKeyName ?? "QuoteTrade-BOT";

  if (opts.generateEd25519Key) {
    const pair = generateEd25519KeyPair();
    printEd25519KeyPairDetails(pair, keyName);
    return {
      ed25519: {
        ed25519PublicKey: pemToSingleLine(pair.publicKeyPem),
        ed25519PublicKeyName: keyName,
      },
      generatedPrivateKeyPem: pair.privateKeyPem,
    };
  }

  if (opts.ed25519PublicKey) {
    try {
      const resolved = resolveEd25519PublicKey(opts.ed25519PublicKey);
      return {
        ed25519: { ed25519PublicKey: resolved, ed25519PublicKeyName: keyName },
      };
    } catch (e: any) {
      console.error("❌ Could not resolve --ed25519-public-key:", e?.message ?? e);
      process.exit(1);
    }
  }

  // Check .env fallback
  const envKey = process.env.ED25519_PUBLIC_KEY?.trim();
  if (envKey) {
    try {
      const resolved = resolveEd25519PublicKey(envKey);
      return {
        ed25519: { ed25519PublicKey: resolved, ed25519PublicKeyName: keyName },
      };
    } catch {
      // Silently ignore malformed env key
    }
  }

  return undefined;
}

/**
 * Resolve the signing algorithm from the --signing-algorithm CLI flag.
 * Falls back to SIGNING_ALGORITHM env var (handled by resolveSigningAlgorithmFromEnv inside credentials.ts).
 * Returns undefined when not specified — credentials.ts will read SIGNING_ALGORITHM env var.
 */
function resolveSigningAlgorithmOpt(raw: string | undefined): SigningAlgorithm | undefined {
  if (!raw) return undefined;
  const lower = raw.trim().toLowerCase();
  if (lower === "ed25519") return "ed25519";
  if (lower === "sha256") return "sha256";
  console.error(`❌ Invalid --signing-algorithm "${raw}". Must be "sha256" or "ed25519".`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// `help` command
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("help")
  .description("Show usage and examples")
  .action(() => {
    console.log(HelpText);
  });

// ─────────────────────────────────────────────────────────────────────────────
// `register` command
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Standalone registration command.
 *
 * Three modes (mutually exclusive):
 *   --create-wallet       Generate a new wallet, register it, print wallet + API keys.
 *   --existing-wallet     Use WALLET_PRIVATE_KEY from .env, register (if new), print API keys.
 *   (neither)             Error: must choose a wallet mode for registration.
 *
 * Optional Ed25519 options (any mode):
 *   --ed25519-public-key <key|path>   PEM string, base64 DER, or path to PEM file.
 *   --ed25519-public-key-name <name>  Human-readable key name (default: "QuoteTrade-BOT").
 *   --generate-ed25519-key            Generate a new Ed25519 key pair, print it, and attach it.
 *
 * When an Ed25519 key is attached, the platform returns an Ed25519 API key in the
 * registerUser response. This is printed as KEY SET 2 alongside the SHA256 keys (KEY SET 1).
 * The user holds two key pairs after registration:
 *   - SHA256:   TRADE_API_KEY + TRADE_API_SECRET  (for HMAC-signed trading requests)
 *   - Ed25519:  Ed25519 API Key + Ed25519 Private Key  (for Ed25519-signed requests)
 */
program
  .command("register")
  .description("Register a new account via wallet (existing or new) and obtain SHA256 API keys")
  .option("--create-wallet", "Generate a new Ethereum wallet, register it, and print credentials")
  .option("--existing-wallet", "Use WALLET_PRIVATE_KEY from .env to register and obtain API keys")
  .option("--ed25519-public-key <key>", "Ed25519 public key to attach (PEM string, base64 DER, or file path)")
  .option("--ed25519-public-key-name <name>", "Name for the Ed25519 key (default: QuoteTrade-BOT)")
  .option("--generate-ed25519-key", "Generate a new Ed25519 key pair, print it, and attach the public key")
  .action(async (opts) => {
    const globalOpts = program.opts();
    if (globalOpts.debug) process.env.CLI_DEBUG = "1";
    const authBaseUrl: string | undefined = globalOpts.authBaseUrl;
    if (authBaseUrl) process.env.WALLET_AUTH_BASE_URL = authBaseUrl;
    const signingAlgorithm = resolveSigningAlgorithmOpt(globalOpts.signingAlgorithm);

    const createWallet = opts.createWallet === true;
    const existingWallet = opts.existingWallet === true;

    if (!createWallet && !existingWallet) {
      console.error(
        "❌ Please specify a wallet mode:\n" +
        "   --create-wallet      Generate a new wallet and register\n" +
        "   --existing-wallet    Use WALLET_PRIVATE_KEY from .env"
      );
      process.exit(1);
    }

    if (createWallet && existingWallet) {
      console.error("❌ --create-wallet and --existing-wallet are mutually exclusive.");
      process.exit(1);
    }

    const ed25519Resolution = resolveEd25519Options({
      ed25519PublicKey: opts.ed25519PublicKey,
      ed25519PublicKeyName: opts.ed25519PublicKeyName,
      generateEd25519Key: opts.generateEd25519Key,
    });

    if (ed25519Resolution) {
      console.log(`\n🔑 Ed25519 key "${ed25519Resolution.ed25519.ed25519PublicKeyName}" will be attached during registration.`);
    }

    try {
      await resolveCredentials({
        createAccount: createWallet,
        existingWallet: existingWallet,
        ed25519: ed25519Resolution?.ed25519,
        generatedEd25519PrivateKeyPem: ed25519Resolution?.generatedPrivateKeyPem,
        authBaseUrl,
        signingAlgorithm,
      });
      console.log("\n✅ Registration complete. Use the keys printed above in your .env for future runs.");
    } catch (e: any) {
      console.error("❌", e?.message ?? e);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// `rsi:enable` command
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("rsi:enable")
  .requiredOption("--symbol <SYMBOL>", "e.g., BTC")
  .option("--notionalUsd <USD>", "Order size in USD", (v) => parseFloat(v), 20)
  .option("--timeframe <TF>", "1m|5m|15m|1h|4h|1d", "1m")
  .option("--period <N>", "RSI period", (v) => parseInt(v, 10), 14)
  .option("--low <N>", "Oversold threshold", (v) => parseFloat(v), 30)
  .option("--high <N>", "Overbought threshold", (v) => parseFloat(v), 70)
  .option("--maxOrdersPerCycle <N>", "Max orders per band cycle (flatten + reverse)", (v) => parseInt(v, 10), 2)
  // Wallet auth options (for users not yet registered via UI)
  .option("--create-wallet", "Generate a new wallet, register, then start trading")
  .option("--existing-wallet", "Use WALLET_PRIVATE_KEY from .env to authenticate")
  // Ed25519 options (only used when registering a new user)
  .option("--ed25519-public-key <key>", "Ed25519 public key to attach on registration (PEM, base64 DER, or file path)")
  .option("--ed25519-public-key-name <name>", "Name for the Ed25519 key (default: QuoteTrade-BOT)")
  .option("--generate-ed25519-key", "Generate a new Ed25519 key pair and attach it on registration")
  .action(async (opts) => {
    const globalOpts = program.opts();
    if (globalOpts.debug) process.env.CLI_DEBUG = "1";
    const authBaseUrl: string | undefined = globalOpts.authBaseUrl;
    if (authBaseUrl) process.env.WALLET_AUTH_BASE_URL = authBaseUrl;
    const signingAlgorithm = resolveSigningAlgorithmOpt(globalOpts.signingAlgorithm);

    const createWallet = opts.createWallet === true;
    const existingWallet = opts.existingWallet === true;

    const ed25519Resolution = resolveEd25519Options({
      ed25519PublicKey: opts.ed25519PublicKey,
      ed25519PublicKeyName: opts.ed25519PublicKeyName,
      generateEd25519Key: opts.generateEd25519Key,
    });

    try {
      await resolveCredentials({
        createAccount: createWallet,
        existingWallet,
        ed25519: ed25519Resolution?.ed25519,
        generatedEd25519PrivateKeyPem: ed25519Resolution?.generatedPrivateKeyPem,
        authBaseUrl,
        signingAlgorithm,
      });
    } catch (e: any) {
      console.error("❌", e?.message ?? e);
      process.exit(1);
    }

    const symbol = opts.symbol.toUpperCase();

    if (!Number(opts.notionalUsd)) {
      console.error("❌ Missing notional Usd. Use: --notionalUsd 100");
      process.exit(1);
    }

    const meta: any = await getInstrumentMeta(symbol);
    if (!meta) {
      console.error(`❌ Unknown symbol: ${symbol} (not in instrument list)`);
      process.exit(1);
    }
    const quantityScale = meta.quantityScale ?? 6;

    let candleMs: number;
    try {
      candleMs = tfToMs(opts.timeframe);
    } catch (e: any) {
      console.error(`❌ ${e?.message ?? e}`);
      process.exit(1);
    }

    if (runners.has(symbol)) {
      console.warn(`⚠️ Runner for ${symbol} already enabled`);
      return;
    }

    console.log(
      `\n🟣  Starting RSI for ${symbol} • TF=${opts.timeframe} (${candleMs / 1000}s) • period=${opts.period} • bands=${opts.low}/${opts.high} • notionalUsd=$${opts.notionalUsd} • scale=${quantityScale}`
    );

    const feed = new LiquidityFeed();
    const exec = new TradeExecutor();
    const runner = new RSIRunner(feed, exec, {
      symbol: symbol,
      period: opts.period,
      low: opts.low,
      high: opts.high,
      candleMs: candleMs,
      quantityScale: quantityScale,
      notionalUsd: opts.notionalUsd,
      maxOrdersPerCycle: opts.maxOrdersPerCycle,
    });

    const TERMINAL_SET = new Set(["FILLED", "REJECTED", "CANCELED", "EXPIRED"]);
    const listenKeyBus = new ListenKeyFeedBus();
    let lastPos: any | undefined;

    listenKeyBus.on("orderUpdate", (u: any) => {
      if (u.symbol?.toUpperCase() !== symbol) return;
      logOrderUpdate(u);
      if (TERMINAL_SET.has(u.status)) {
        runner.clearInflight();
      }
    });

    listenKeyBus.on("positionUpdate", (u: any) => {
      if (u.symbol?.toUpperCase() !== symbol) return;
      if (!lastPos) {
        logPositionSnapshot(u);
      } else {
        logPositionChange(lastPos, u);
      }
      runner.applyPosition(u);
      lastPos = u;
    });

    listenKeyBus.start();
    runner.start();
    runners.set(symbol, runner);
  });

// ─────────────────────────────────────────────────────────────────────────────
// `rsi:disable` command
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("rsi:disable")
  .requiredOption("--symbol <SYMBOL>")
  .action((opts) => {
    const key = opts.symbol.toUpperCase();
    const r = runners.get(key);
    if (!r) return console.log(`ℹ️ No runner for ${key}`);
    r.stop();
    runners.delete(key);
  });

// ─────────────────────────────────────────────────────────────────────────────
// `rsi:status` command
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("rsi:status")
  .option("--symbol <SYMBOL>", "If omitted, show all")
  .action((opts) => {
    if (opts.symbol) {
      const key = opts.symbol.toUpperCase();
      const r = runners.get(key);
      if (!r) return console.log(`${BLUE}ℹ️ No runner for ${key}${RESET}`);
      console.log(r.status());
      return;
    }
    if (runners.size === 0) return console.log(`${BLUE}ℹ️ No active runners${RESET}`);
    for (const [k, r] of runners.entries()) {
      console.log(k, r.status());
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// `rsi:list` command
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("rsi:list")
  .action(() => {
    console.log([...runners.keys()]);
  });

// ─────────────────────────────────────────────────────────────────────────────
// `deposit` command
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("deposit")
  .description("Deposit USDC or USDT to your trading account (ERC-20 transfer to platform address)")
  .requiredOption("--amount <number>", "Amount to deposit (e.g. 100)")
  .requiredOption("--currency <USDC|USDT>", "Currency: USDC or USDT")
  // Wallet auth options
  .option("--create-wallet", "Generate a new wallet, register, then deposit")
  .option("--existing-wallet", "Use WALLET_PRIVATE_KEY from .env to authenticate")
  .action(async (opts) => {
    const globalOpts = program.opts();
    if (globalOpts.debug) process.env.CLI_DEBUG = "1";
    const authBaseUrl: string | undefined = globalOpts.authBaseUrl;
    if (authBaseUrl) process.env.WALLET_AUTH_BASE_URL = authBaseUrl;
    const signingAlgorithm = resolveSigningAlgorithmOpt(globalOpts.signingAlgorithm);

    const createWallet = opts.createWallet === true;
    const existingWallet = opts.existingWallet === true;

    try {
      await resolveCredentials({ createAccount: createWallet, existingWallet, authBaseUrl, signingAlgorithm });
    } catch (e: any) {
      console.error("❌", e?.message ?? e);
      process.exit(1);
    }

    const amount = parseFloat(opts.amount);
    if (isNaN(amount) || amount <= 0) {
      console.error("❌ Invalid amount. Use e.g. --amount 100");
      process.exit(1);
    }
    const currency = (opts.currency ?? "").toUpperCase();
    if (!isDepositToken(currency)) {
      console.error("❌ Currency must be one of:", DEPOSIT_TOKENS.join(", "));
      process.exit(1);
    }

    const walletKey = getResolvedWalletPrivateKey();
    if (!walletKey) {
      console.error(
        "❌ Deposit requires wallet login. Set WALLET_PRIVATE_KEY in .env and use --existing-wallet, or use --create-wallet."
      );
      process.exit(1);
    }

    try {
      const { address: depositAddress } = await getDepositAddress();
      const chainConfig = getDepositChainConfig();
      console.log(`\n📤 Depositing ${amount} ${currency} to platform (${chainConfig.name})...`);
      const txHash = await transferERC20ToDeposit(chainConfig, walletKey, currency, amount, depositAddress);
      console.log(`\n✅ Deposit sent. Transaction hash: ${txHash}`);
    } catch (e: any) {
      console.error("❌ Deposit failed:", e?.message ?? e);
      process.exit(1);
    }
  });

program.parse(process.argv);
