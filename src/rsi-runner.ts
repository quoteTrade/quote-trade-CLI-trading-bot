import {Candle, PriceFeed, Executor, OrderBookMessage} from "./types";
import { CandleAggregator } from "./utils/candle-aggregator";
import {calculateRSI, getMaxMatchingPrices, toQtyFromUsd} from "./utils";
import {BLUE, CYAN, GREEN, MAGENTA, RED, RESET, YELLOW} from "./ANSI";
import {PositionManager} from "./utils/position-manager";
import {logOrderUpdate} from "./log/trade-logger";

export type RSIRunnerParams = {
    symbol: string;
    period?: number;     // default 14
    low?: number;        // default 30
    high?: number;       // default 70
    candleMs?: number;   // default 60_000 (1m)
    notionalUsd?: number;   // NEW
    quantityScale?: number; // NEW
    maxOrdersPerCycle?: number; // NEW (default 2)
};

export class RSIRunner {
    private closes: number[] = [];
    private stopFeed?: () => void;
    private agg: CandleAggregator;
    private pm: PositionManager;
    private orderBook: OrderBookMessage | undefined;
    private mode = (process.env.MODE ?? "paper").toLowerCase();

    constructor(
        private feed: PriceFeed,
        private executor: Executor,
        private params: RSIRunnerParams
    ) {
        const candleMs = params.candleMs ?? 60_000;
        this.agg = new CandleAggregator(candleMs, (c) => this.onCandle(c));
        this.pm = new PositionManager(this.params.maxOrdersPerCycle ?? 2);
    }

    start() {
        if (this.stopFeed) return;
        const { symbol } = this.params;
        this.stopFeed = this.feed.start(symbol, (this.params.candleMs ?? 60_000), (t) => this.agg.ingest(t));

        // this.feed.on("orderBookUpdate", (o: OrderBookMessage) => {
        //    this.orderBook = o;
        // });

        console.log(
            `▶️ ${MAGENTA} RSI runner: ${symbol} (P=${this.params.period ?? 14}, L=${this.params.low ?? 30}, H=${this.params.high ?? 70}, TF=${(this.params.candleMs ?? 60_000)/1000}s)${RESET}`
        );

        // 🔔 Warm-up start message (before CandleAggregator begins)
        console.log(
            `🔔 ${YELLOW} RSI warm-up for ${symbol} — need ${(this.params.period ?? 14) + 1} candles (~${(((this.params.period ?? 14) + 1) * (this.params.candleMs ?? 60_000)) / 60000} minutes)${RESET}`
        );
    }

    stop() {
        if (this.stopFeed) this.stopFeed();
        this.agg.flush();
        this.stopFeed = undefined;
        console.log(`⏹️ ${MAGENTA} RSI runner stopped: ${this.params.symbol}${RESET}`);
    }

    status() {
        const p = this.params.period ?? 14;
        const rsi = calculateRSI(this.closes, p);
        return {
            symbol: this.params.symbol,
            candles: this.closes.length,
            rsi: rsi === null ? "warming-up" : Number(rsi.toFixed(2)),
            period: p,
            low: this.params.low ?? 30,
            high: this.params.high ?? 70
        };
    }

    applyPosition(u: any) {
        const q = Number(u.netQty ?? 0);
        if (q === 0) this.pm.setFlat();
        else if (q > 0) this.pm.setLong(Math.abs(q));
        else this.pm.setShort(Math.abs(q));
    }

    clearInflight() {
        this.pm.inflight = false;
    }

    private async onCandle(c: Candle) {
        this.closes.push(c.close);
        if (this.closes.length > 2000) this.closes.shift();

        const period = this.params.period ?? 14;
        const low = this.params.low ?? 30;
        const high = this.params.high ?? 70;
        const notionalUsd = this.params.notionalUsd ?? 0;
        const scale = this.params.quantityScale ?? 6;

        const rsi = calculateRSI(this.closes, period);
        const ts = new Date(c.end).toISOString();

        if (rsi === null) {
            console.log(`⏳ ${YELLOW} [${ts}] Warming up — ${this.params.symbol} 🕯️ Candle #=${this.closes.length} O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)}${RESET}`);
            return;
        }

        console.log(
            `📊 ${CYAN} [${ts}] ${this.params.symbol}  RSI=${rsi.toFixed(2)} | O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)}${RESET}`
        );

        // Neutral zone → re-arm current side
        if (rsi >= low && rsi <= high) {
            this.pm.rearmFromNeutral();
            return;
        }

        // Gate: do not place another order while one is inflight
        if (this.pm.inflight) return;

        const px = c.close;

        // Helpers for submitting with USD sizing via top-of-book
        const tradeOpen = async (side: "BUY" | "SELL", reason: string) => {
            const qty = toQtyFromUsd(notionalUsd, px, scale);
            const { bid, ask } = getMaxMatchingPrices(c.orderBook, Number(qty));
            if (side === "BUY" && Number(ask?.p || '0') <= 0) {
                console.log(`⏭️  SKIPPED TRADE • (BUY) qty=${qty} - no ask level covers requested quantity ${RESET}`);
                return;
            } else if (side === "SELL" && Number(bid?.p || '0') <= 0) {
                console.log(`⏭️  SKIPPED TRADE • (SELL) qty=${qty} - no bid level covers requested quantity ${RESET}`);
                return;
            }

            try {
                this.pm.inflight = true;
                if (side === "BUY") {
                    await this.executor.buy(this.params.symbol, qty, Number(ask?.p || '0'), reason);
                } else {
                    await this.executor.sell(this.params.symbol, qty, Number(bid?.p || '0'), reason);
                }
                this.pm.consumeAndDisarm();
                return true;
            } catch (e) {
                this.pm.inflight = false;
                return false;
            }
        };

        const tradeFlatten = async (sideToClose: "LONG" | "SHORT", reason: string) => {
            // flatten uses current position size (from WS; Step 3 keeps pm.qtyAbs updated)
            if (this.pm.qtyAbs <= 0) {
                this.pm.consumeAndDisarm(); // consume first step even if already flat (per client rule)
                return true;
            }
            const qty = this.pm.qtyAbs.toFixed(scale);
            const { bid, ask } = getMaxMatchingPrices(c.orderBook, Number(qty));
            if (sideToClose === "LONG" && Number(ask?.p || '0') <= 0) {
                console.log(`⏭️  SKIPPED TRADE • (SELL) - ${sideToClose} qty=${qty} - no ask level covers requested quantity ${RESET}`);
                return;
            } else if (sideToClose === "SHORT" && Number(bid?.p || '0') <= 0) {
                console.log(`⏭️  SKIPPED TRADE • (BUY) - ${sideToClose} qty=${qty} - no bid level covers requested quantity ${RESET}`);
                return;
            }

            try {
                this.pm.inflight = true;
                if (sideToClose === "LONG") {
                    await this.executor.sell(this.params.symbol, qty, Number(bid?.p || '0'), reason);
                } else {
                    await this.executor.buy(this.params.symbol, qty, Number(ask?.p || '0'), reason);
                }
                this.pm.consumeAndDisarm();
                return true;
            } catch (e) {
                this.pm.inflight = false;
                return false;
            }
        };

        if (rsi > high) {
            if (this.mode === "paper") {
                const { bid } = getMaxMatchingPrices(c.orderBook, Number(0));
                await this.executor.sell(this.params.symbol, '0', Number(bid?.p || '0'), `RSI ${rsi.toFixed(2)} > ${high}`);
                return null;
            }

            this.pm.enterBand("upper"); // NEW
            if (!this.pm.armed) return; // must exit to neutral before next action

            if (this.pm.ordersInCycle === 0 && this.pm.side === "LONG") {
                // First hit: SELL to flatten if LONG; if FLAT, consume step with no-op
                await tradeFlatten("LONG", `Flatten long (RSI ${rsi.toFixed(2)} > ${high})`);
                return;
            }

            // Second hit (armed again after neutral): SELL to open SHORT with USD sizing
            if (this.pm.ordersInCycle < this.pm.maxOrdersPerCycle) {
                await tradeOpen("SELL", `Open short $${notionalUsd} (RSI ${rsi.toFixed(2)} > ${high})`);
            }
            return;
        }

        // --- Lower band logic (oversold): BUY first to flatten, second to long ---
        // Lower band: first = flatten short; second = open long
        if (rsi < low) {
            if (this.mode === "paper") {
                const { ask } = getMaxMatchingPrices(c.orderBook, Number(0));
                await this.executor.buy(this.params.symbol, '0', Number(ask?.p || '0'), `RSI ${rsi.toFixed(2)} > ${high}`);
                return null;
            }

            this.pm.enterBand("lower"); // NEW
            if (!this.pm.armed) return;

            if (this.pm.ordersInCycle === 0 && this.pm.side === "SHORT") {
                // First hit: BUY to flatten if SHORT; if FLAT, consume step with no-op
                await tradeFlatten("SHORT", `Flatten short (RSI ${rsi.toFixed(2)} < ${low})`);
                return;
            }

            // Second hit (armed after neutral): BUY to open LONG with USD sizing
            if (this.pm.ordersInCycle < this.pm.maxOrdersPerCycle) {
                await tradeOpen("BUY", `Open long $${notionalUsd} (RSI ${rsi.toFixed(2)} < ${low})`);
            }
        }

        // if (rsi < low) {
        //     await this.executor.buy(this.params.symbol, '0', c.close, `RSI ${rsi.toFixed(2)} < ${low}`);
        // } else if (rsi > high) {
        //     await this.executor.sell(this.params.symbol, '0', c.close, `RSI ${rsi.toFixed(2)} > ${high}`);
        // }
    }
}
