import {HttpSvc} from "../services/http.service";
import {RED, RESET} from "../ANSI";

export function calculateRSI(closes: number[], period = 14): number | null {
    if (closes.length < period + 1) return null;

    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
}

export async function getInstrumentMeta(symbol: string): Promise<any> {
    try {
        const data: any = await HttpSvc.get(`/getInstrumentPairs`, {});
        const upper = symbol.toUpperCase();
        // return data.instrumentPairs?.some((p: any) => p.symbol.toUpperCase() === upper);
        return (data.instrumentPairs || []).find((p: any) => p.symbol.toUpperCase() === upper) ?? null;
    } catch (error: any) {
        console.log(`${RED} ❌ Failed to fetch instrument pairs (${error.message})${RESET}`);
        return false;
    }
}

export function tfToMs(tf: string): number {
    const s = tf.trim().toLowerCase();
    const n = parseInt(s, 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid timeframe: ${tf}`);
    if (s.endsWith("m")) return n * 60_000;
    if (s.endsWith("h")) return n * 3_600_000;
    if (s.endsWith("d")) return n * 86_400_000;
    throw new Error(`Unsupported timeframe unit in: ${tf} (use 1m|5m|15m|1h|4h|1d)`);
}

export function toQtyFromUsd(notionalUsd: number, price: number, quantityScale: number): string {
    if (notionalUsd <= 0) throw new Error("notionalUsd must be > 0");
    if (price <= 0) throw new Error("price must be > 0");
    const raw = notionalUsd / price;
    const factor = 10 ** quantityScale;
    const floored = Math.floor(raw * factor) / factor;
    return floored.toFixed(quantityScale);
}

export function getMaxMatchingPrices(orderBook: any, quantity: number): any {
    // Filter bids and asks where the quantity (q) is greater than or equal to the input quantity
    const bid = orderBook.bids?.find((bid: any) => bid.q >= quantity) || {};
    const ask = orderBook.asks?.find((ask: any) => ask.q >= quantity) || {};

    return { s: orderBook.s, bid, ask };
}