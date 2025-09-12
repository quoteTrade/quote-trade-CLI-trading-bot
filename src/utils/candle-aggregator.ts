import { Candle, Tick } from "../types";

export class CandleAggregator {
    private cur: Candle | null = null;

    constructor(
        private intervalMs: number,
        private onClose: (c: Candle) => void
    ) {}

    ingest(t: Tick) {
        const bucketStart = Math.floor(t.ts / this.intervalMs) * this.intervalMs;
        const bucketEnd = bucketStart + this.intervalMs;

        if (!this.cur || t.ts >= this.cur.end) {
            if (this.cur) this.onClose(this.cur); // close previous candle
            this.cur = {
                start: bucketStart,
                end: bucketEnd,
                open: t.price,
                high: t.price,
                low: t.price,
                close: t.price,
                orderBook: t.orderBook,
            };
            return;
        }

        // Update OHLC
        this.cur.high = Math.max(this.cur.high, t.price);
        this.cur.low = Math.min(this.cur.low, t.price);
        this.cur.close = t.price;
        this.cur.orderBook = t.orderBook;
    }

    flush() {
        if (this.cur) {
            this.onClose(this.cur);
            this.cur = null;
        }
    }
}
