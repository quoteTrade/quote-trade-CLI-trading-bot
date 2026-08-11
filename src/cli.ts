#!/usr/bin/env node
import { Command } from "commander";
import * as dotenv from "dotenv";

dotenv.config();

import { BLUE, GREEN, RED, RESET, YELLOW } from "./ANSI";
import { resolveCredentials } from "./auth/credentials";
import { generateEd25519KeyPair, printEd25519KeyPairDetails } from "./auth/ed25519-utils";
import { HelpText } from "./constant/cli-text";
import { TradeExecutor } from "./execution/executor";
import { LiquidityFeed } from "./feeds/liquidity-feed";
import { ListenKeyFeedBus } from "./feeds/listenkey-feed-bus";
import {
  FREE_FALLBACK_ORDER,
  formatDraft,
  formatLlmProviderRows,
  LlmConfigStore,
  LlmDraftStore,
  LlmStrategyPlanner,
  parsePlanCommands,
  redactedSecret,
} from "./llm";
import { codexOAuthStatus, logoutCodexOAuth, runCodexOAuthLogin } from "./llm/codex-oauth";
import { logPositionChange, logPositionSnapshot } from "./log/trade-logger";
import { RSIRunner } from "./rsi-runner";
import { HttpSvc } from "./services/http.service";
import { formatOrderPage, formatRisk, formatTriggers } from "./triggers/format";
import { OrderHistoryStore } from "./triggers/order-history-store";
import { PositionStore } from "./triggers/position-store";
import { PositionSyncService } from "./triggers/position-sync";
import { TriggerEngine } from "./triggers/trigger-engine";
import { TriggerStore } from "./triggers/trigger-store";
import {
  makeGroupId,
  normalizeSide,
  normalizeSymbol,
  parseAmountOrPercent,
  parseTimeOrDuration,
  type TriggerInput,
} from "./triggers/types";
import { getInstrumentMeta, tfToMs } from "./utils";

const runners = new Map<string, RSIRunner>();
const program = new Command();
program
  .name("Quote.Trade-cli-bot")
  .description("Headless CLI RSI trading bot with local trigger orders")
  .helpOption(false)
  .addHelpCommand(false)
  .version("", "", "")
  .option("--debug", "Enable debug logging")
  .option("--auth-base-url <url>", "Wallet auth API base URL")
  .option("--signing-algorithm <sha256|ed25519>", "Signing algorithm");

const positions = new PositionStore();
const triggers = new TriggerStore();
const llmConfig = new LlmConfigStore();
const llmDrafts = new LlmDraftStore();
const executor = new TradeExecutor();
const orderHistory = new OrderHistoryStore();
const engine = new TriggerEngine(triggers, positions, executor, {
  onTrigger: (t, o) =>
    console.log(
      `${GREEN}✅ Trigger fired${RESET} ${t.id}: submitted ${o.type} ${o.side} ${o.symbol} qty=${o.quantity}${o.price ? ` limit=${o.price}` : ""}`,
    ),
  onReject: (t, r) => console.log(`${RED}❌ Trigger rejected${RESET} ${t.id}: ${r}`),
  onError: (t, e: any) => console.log(`${RED}❌ Trigger error${RESET} ${t.id}: ${e?.message ?? e}`),
  onAction: (t, m) => console.log(`${YELLOW}⚙️ ${t.id}:${RESET} ${m}`),
});

async function resolveForCommand(opts: any = {}): Promise<void> {
  const g = program.opts();
  if (g.debug) process.env.CLI_DEBUG = "1";
  if (g.authBaseUrl) process.env.WALLET_AUTH_BASE_URL = g.authBaseUrl;
  await resolveCredentials({
    createAccount: opts.createWallet,
    existingWallet: opts.existingWallet,
    authBaseUrl: g.authBaseUrl,
    signingAlgorithm: g.signingAlgorithm,
  });
}

function parsePositiveFloat(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Expected positive number, got ${value}`);
  return n;
}

function parseNonNegativeFloat(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Expected non-negative number, got ${value}`);
  return n;
}

function parsePercent(value: string): number {
  const n = parsePositiveFloat(value.replace(/%$/, ""));
  if (n > 100) throw new Error("percentage must be <= 100");
  return n;
}

function parseRiskMetric(value: string): any {
  const metric = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/-/g, "_");
  if (["MAX_POSITION_QTY", "MAX_RISK_USD", "MAX_LOSS_USD"].includes(metric)) return metric;
  throw new Error("risk metric must be MAX_POSITION_QTY, MAX_RISK_USD, or MAX_LOSS_USD");
}

function parseRiskAction(value: string): any {
  const action = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/-/g, "_");
  if (["ALERT", "CLOSE_POSITION", "CANCEL_TRIGGERS"].includes(action)) return action;
  throw new Error("risk action must be ALERT, CLOSE_POSITION, or CANCEL_TRIGGERS");
}

function sizingFromOptions(opts: any): Pick<TriggerInput, "quantity" | "closePosition" | "closePercentage"> {
  if (opts.closePosition) return { closePosition: true };
  if (opts.closePercentage !== undefined) return { closePercentage: opts.closePercentage };
  return { quantity: opts.quantity };
}

function exitSizingFromOptions(opts: any): Pick<TriggerInput, "quantity" | "closePosition" | "closePercentage"> {
  const sizing = sizingFromOptions(opts);
  return sizing.quantity === undefined && !sizing.closePosition && sizing.closePercentage === undefined
    ? { closePosition: true }
    : sizing;
}

function defaultCloseSide(symbol: string, explicitSide?: string): any {
  return explicitSide ? normalizeSide(explicitSide) : (positions.getCloseSide(symbol) ?? "SELL");
}

function printCreated(triggerOrTriggers: any, watch = false): void {
  const list = Array.isArray(triggerOrTriggers) ? triggerOrTriggers : [triggerOrTriggers];
  console.log(`${GREEN}Created trigger${list.length > 1 ? "s" : ""}:${RESET}\n${formatTriggers(list)}`);
  if (watch) runTriggerWatcher([...new Set(list.map((t) => t.symbol))]);
}

function printLlmConnectionSaved(provider: string, model: string, keySource: string): void {
  console.log(`${GREEN}Saved LLM connection:${RESET} ${provider} model=${model} key=${keySource}`);
}

function cliOwner(opts: any = {}): string {
  return String(opts.owner || process.env.QUOTE_TRADE_LLM_OWNER || "default");
}

function createTriggersFromLlmCommands(commands: string[], ownerId = "default"): any[] {
  const actions = parsePlanCommands(commands, {
    ownerId,
    defaultPaymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
    format: "cli",
    resolveCloseSide: (symbol) => positions.getCloseSide(symbol) as any,
  });
  const created: any[] = [];
  for (const action of actions) {
    if (action.action === "oco") created.push(...triggers.addOco(action.inputs, makeGroupId("llm_oco")));
    else for (const input of action.inputs) created.push(triggers.add(input));
  }
  return created;
}

function runTriggerWatcher(symbols?: string[]): void {
  const hasTimers = triggers.active().some((t) => t.kind === "TIME_CLOSE" || t.kind === "TIME_CANCEL");
  const watchedSymbols = symbols?.length ? symbols.map(normalizeSymbol) : triggers.watchableSymbols();

  if (!watchedSymbols.length && !hasTimers) {
    console.log(`${BLUE}No active triggers to watch.${RESET}`);
    return;
  }

  const stops: Array<() => void> = [];
  for (const symbol of watchedSymbols) {
    const feed = new LiquidityFeed();
    stops.push(
      feed.start(symbol, 1000, (tick) => {
        if (String(process.env.CLI_DEBUG ?? "").toLowerCase() === "1") {
          console.log(
            "[TRIGGER_DEBUG] RAW_TICK",
            JSON.stringify(
              {
                symbol,
                price: tick.price,
                bid: tick.bid,
                ask: tick.ask,
                bidQty: tick.bidQty,
                askQty: tick.askQty,
                mark: tick.mark,
                ts: tick.ts,
                hasOrderBook: !!tick.orderBook,
              },
              null,
              2,
            ),
          );
        }
        void engine.processTick({
          symbol,
          price: tick.price,
          bid: tick.bid,
          ask: tick.ask,
          bidQty: tick.bidQty,
          askQty: tick.askQty,
          mark: tick.mark,
          ts: tick.ts,
          orderBook: tick.orderBook,
        });
      }),
    );
  }

  const timer = setInterval(() => void engine.processDueTimers(), 1000);
  const bus = new ListenKeyFeedBus();
  const last = new Map<string, any>();
  // bus.on("orderUpdate", logOrderUpdate);
  bus.on("orderUpdate", (u: any) => {
    // logOrderUpdate(u);
    orderHistory.upsert(u);
  });
  bus.on("positionUpdate", (u: any) => {
    const p = last.get(u.symbol);
    if (!p) logPositionSnapshot(u);
    else logPositionChange(p, u);
    const position = positions.upsert(u);
    if (position) void engine.processPositionUpdate(position.symbol);
    last.set(u.symbol, u);
  });
  bus.on("error", (e: any) => console.error(`${YELLOW}Listen-key warning:${RESET}`, e?.message ?? e));
  bus.start();

  console.log(
    `${GREEN}Watching triggers${RESET}${watchedSymbols.length ? ` for: ${watchedSymbols.join(", ")}` : ""}. Stop with Ctrl+C.`,
  );
  const shutdown = () => {
    for (const stop of stops) stop();
    clearInterval(timer);
    bus.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshOrderHistoryFromWs(waitMs = 5000): Promise<number> {
  return new Promise((resolve) => {
    const bus = new ListenKeyFeedBus();
    let count = 0;

    const timer = setTimeout(() => {
      bus.stop();
      resolve(count);
    }, waitMs);

    bus.on("orderUpdate", (u: any) => {
      // logOrderUpdate(u);
      orderHistory.upsert(u);
      count++;
    });

    bus.on("error", (e: any) => {
      console.error(`${YELLOW}Listen-key warning:${RESET}`, e?.message ?? e);
    });

    bus.start();

    process.once("SIGINT", () => {
      clearTimeout(timer);
      bus.stop();
      resolve(count);
    });
  });
}

program
  .command("help")
  .description("Show usage")
  .action(() => console.log(HelpText));

program
  .command("register")
  .option("--create-wallet")
  .option("--existing-wallet")
  .option("--generate-ed25519-key")
  .action(async (opts) => {
    if (opts.generateEd25519Key) printEd25519KeyPairDetails(generateEd25519KeyPair(), "QuoteTrade-BOT");
    await resolveForCommand(opts);
    console.log("✅ Credentials resolved for this command.");
  });

program
  .command("rsi:enable")
  .requiredOption("--symbol <symbol>")
  .option("--notionalUsd <number>", "Order size", parseFloat, 20)
  .option("--timeframe <tf>", "1m|5m|15m|1h|4h|1d", "1m")
  .option("--period <number>", "RSI period", parseInt, 14)
  .option("--low <number>", "Oversold", parseFloat, 30)
  .option("--high <number>", "Overbought", parseFloat, 70)
  .option("--maxOrdersPerCycle <number>", "Max orders", parseInt, 2)
  .option("--create-wallet")
  .option("--existing-wallet")
  .action(async (opts) => {
    await resolveForCommand(opts);
    const symbol = normalizeSymbol(opts.symbol);
    const meta = await getInstrumentMeta(symbol);
    const r = new RSIRunner(new LiquidityFeed(), executor, {
      symbol,
      period: opts.period,
      low: opts.low,
      high: opts.high,
      candleMs: tfToMs(opts.timeframe),
      quantityScale: meta.quantityScale ?? 6,
      notionalUsd: opts.notionalUsd,
      maxOrdersPerCycle: opts.maxOrdersPerCycle,
    });
    r.start();
    runners.set(symbol, r);
    console.log(`Started RSI runner for ${symbol}`);
  });

program
  .command("rsi:disable")
  .requiredOption("--symbol <symbol>")
  .action((opts) => {
    const k = normalizeSymbol(opts.symbol);
    const r = runners.get(k);
    if (r) r.stop();
    runners.delete(k);
  });
program
  .command("rsi:status")
  .option("--symbol <symbol>")
  .action((opts) => {
    if (opts.symbol) {
      const r = runners.get(normalizeSymbol(opts.symbol));
      console.log(r ? r.status() : `${BLUE}ℹ️ No runner${RESET}`);
    } else
      console.log(
        [...runners.entries()].map(([k, r]) => `${k}: ${r.status()}`).join("\n") ||
          `${BLUE}ℹ️ No active runners${RESET}`,
      );
  });
program.command("rsi:list").action(() => console.log([...runners.keys()].join("\n") || "No runners."));

function commonOrderOptions(cmd: Command): Command {
  return cmd
    .option("--quantity <qty>", "Order quantity", parsePositiveFloat)
    .option("--close-position")
    .option("--close-percentage <pct>", "Percent of cached position to close", parsePercent)
    .option("--paymentCurrency <currency>", "Payment currency", "USD")
    .option("--watch");
}

commonOrderOptions(
  program
    .command("trigger:limit")
    .requiredOption("--symbol <symbol>")
    .requiredOption("--side <BUY|SELL>")
    .requiredOption("--price <price>", "Trigger and limit price", parsePositiveFloat),
).action(async (opts) => {
  await resolveForCommand(opts);
  const symbol = normalizeSymbol(opts.symbol);
  printCreated(
    triggers.add({
      kind: "LIMIT",
      symbol,
      side: normalizeSide(opts.side),
      triggerPrice: opts.price,
      ...sizingFromOptions(opts),
      paymentCurrency: opts.paymentCurrency,
    }),
    opts.watch,
  );
});

commonOrderOptions(
  program
    .command("trigger:stop-limit")
    .requiredOption("--symbol <symbol>")
    .requiredOption("--side <BUY|SELL>")
    .requiredOption("--stop <price>", "Stop trigger price", parsePositiveFloat)
    .requiredOption("--limit <price>", "Limit order price", parsePositiveFloat),
).action(async (opts) => {
  await resolveForCommand(opts);
  const symbol = normalizeSymbol(opts.symbol);
  printCreated(
    triggers.add({
      kind: "STOP_LIMIT",
      symbol,
      side: normalizeSide(opts.side),
      triggerPrice: opts.stop,
      limitPrice: opts.limit,
      ...sizingFromOptions(opts),
      paymentCurrency: opts.paymentCurrency,
    }),
    opts.watch,
  );
});

commonOrderOptions(
  program
    .command("trigger:take-profit")
    .requiredOption("--symbol <symbol>")
    .option("--side <BUY|SELL>")
    .requiredOption("--price <price>", "Take-profit trigger price", parsePositiveFloat)
    .option("--limit <price>", "Optional limit price", parsePositiveFloat),
).action(async (opts) => {
  await resolveForCommand(opts);
  const symbol = normalizeSymbol(opts.symbol);
  printCreated(
    triggers.add({
      kind: "TAKE_PROFIT",
      symbol,
      side: defaultCloseSide(symbol, opts.side),
      triggerPrice: opts.price,
      limitPrice: opts.limit,
      ...exitSizingFromOptions(opts),
      paymentCurrency: opts.paymentCurrency,
    }),
    opts.watch,
  );
});

commonOrderOptions(
  program
    .command("trigger:stop-loss")
    .requiredOption("--symbol <symbol>")
    .option("--side <BUY|SELL>")
    .requiredOption("--price <price>", "Stop-loss trigger price", parsePositiveFloat)
    .option("--limit <price>", "Optional limit price", parsePositiveFloat),
).action(async (opts) => {
  await resolveForCommand(opts);
  const symbol = normalizeSymbol(opts.symbol);
  printCreated(
    triggers.add({
      kind: "STOP_LOSS",
      symbol,
      side: defaultCloseSide(symbol, opts.side),
      triggerPrice: opts.price,
      limitPrice: opts.limit,
      ...exitSizingFromOptions(opts),
      paymentCurrency: opts.paymentCurrency,
    }),
    opts.watch,
  );
});

commonOrderOptions(
  program
    .command("trigger:trailing-stop")
    .requiredOption("--symbol <symbol>")
    .option("--side <BUY|SELL>")
    .requiredOption("--trail <amount|percent>", "Trailing distance, e.g. 1000 or 5%"),
).action(async (opts) => {
  await resolveForCommand(opts);
  const symbol = normalizeSymbol(opts.symbol);
  const trail = parseAmountOrPercent(opts.trail);
  printCreated(
    triggers.add({
      kind: "TRAILING_STOP",
      symbol,
      side: defaultCloseSide(symbol, opts.side),
      trailMode: trail.mode,
      trailValue: trail.value,
      ...exitSizingFromOptions(opts),
      paymentCurrency: opts.paymentCurrency,
    }),
    opts.watch,
  );
});

commonOrderOptions(
  program
    .command("trigger:trailing-stop-limit")
    .requiredOption("--symbol <symbol>")
    .option("--side <BUY|SELL>")
    .requiredOption("--trail <amount|percent>", "Trailing distance, e.g. 1000 or 5%")
    .option("--limit-offset <amount>", "Limit offset from trailing stop", parseNonNegativeFloat, 0),
).action(async (opts) => {
  await resolveForCommand(opts);
  const symbol = normalizeSymbol(opts.symbol);
  const trail = parseAmountOrPercent(opts.trail);
  printCreated(
    triggers.add({
      kind: "TRAILING_STOP_LIMIT",
      symbol,
      side: defaultCloseSide(symbol, opts.side),
      trailMode: trail.mode,
      trailValue: trail.value,
      limitOffset: opts.limitOffset,
      ...exitSizingFromOptions(opts),
      paymentCurrency: opts.paymentCurrency,
    }),
    opts.watch,
  );
});

commonOrderOptions(
  program
    .command("trigger:oco")
    .requiredOption("--symbol <symbol>")
    .option("--side <BUY|SELL>")
    .requiredOption("--take-profit <price>", "Take-profit trigger price", parsePositiveFloat)
    .requiredOption("--stop-loss <price>", "Stop-loss trigger price", parsePositiveFloat)
    .option("--stop-limit <price>", "Optional stop-limit order price", parsePositiveFloat)
    .option("--take-profit-limit <price>", "Optional take-profit limit order price", parsePositiveFloat),
).action(async (opts) => {
  await resolveForCommand(opts);
  const symbol = normalizeSymbol(opts.symbol);
  const side = defaultCloseSide(symbol, opts.side);
  const sizing = exitSizingFromOptions(opts);
  const groupId = makeGroupId("oco");
  const children = triggers.addOco(
    [
      {
        kind: "TAKE_PROFIT",
        symbol,
        side,
        triggerPrice: opts.takeProfit,
        limitPrice: opts.takeProfitLimit,
        ...sizing,
        paymentCurrency: opts.paymentCurrency,
      },
      opts.stopLimit
        ? {
            kind: "STOP_LIMIT",
            symbol,
            side,
            triggerPrice: opts.stopLoss,
            limitPrice: opts.stopLimit,
            ...sizing,
            paymentCurrency: opts.paymentCurrency,
          }
        : {
            kind: "STOP_LOSS",
            symbol,
            side,
            triggerPrice: opts.stopLoss,
            ...sizing,
            paymentCurrency: opts.paymentCurrency,
          },
    ] as any[],
    groupId,
  );
  printCreated(children, opts.watch);
});

commonOrderOptions(
  program
    .command("trigger:bracket")
    .requiredOption("--symbol <symbol>")
    .requiredOption("--side <BUY|SELL>", "Entry side")
    .requiredOption("--entry <price>", "Entry limit price", parsePositiveFloat)
    .requiredOption("--take-profit <price>", "Exit take-profit trigger", parsePositiveFloat)
    .requiredOption("--stop-loss <price>", "Exit stop-loss trigger", parsePositiveFloat)
    .option("--stop-limit <price>", "Optional exit stop-limit order price", parsePositiveFloat)
    .option("--exits-close-position", "Resolve bracket exits from cached position instead of fixed entry quantity"),
).action(async (opts) => {
  await resolveForCommand(opts);
  const symbol = normalizeSymbol(opts.symbol);
  printCreated(
    triggers.add({
      kind: "LIMIT",
      symbol,
      side: normalizeSide(opts.side),
      triggerPrice: opts.entry,
      ...sizingFromOptions(opts),
      paymentCurrency: opts.paymentCurrency,
      meta: {
        bracket: {
          takeProfitPrice: opts.takeProfit,
          stopLossPrice: opts.stopLoss,
          stopLimitPrice: opts.stopLimit,
          useClosePosition: opts.exitsClosePosition,
        },
      },
    }),
    opts.watch,
  );
});

commonOrderOptions(
  program
    .command("trigger:scale-out")
    .requiredOption("--symbol <symbol>")
    .option("--side <BUY|SELL>")
    .requiredOption("--price <price>", "Scale-out take-profit price", parsePositiveFloat)
    .requiredOption("--percent <pct>", "Percent of current position to close", parsePercent)
    .option("--limit <price>", "Optional limit price", parsePositiveFloat),
).action(async (opts) => {
  await resolveForCommand(opts);
  const symbol = normalizeSymbol(opts.symbol);
  printCreated(
    triggers.add({
      kind: "TAKE_PROFIT",
      symbol,
      side: defaultCloseSide(symbol, opts.side),
      triggerPrice: opts.price,
      limitPrice: opts.limit,
      closePercentage: opts.percent,
      reduceOnly: true,
      paymentCurrency: opts.paymentCurrency,
      meta: { strategy: "SCALE_OUT" },
    }),
    opts.watch,
  );
});

commonOrderOptions(
  program
    .command("trigger:break-even")
    .requiredOption("--symbol <symbol>")
    .option("--side <BUY|SELL>")
    .requiredOption("--after <amount|percent>", "Favorable move before arming, e.g. 1000 or 3%")
    .option("--plus <amount|percent>", "Profit locked after arming, default 0", "0")
    .option("--limit <price>", "Optional static limit price", parsePositiveFloat),
).action(async (opts) => {
  await resolveForCommand(opts);
  const symbol = normalizeSymbol(opts.symbol);
  const after = parseAmountOrPercent(opts.after);
  const plus = opts.plus === "0" ? { mode: "AMOUNT" as const, value: 0 } : parseAmountOrPercent(opts.plus);
  printCreated(
    triggers.add({
      kind: "BREAK_EVEN_STOP",
      symbol,
      side: defaultCloseSide(symbol, opts.side),
      activationMode: after.mode,
      activationValue: after.value,
      lockMode: plus.mode,
      lockValue: plus.value,
      limitPrice: opts.limit,
      ...exitSizingFromOptions(opts),
      paymentCurrency: opts.paymentCurrency,
    }),
    opts.watch,
  );
});

commonOrderOptions(
  program
    .command("trigger:close-after")
    .requiredOption("--symbol <symbol>")
    .requiredOption("--after <duration>", "Duration like 30m, 4h, 1d")
    .option("--side <BUY|SELL>")
    .option("--limit <price>", "Optional limit price", parsePositiveFloat),
).action(async (opts) => {
  await resolveForCommand(opts);
  const symbol = normalizeSymbol(opts.symbol);
  printCreated(
    triggers.add({
      kind: "TIME_CLOSE",
      symbol,
      side: defaultCloseSide(symbol, opts.side),
      triggerAt: parseTimeOrDuration(opts.after),
      limitPrice: opts.limit,
      ...exitSizingFromOptions(opts),
      paymentCurrency: opts.paymentCurrency,
    }),
    opts.watch,
  );
});

commonOrderOptions(
  program
    .command("trigger:close-at")
    .requiredOption("--symbol <symbol>")
    .requiredOption("--at <time>", "ISO date/time")
    .option("--side <BUY|SELL>")
    .option("--limit <price>", "Optional limit price", parsePositiveFloat),
).action(async (opts) => {
  await resolveForCommand(opts);
  const symbol = normalizeSymbol(opts.symbol);
  printCreated(
    triggers.add({
      kind: "TIME_CLOSE",
      symbol,
      side: defaultCloseSide(symbol, opts.side),
      triggerAt: parseTimeOrDuration(opts.at),
      limitPrice: opts.limit,
      ...exitSizingFromOptions(opts),
      paymentCurrency: opts.paymentCurrency,
    }),
    opts.watch,
  );
});

program
  .command("trigger:cancel-after")
  .requiredOption("--id <trigger-id>")
  .requiredOption("--after <duration>", "Duration like 30m, 4h, 1d")
  .option("--watch")
  .action(async (opts) => {
    await resolveForCommand(opts);
    const target = triggers.get(opts.id);
    const symbol = target?.symbol ?? "GLOBAL";
    printCreated(
      triggers.add({
        kind: "TIME_CANCEL",
        symbol,
        side: "SELL",
        triggerAt: parseTimeOrDuration(opts.after),
        cancelTriggerId: opts.id,
        paymentCurrency: "USD",
      }),
      opts.watch,
    );
  });

commonOrderOptions(
  program
    .command("trigger:price-band")
    .requiredOption("--symbol <symbol>")
    .requiredOption("--side <BUY|SELL>")
    .requiredOption("--mode <BREAKOUT|REVERSION>")
    .option("--upper <price>", "Upper band", parsePositiveFloat)
    .option("--lower <price>", "Lower band", parsePositiveFloat)
    .option("--limit <price>", "Optional limit price", parsePositiveFloat),
).action(async (opts) => {
  await resolveForCommand(opts);
  const symbol = normalizeSymbol(opts.symbol);
  const mode = String(opts.mode).trim().toUpperCase() as any;
  printCreated(
    triggers.add({
      kind: "PRICE_BAND",
      symbol,
      side: normalizeSide(opts.side),
      priceBandMode: mode,
      upperPrice: opts.upper,
      lowerPrice: opts.lower,
      limitPrice: opts.limit,
      ...sizingFromOptions(opts),
      paymentCurrency: opts.paymentCurrency,
    }),
    opts.watch,
  );
});

commonOrderOptions(
  program
    .command("trigger:risk-guard")
    .requiredOption("--symbol <symbol>")
    .requiredOption("--metric <metric>", "MAX_POSITION_QTY|MAX_RISK_USD|MAX_LOSS_USD")
    .requiredOption("--threshold <number>", "Risk threshold", parsePositiveFloat)
    .option("--action <action>", "ALERT|CLOSE_POSITION|CANCEL_TRIGGERS", "ALERT")
    .option("--side <BUY|SELL>")
    .option("--limit <price>", "Optional close limit price", parsePositiveFloat),
).action(async (opts) => {
  await resolveForCommand(opts);
  const symbol = normalizeSymbol(opts.symbol);
  const action = parseRiskAction(opts.action);
  printCreated(
    triggers.add({
      kind: "RISK_GUARD",
      symbol,
      side: defaultCloseSide(symbol, opts.side),
      riskMetric: parseRiskMetric(opts.metric),
      riskThreshold: opts.threshold,
      riskAction: action,
      closePosition: action === "CLOSE_POSITION" || opts.closePosition,
      limitPrice: opts.limit,
      quantity: opts.quantity,
      paymentCurrency: opts.paymentCurrency,
    }),
    opts.watch,
  );
});

program
  .command("trigger:list")
  .option("--all")
  .option("--symbol <symbol>")
  .action((opts) => {
    const status = opts.all ? undefined : ("ACTIVE" as any);
    console.log(
      formatTriggers(triggers.list({ symbol: opts.symbol ? normalizeSymbol(opts.symbol) : undefined, status })),
    );
  });
program
  .command("trigger:cancel")
  .requiredOption("--id <id>")
  .action((opts) => {
    const t = triggers.cancel(opts.id);
    console.log(t ? `${YELLOW}Cancelled:${RESET}\n${formatTriggers([t])}` : `No trigger found: ${opts.id}`);
  });
program
  .command("trigger:watch")
  .option("--symbol <symbol>")
  .action(async (opts) => {
    await resolveForCommand(opts);
    runTriggerWatcher(opts.symbol ? [opts.symbol] : undefined);
  });

program
  .command("filledorders:refresh")
  .option("--page <page>", "Page number", parseInt, 1)
  .option("--page-size <size>", "Page size", parseInt, 10)
  .option("--wait-ms <ms>", "How long to listen for WS order updates", parseInt, 5000)
  .action(async (opts) => {
    await resolveForCommand({});

    const count = await refreshOrderHistoryFromWs(opts.waitMs);

    // OrderHistoryStore rebuilds grouped lists with a small debounce.
    await sleep(600);

    const page = orderHistory.fills(opts.page, opts.pageSize);

    console.log(`Refreshed ${count} order update(s) from listen-key WS.`);
    console.log(formatOrderPage("Filled Orders", page, "filledorders:refresh", orderHistory.isSyncing()));
  });

program.command("positions:list").action(async () => {
  await new PositionSyncService(HttpSvc, positions).refresh().catch(() => 0);
  console.log(positions.describe());
});
program.command("risk").action(() => console.log(formatRisk(positions)));

program
  .command("llm:connect")
  .requiredOption(
    "--provider <provider>",
    "openai|anthropic|xai|codex|ovhcloud|gemini|openrouter|groq|huggingface|pollinations|custom-openai",
  )
  .option("--model <model>", "Provider model name")
  .option("--api-key <key>", "Store an API key locally in .quote-trade/llm-config.json")
  .option("--api-key-env <name>", "Read the API key from this environment variable")
  .option("--base-url <url>", "Override provider base URL")
  .option("--default", "Make this the default provider")
  .option("--fallback", "Use this provider in fallback planning")
  .option("--owner <id>", "LLM/Codex owner namespace", "default")
  .action((opts) => {
    const ownerId = cliOwner(opts);
    const saved = llmConfig.setConnection({
      ownerId,
      provider: opts.provider,
      model: opts.model,
      apiKey: opts.apiKey,
      apiKeyEnv: opts.apiKeyEnv,
      baseUrl: opts.baseUrl,
      makeDefault: opts.default,
      useAsFallback: opts.fallback,
    });
    const keySource =
      saved.provider === "codex-oauth"
        ? "Codex OAuth (run codex:connect)"
        : opts.apiKey
          ? `stored:${redactedSecret(opts.apiKey)}`
          : `env:${saved.apiKeyEnv}`;
    printLlmConnectionSaved(saved.provider, saved.model, keySource);
  });

program
  .command("codex:connect")
  .description("Connect this CLI owner to ChatGPT/Codex OAuth using the local Codex CLI")
  .option("--owner <id>", "LLM/Codex owner namespace", "default")
  .option("--model <model>", "Codex model to use for strategy planning", process.env.CODEX_MODEL || "default")
  .option("--no-default", "Do not make Codex the default LLM provider")
  .action(async (opts) => {
    const ownerId = cliOwner(opts);
    await runCodexOAuthLogin(ownerId);
    const saved = llmConfig.setConnection({
      ownerId,
      provider: "codex-oauth",
      model: opts.model,
      makeDefault: opts.default !== false,
      useAsFallback: false,
    });
    const status = codexOAuthStatus(ownerId);
    printLlmConnectionSaved(saved.provider, saved.model, `oauth:${status.connected ? "connected" : "missing"}`);
    console.log(`Codex home: ${status.codexHome}`);
  });

program
  .command("codex:status")
  .option("--owner <id>", "LLM/Codex owner namespace", "default")
  .action((opts) => {
    const status = codexOAuthStatus(cliOwner(opts));
    console.log(
      `${status.connected ? `${GREEN}connected${RESET}` : `${YELLOW}not connected${RESET}`} auth=${status.authFile}`,
    );
  });

program
  .command("codex:logout")
  .option("--owner <id>", "LLM/Codex owner namespace", "default")
  .action((opts) => {
    const removed = logoutCodexOAuth(cliOwner(opts));
    console.log(
      removed ? `${GREEN}Codex OAuth session removed.${RESET}` : `${YELLOW}No Codex OAuth session found.${RESET}`,
    );
  });

program
  .command("llm:providers")
  .option("--owner <id>", "LLM/Codex owner namespace", "default")
  .action((opts) => console.log(formatLlmProviderRows(llmConfig.listRows(cliOwner(opts)))));
program.command("llm:fallbacks").action(() => {
  console.log(`Free/no-subscription fallback order: ${FREE_FALLBACK_ORDER.join(" -> ")}`);
  console.log(
    "Anonymous providers are used without a key; other free-tier providers are tried when their env key is present. Codex OAuth is opt-in with codex:connect.",
  );
});
program
  .command("llm:plan")
  .requiredOption("--prompt <text>", "English strategy prompt")
  .option("--provider <provider>", "Preferred LLM provider")
  .option("--owner <id>", "LLM/Codex owner namespace", "default")
  .option("--no-fallback", "Disable fallback providers")
  .option("--refresh-positions", "Refresh remembered positions before prompting")
  .action(async (opts) => {
    const ownerId = cliOwner(opts);
    if (opts.refreshPositions) {
      await resolveForCommand(opts);
      await new PositionSyncService(HttpSvc, positions).refresh().catch(() => 0);
    }
    const planner = new LlmStrategyPlanner(llmConfig);
    const plan = await planner.plan({
      ownerId,
      prompt: opts.prompt,
      commandFormat: "cli",
      provider: opts.provider,
      allowFallback: opts.fallback,
      defaultPaymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      positionsContext: positions.describe(),
      riskContext: formatRisk(positions),
      resolveCloseSide: (symbol) => positions.getCloseSide(symbol) as any,
    });
    const draft = llmDrafts.add({
      ownerId,
      prompt: opts.prompt,
      provider: plan.provider,
      model: plan.model,
      format: "cli",
      summary: plan.summary,
      commands: plan.commands,
      riskNotes: plan.riskNotes,
    });
    console.log(formatDraft(draft));
    if (draft.commands.length)
      console.log(`
Confirm only after review:
  npm run cli -- llm:confirm --id ${draft.id}${ownerId !== "default" ? ` --owner ${ownerId}` : ""}`);
  });
program
  .command("llm:confirm")
  .requiredOption("--id <draft-id>")
  .option("--owner <id>", "LLM/Codex owner namespace", "default")
  .option("--watch")
  .action(async (opts) => {
    const ownerId = cliOwner(opts);
    await resolveForCommand(opts);
    const draft = llmDrafts.get(opts.id, ownerId);
    if (!draft) throw new Error(`No LLM draft found: ${opts.id}`);
    if (draft.status !== "PENDING") throw new Error(`Draft ${opts.id} is ${draft.status}, not PENDING`);
    if (!draft.commands.length) throw new Error(`Draft ${opts.id} has no commands to confirm`);
    const created = createTriggersFromLlmCommands(draft.commands, ownerId);
    llmDrafts.mark(opts.id, "CONFIRMED", ownerId);
    printCreated(created, opts.watch);
  });
program
  .command("llm:drafts")
  .option("--owner <id>", "LLM/Codex owner namespace", "default")
  .option("--all")
  .action((opts) => {
    const drafts = llmDrafts.list(cliOwner(opts), opts.all);
    console.log(drafts.length ? drafts.map(formatDraft).join("\n\n---\n\n") : "No pending LLM drafts.");
  });
program
  .command("llm:cancel")
  .requiredOption("--id <draft-id>")
  .option("--owner <id>", "LLM/Codex owner namespace", "default")
  .action((opts) => {
    const draft = llmDrafts.mark(opts.id, "CANCELLED", cliOwner(opts));
    console.log(`Cancelled ${draft.id}.`);
  });

// Parse only when this file is the program being run. Importing the module then
// yields the configured `program` instead of executing a command against whatever
// argv the host process happens to have, which is what makes these 983 lines
// reachable from tests.
if (require.main === module) {
  program.parse(process.argv);
}

export { program };
