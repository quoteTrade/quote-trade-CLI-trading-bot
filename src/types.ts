export interface Tick {
  ts: number;
  price?: number;
  bid?: number;
  ask?: number;
  bidQty?: number;
  askQty?: number;
  mark?: number;
  orderBook?: unknown;
}
export interface OrderBookLevel {
  p: number;
  q?: number;
  dp?: number;
}
export interface OrderBookMessage {
  s?: string;
  bids?: OrderBookLevel[];
  asks?: OrderBookLevel[];
  status?: string;
}
export interface PriceFeed {
  start(symbol: string, candleMs: number, onTick: (t: Tick) => void): () => void;
}
export interface Executor {
  buy(symbol: string, quantity: string, price: number, reason: string): Promise<any>;
  sell(symbol: string, quantity: string, price: number, reason: string): Promise<any>;
}
