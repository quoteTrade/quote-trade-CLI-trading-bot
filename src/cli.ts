#!/usr/bin/env node
import { Command } from "commander";
import * as dotenv from "dotenv";
dotenv.config();

import { LiquidityFeed } from "./feeds/liquidity-feed";
import { RSIRunner } from "./rsi-runner";
import {BLUE, RED, RESET} from "./ANSI";
import {HelpText} from "./constant/cli-text";
import {getInstrumentMeta, tfToMs} from "./utils";
import {TradeExecutor} from "./execution/executor";
import {ListenKeyFeedBus} from "./feeds/listenkey-feed-bus";
import {logOrderUpdate, logPositionChange, logPositionSnapshot} from "./log/trade-logger";

type RunnerKey = string;
const runners = new Map<RunnerKey, RSIRunner>();

const program = new Command();

program
    .name("Quote.Trade-cli-bot")
    .description("Headless CLI RSI trading bot")
    // .version(version) // enables -V / --version
    // .showSuggestionAfterError(true)
    // .enablePositionalOptions();

// 🔒 Disable Commander’s built-in help + version
program.helpOption(false);
program.addHelpCommand(false);
program.version("", "", "");

// ─────────────────────────────
// Custom `help` command
// ─────────────────────────────
program
    .command("help")
    .description("Show usage and examples")
    .action(() => {
        console.log(HelpText);
    });

program
    .command("rsi:enable")
    .requiredOption("--symbol <SYMBOL>", "e.g., BTC")
    .option("--notionalUsd <USD>", "Order size in USD", (v) => parseFloat(v), 20)
    .option("--timeframe <TF>", "1m|5m|15m|1h|4h|1d", "1m")
    .option("--period <N>", "RSI period", (v) => parseInt(v, 10), 14)
    .option("--low <N>", "Oversold threshold", (v) => parseFloat(v), 30)
    .option("--high <N>", "Overbought threshold", (v) => parseFloat(v), 70)
    .option("--maxOrdersPerCycle <N>", "Max orders per band cycle (flatten + reverse)", (v) => parseInt(v, 10), 2)
    // .option("--candleMs <N>", "Candle size in ms (default 60000)", (v) => parseInt(v, 10), 60_000)
    .action(async (opts) => {
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
            // candleMs = 1000;
        } catch (e: any) {
            console.error(`❌ ${e?.message ?? e}`);
            process.exit(1);
        }

        if (runners.has(symbol)) {
            console.warn(`⚠️ Runner for ${symbol} already enabled`);
            return;
        }

        console.log(`\n🟣  Starting RSI for ${symbol} • TF=${opts.timeframe} (${candleMs/1000}s) • period=${opts.period} • bands=${opts.low}/${opts.high} • notionalUsd=$${opts.notionalUsd} • scale=${quantityScale}`);

        const feed = new LiquidityFeed();   // ← uses LIQUIDITY_WS_URL
        const exec = new TradeExecutor();   // ← stub; replace with real executor
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

        const TERMINAL_SET = new Set(["FILLED","REJECTED","CANCELED","EXPIRED"]);
        const listenKeyBus = new ListenKeyFeedBus();
        let lastPos: any | undefined;
        // order updates → print + clear inflight on terminal
        listenKeyBus.on("orderUpdate", (u: any) => {
            if (u.symbol?.toUpperCase() !== symbol) return;
            logOrderUpdate(u);
            if (TERMINAL_SET.has(u.status)) {
                runner.clearInflight();
            }
        });

        // position updates → snapshot/change + push to runner state
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

program
    .command("rsi:list")
    .action(() => {
        console.log([...runners.keys()]);
    });

program.parse(process.argv);
