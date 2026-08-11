import EventEmitter from "node:events";
import * as dotenv from "dotenv";
import WebSocket from "ws";
import { MAGENTA, RESET } from "../ANSI";
import type { OrderBookMessage, PriceFeed, Tick } from "../types";

dotenv.config();

function tickFromOrderBook(symbol: string, msg: OrderBookMessage): Tick | undefined {
  if (!msg?.bids?.length || !msg?.asks?.length) return undefined;
  if (msg.s && msg.s.toUpperCase() !== symbol.toUpperCase()) return undefined;

  const bid = Number(msg.bids[0]?.p);
  const ask = Number(msg.asks[0]?.p);
  const bidQty = Number(msg.bids[0]?.q ?? msg.bids[0]?.dp);
  const askQty = Number(msg.asks[0]?.q ?? msg.asks[0]?.dp);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return undefined;

  return {
    ts: Date.now(),
    price: ask, // diagnostic only; trigger checks use side-specific L2 depth from orderBook.
    bid,
    ask,
    bidQty: Number.isFinite(bidQty) && bidQty > 0 ? bidQty : undefined,
    askQty: Number.isFinite(askQty) && askQty > 0 ? askQty : undefined,
    orderBook: msg,
  };
}

export class LiquidityFeed extends EventEmitter implements PriceFeed {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;

  start(symbol: string, candleMs: number, onTick: (tick: Tick) => void): () => void {
    const url = process.env.LIQUIDITY_WS_URL || "";
    const minIntervalMs = Math.max(0, candleMs || 0);
    let lastEmitAt = 0;

    const connect = () => {
      this.stopped = false;
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        console.log(` ${MAGENTA}Connected: liquidity WebSocket${RESET}`);
        this.ws?.send(JSON.stringify({ symbol, unsubscribe: 0 }));
      });

      this.ws.on("message", (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString()) as OrderBookMessage;
          if (msg.status === "subscribed")
            console.log(` ${MAGENTA}Subscribed to ${symbol}, candle=${candleMs}ms${RESET}`);

          const tick = tickFromOrderBook(symbol, msg);
          if (!tick) return;

          if (minIntervalMs > 0 && tick.ts - lastEmitAt < minIntervalMs) return;
          lastEmitAt = tick.ts;
          this.emit("tick", symbol, tick);
          onTick(tick);
        } catch (error: any) {
          console.error("liquidity message error", error?.message ?? error);
        }
      });

      this.ws.on("error", (error: any) => console.error("liquidity error", error?.message ?? error));
      this.ws.on("close", () => {
        if (!this.stopped) this.reconnectTimer = setTimeout(connect, 1000);
      });
    };

    connect();

    return () => {
      this.stopped = true;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === 0)) {
        this.ws.close(1000, "client stop");
      }
    };
  }
}
