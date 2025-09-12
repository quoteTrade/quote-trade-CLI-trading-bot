import WebSocket from "ws";
import * as dotenv from "dotenv";
import EventEmitter from "node:events";
import {MAGENTA, RESET} from "../ANSI";
dotenv.config();

/**
 * Map raw ORDER_TRADE_UPDATE payload (feed.o) -> normalized OrderUpdate.
 * NOTE: The React code groups by various FIX-like codes (X, x, o, etc).
 * We derive statuses conservatively:
 * - REJECTED if ordStatus (X) === '8'
 * - CANCELED if ordStatus (X) === '4'
 * - FILLED   if ordStatus (X) === '2' OR (execType in ['B','C','F'] and leavesQty==0 and cumQty>0)
 * - PARTIALLY_FILLED if execType in ['B','C','F'] and cumQty>0 and leavesQty>0
 * - otherwise NEW
 */
function mapOrderTrade(o: any): any | null {
    if (!o) return null;
    const symbol = (o.s ?? '')?.split('/')[0];
    const side = (o.S === "BUY" || o.S === "SELL") ? o.S : (o.S === "1" ? "BUY" : o.S === "2" ? "SELL" : "BUY");
    const clientOrderId = String(o.c ?? "");
    const orderId = o.i ? String(o.i) : undefined;
    const ordStatus = String(o.X ?? ""); // e.g. '2' filled, '4' canceled, '8' rejected
    const execType  = String(o.x ?? ""); // e.g. 'F' trade
    const execId  = String(o.t ?? "");
    const cumQty    = o.z != null ? String(o.z) : undefined;
    const leavesQty = typeof o.lv === "number" ? o.lv : Number(o.lv ?? 0);
    const qty   = o.q != null ? String(o.q) : undefined;
    const lastQty   = o.l != null ? String(o.l) : undefined;
    const price    = o.p != null ? String(o.p) : undefined;
    const lastPx    = o.L != null ? String(o.L) : undefined;
    const avgPx     = o.a != null ? String(o.a) : undefined;
    const reason    = o.br != null ? String(o.br) : undefined;
    const ts        = o.T;

    let status = "NEW";
    if (ordStatus === "8") status = "REJECTED";
    else if (ordStatus === "4") status = "CANCELED";
    else if (ordStatus === "2") status = "FILLED";
    else {
        const traded = ["B", "C", "F"].includes(execType);
        const cum = Number(cumQty ?? 0);
        if (traded && cum > 0 && leavesQty > 0) status = "PARTIALLY_FILLED";
        if (traded && cum > 0 && leavesQty === 0) status = "FILLED";
    }

    return {
        type: "orderUpdate",
        clientOrderId,
        execId,
        orderId,
        symbol,
        side: side as "BUY"|"SELL",
        status,
        quantity: qty,
        filledQty: lastQty,
        fillPrice: lastPx,
        price: price,
        cumQty,
        avgFillPrice: avgPx,
        reason,
        ts,
    };
}

/**
 * Map ACCOUNT_UPDATE payload to PositionUpdate(s).
 * React code merges a.B and a.P and uses pa (position amount) or wb (wallet balance).
 * For trading symbols (BTC, ETH...), we prefer pa (position amount) if present;
 * otherwise wb as a fallback. We skip non-trading symbols like USD/USDC/USDT.
 */
function mapAccountPositions(feed: any): any[] {
    const a = feed?.a ?? {};
    const rows = [...(a.B ?? []), ...(a.P ?? [])];
    const out: any[] = [];
    for (const r of rows) {
        const symbol = (r.s ?? r.a)?.split('/')[0];
        if (!symbol || ["USD","USDC","USDT"].includes(symbol)) continue;
        const pa = r.pa != null ? Number(r.pa) : undefined; // position amt (preferred)
        const wb = r.wb != null ? Number(r.wb) : undefined; // wallet bal (fallback)
        const qty = (pa != null ? pa : (wb != null ? wb : 0));
        const avg = r.uacb != null ? String(r.uacb) : undefined; // avg cost basis if available
        out.push({
            type: "positionUpdate",
            symbol,
            netQty: String(qty),
            avgEntryPrice: avg,
            ts: feed.E ?? feed.T,
        });
    }
    return out;
}

export class ListenKeyFeedBus extends EventEmitter {
    private ws?: WebSocket;
    private reconnecting = false;

    start() {
        const url = process.env.LISTEN_KEY_WS_URL || '';
        this.ws = new WebSocket(url);

        this.ws.on("open", () => {
            // If your server needs a subscribe message, send it here.
            // Example (adjust to your backend’s protocol):
            console.log(`🔌 ${MAGENTA} Connected: ListenKey WebSocket is now open${RESET}`);
            this.ws?.send(JSON.stringify({
                "account": "",
                "unsubscribe": 0,
                "requestToken": `${process.env.TRADE_API_KEY}`,
                "channel": 'LIQUIDITY'
            }));
        });

        this.ws.on("message", (raw: WebSocket.RawData) => {
            try {
                const data: any = JSON.parse(raw.toString()) as any;
                const evt = data?.e;
                // console.log(evt, data);

                if (data.userId) {
                    console.log(`📡 ${MAGENTA} Subscribed to listen key feed${RESET}`);
                }

                if (evt === "ACCOUNT_UPDATE" && data?.a) {
                    const pos = mapAccountPositions(data);
                    for (const p of pos) this.emit("positionUpdate", p);
                    return;
                }

                if (evt === "ORDER_TRADE_UPDATE" && data?.o) {
                    const u = mapOrderTrade(data.o);
                    if (u) this.emit("orderUpdate", u);
                    return;
                }
            } catch (err: any) {
                // ignore non-JSON frames / heartbeats
                console.error("❌ Liquidity feed message error:", err.message || err);
            }
        });

        this.ws.on("close", () => this.scheduleReconnect());
        this.ws.on("error", () => this.scheduleReconnect());
    }

    private scheduleReconnect() {
        if (this.reconnecting) return;
        this.reconnecting = true;
        this.emit("log", "🔁 WS closed — reconnecting in 1s…");
        setTimeout(() => { this.reconnecting = false; this.start(); }, 1000);
    }
}
