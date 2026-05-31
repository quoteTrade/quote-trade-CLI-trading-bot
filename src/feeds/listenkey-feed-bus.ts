import EventEmitter from "node:events";
import * as dotenv from "dotenv";
import WebSocket from "ws";
import { MAGENTA, RESET } from "../ANSI";
import { getSigningContext } from "../auth/signing-context";

dotenv.config();

function normalizePositionUpdate(feed: any): any[] {
  const account = feed?.a ?? feed?.account ?? feed;
  return [...(account?.P || []), ...(account?.positions || [])]
    .map((item: any) => ({
      ...item,
      symbol: item.s ?? item.a ?? item.symbol,
      quantity: item.pa ?? item.quantity,
      availableQuantity: item.aq ?? item.availableQuantity ?? item.pa ?? item.quantity,
      avgEntryPrice: item.ep ?? item.avgEntryPrice ?? item.uacb,
      markPrice: item.m ?? item.markPrice ?? item.sm,
    }))
    .filter((item: any) => item.symbol);
}

function mapOrderTrade(order: any): any | null {
  if (!order) return null;

  return {
    symbol: String(order.s ?? order.symbol ?? "").split("/")[0],
    side: order.S === "BUY" || order.S === "1" ? "BUY" : "SELL",

    timestamp: typeof order.T === "number" ? order.T : Date.now(),

    lastPx: order.L != null ? String(order.L) : undefined,
    avgPx: order.a != null ? String(order.a) : undefined,
    clientOrderId: String(order.c ?? order.clientOrderId ?? ""),
    timeInForce: order.f != null ? String(order.f) : undefined,
    orderId: order.i ? String(order.i) : undefined,
    lastQty: order.l != null ? String(order.l) : undefined,

    quantity: order.q != null ? String(order.q) : undefined,
    price: order.p != null ? String(order.p) : undefined,
    price2: order.p2 != null ? String(order.p2) : undefined,

    ordType: order.o != null ? String(order.o) : undefined,
    orderType: order.o != null ? String(order.o) : undefined,
    type: order.o != null ? String(order.o) : undefined,

    ordStatus: order.X != null ? String(order.X) : String(order.status ?? "NEW"),
    status: order.X != null ? String(order.X) : String(order.status ?? "NEW"),

    execType: order.x != null ? String(order.x) : undefined,
    orderRejectReason: order.r != null ? String(order.r) : undefined,

    cumQty: order.z != null ? String(order.z) : undefined,
    execId: order.t ? String(order.t) : undefined,
    leavesQty: order.lv != null ? Number(order.lv) : undefined,

    fillPrice: order.L ?? order.a,
    raw: order,
  };
}

export class ListenKeyFeedBus extends EventEmitter {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;

  start(): void {
    const url = process.env.LISTEN_KEY_WS_URL || "";
    this.stopped = false;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      console.log(` ${MAGENTA}Connected: listen-key WebSocket${RESET}`);
      this.ws?.send(JSON.stringify({
        unsubscribe: 0,
        requestToken: getSigningContext().apiKey ?? process.env.TRADE_API_KEY ?? "",
      }));
    });

    this.ws.on("message", (data: WebSocket.RawData) => {
      try {
        const feed = JSON.parse(data.toString());
        if (feed.e === "ORDER_TRADE_UPDATE" || feed.o) {
          const update = mapOrderTrade(feed.o ?? feed);
          if (update) this.emit("orderUpdate", update);
        }
        if (feed.e === "ACCOUNT_UPDATE" || feed.a?.P || feed.a?.B || feed.positions) {
          for (const position of normalizePositionUpdate(feed)) this.emit("positionUpdate", position);
        }
      } catch (error) {
        this.emit("error", error);
      }
    });

    this.ws.on("close", () => {
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.start(), 1000);
    });
    this.ws.on("error", (error: any) => this.emit("error", error));
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === 0)) {
      this.ws.close(1000, "client stop");
    }
  }
}
