import WebSocket from "ws";
import * as dotenv from "dotenv";
import { PriceFeed, Tick, OrderBookMessage } from "../types";
import {MAGENTA, RESET} from "../ANSI";
import EventEmitter from "node:events";
dotenv.config();

/**
 * Connects to LIQUIDITY_WS_URL and parses order-book snapshots like:
 * { s: "BTC", bids: [{p,q,dp}...], asks: [{p,q,dp}...] }
 * Produces a Tick with mid-price = (bestBid+bestAsk)/2
 */
export class LiquidityFeed extends EventEmitter implements PriceFeed {
    private ws?: WebSocket;
    private stopped = false;

    start(symbol: string, candleMs: number, onTick: (t: Tick) => void): () => void {
        const url = process.env.LIQUIDITY_WS_URL || '';

        this.stopped = false;
        this.ws = new WebSocket(url);

        this.ws.on("open", () => {
            // If your server needs a subscribe message, send it here.
            // Example (adjust to your backend’s protocol):
            console.log(`🔌 ${MAGENTA} Connected: Liquidity WebSocket is now open${RESET}`);
            this.ws?.send(JSON.stringify({symbol, unsubscribe: 0}));
        });

        this.ws.on("message", (data: WebSocket.RawData) => {
            try {
                const msg: any = JSON.parse(data.toString()) as OrderBookMessage;
                if (msg.status === 'subscribed') {
                    console.log(`📡 ${MAGENTA} Subscribed to price feed for ${symbol}, candle size = ${candleMs / 1000}s${RESET}`);
                }

                if (!msg?.bids?.length || !msg?.asks?.length) return;
                if (msg.s?.toUpperCase() !== symbol.toUpperCase()) return;

                const bestBid = msg.bids[0]?.p;
                const bestAsk = msg.asks[0]?.p;
                if (typeof bestBid !== "number" || typeof bestAsk !== "number") return;

                const mid = (bestBid + bestAsk) / 2;
                // console.log('onmessage', msg.s, { ts: Date.now(), price: mid });
                // this.emit("orderBookUpdate", msg);
                onTick({ ts: Date.now(), price: mid, orderBook: msg });
            } catch (err: any) {
                // ignore non-JSON frames / heartbeats
                console.error("❌ Liquidity feed message error:", err.message || err);
            }
        });

        this.ws.on("error", (err) => {
            // console.error("WS error:", err.message);
            console.error("❌ Liquidity feed error:", err.message || err);
        });

        this.ws.on("close", () => {
            if (!this.stopped) {
                // basic reconnect
                setTimeout(() => this.start(symbol, candleMs, onTick), 1000);
            } else {
                console.warn(`❌ Liquidity feed closed...`);
            }
        });

        return () => {
            this.stopped = true;
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.close(1000, "client stop");
            }
            this.ws = undefined;
        };
    }
}
