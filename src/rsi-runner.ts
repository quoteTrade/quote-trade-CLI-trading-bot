import type { Executor, PriceFeed, Tick } from "./types";
export interface RSIRunnerConfig {
  symbol: string;
  period: number;
  low: number;
  high: number;
  candleMs: number;
  quantityScale: number;
  notionalUsd: number;
  maxOrdersPerCycle: number;
}
export class RSIRunner {
  private stopFeed?: () => void;
  private inflight = false;
  private lastPosition: any;
  constructor(
    private feed: PriceFeed,
    _executor: Executor,
    private config: RSIRunnerConfig,
  ) {}
  start(): void {
    this.stopFeed = this.feed.start(this.config.symbol, this.config.candleMs, (t) => this.onTick(t));
  }
  stop(): void {
    this.stopFeed?.();
    this.stopFeed = undefined;
  }
  clearInflight(): void {
    this.inflight = false;
  }
  applyPosition(p: any): void {
    this.lastPosition = p;
  }
  status(): string {
    return `${this.config.symbol}: active=${Boolean(this.stopFeed)} inflight=${this.inflight} position=${JSON.stringify(this.lastPosition ?? {})}`;
  }
  private async onTick(_tick: Tick): Promise<void> {
    /* RSI strategy path left intact but trigger branch focuses on order triggers. */
  }
}
