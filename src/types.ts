export type OrderBookLevel = { p: number; dp?: number; q?: number };

export type OrderBookMessage = {
    s: string;           // symbol, e.g., "BTC"
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
};

export type Tick = { ts: number; price: number, orderBook: OrderBookMessage };

export type Candle = {
    start: number; // ms epoch (bucket start)
    end: number;   // ms epoch (bucket end, exclusive)
    open: number;
    high: number;
    low: number;
    close: number;
    orderBook: OrderBookMessage;
};

export interface PriceFeed {
    start(symbol: string, candleMs: number, onTick: (t: Tick) => void): () => void; // returns stop()
    on(event: "orderBookUpdate", listener: (book: OrderBookMessage) => void): this;
}

export interface Executor {
    buy(symbol: string, quantity: string, price: number, reason: string): Promise<any>;
    sell(symbol: string, quantity: string, price: number, reason: string): Promise<any>;
}
