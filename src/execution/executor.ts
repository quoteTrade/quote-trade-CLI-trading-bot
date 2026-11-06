import { GREEN, RED, RESET } from "../ANSI";
import { HttpSvc } from "../services/http.service";
import {
  type ApiOrderSide,
  type SubmitOrderRequest,
  type SubmitOrderResult,
  toQuoteTradeSide,
} from "../triggers/types";
import type { Executor } from "../types";

interface QuoteTradeOrderPayload {
  liquidityOrder: 1;
  symbol: string;
  side: ApiOrderSide;
  type: SubmitOrderRequest["type"];
  quantity: number;
  paymentCurrency: string;
  timestamp: number;
  price?: number;
  account?: number;
  clientOrderId?: string;
  reduceOnly?: boolean;
  disableLeverage?: 0 | 1;
}

function parseAccount(value: string | number | undefined): number | undefined {
  if (value === undefined || String(value).trim() === "") return undefined;
  const account = Number(value);
  if (!Number.isSafeInteger(account) || account <= 0) {
    throw new Error("TRADE_ACCOUNT_ID must be a positive integer");
  }
  return account;
}

export class TradeExecutor implements Executor {
  private mode = (process.env.MODE ?? "paper").toLowerCase();

  async submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResult> {
    const configuredAccount = req.account ?? process.env.TRADE_ACCOUNT_ID ?? process.env.QUOTE_TRADE_ACCOUNT_ID;
    const account = parseAccount(configuredAccount);
    if (this.mode === "real" && account === undefined) {
      throw new Error("TRADE_ACCOUNT_ID is required when MODE=real");
    }
    const formattedReq: QuoteTradeOrderPayload = {
      liquidityOrder: 1,
      symbol: req.symbol,
      side: toQuoteTradeSide(req.side),
      type: req.type,
      quantity: Number(req.quantity),
      paymentCurrency: req.paymentCurrency ?? "USD",
      disableLeverage: req.disableLeverage === false || req.disableLeverage === 0 ? 0 : 1,
      timestamp: Date.now(),
    };
    if (req.type === "LIMIT" && req.price !== undefined) formattedReq.price = req.price;
    if (account !== undefined) formattedReq.account = account;
    if (req.clientOrderId !== undefined) formattedReq.clientOrderId = req.clientOrderId;
    if (req.reduceOnly !== undefined) formattedReq.reduceOnly = req.reduceOnly;

    if (this.mode !== "real") {
      console.log(
        `[PAPER] would submit ${req.type} ${req.side} ${req.symbol} qty=${req.quantity} price=${req.price ?? "MARKET"}`,
      );
      return { clientOrderId: req.clientOrderId ?? `paper_${Date.now()}`, paper: true, raw: formattedReq };
    }

    const resp = await HttpSvc.post("/order", formattedReq);
    if (
      Number(resp?.code) < 0 ||
      resp?.error ||
      resp?.success === false ||
      String(resp?.status ?? "").toUpperCase() === "REJECTED"
    ) {
      throw new Error(
        `Quote.Trade rejected the order: ${resp?.msg ?? resp?.error ?? resp?.rejectReason ?? resp?.message ?? resp?.status}`,
      );
    }
    return {
      orderId: resp?.orderId ? String(resp.orderId) : undefined,
      clientOrderId: resp?.clientOrderId ? String(resp.clientOrderId) : req.clientOrderId,
      raw: resp,
    };
  }

  async buy(symbol: string, quantity: string, price: number, reason: string): Promise<SubmitOrderResult> {
    console.log(`⏳ ${GREEN}[BUY SIGNAL]${RESET} ${symbol} price=${price.toFixed(2)} reason=${reason}`);
    return this.submitOrder({
      symbol,
      side: "BUY",
      type: "MARKET",
      quantity: Number(quantity),
      paymentCurrency: "USD",
    });
  }

  async sell(symbol: string, quantity: string, price: number, reason: string): Promise<SubmitOrderResult> {
    console.log(`⏳ ${RED}[SELL SIGNAL]${RESET} ${symbol} price=${price.toFixed(2)} reason=${reason}`);
    return this.submitOrder({
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: Number(quantity),
      paymentCurrency: "USD",
    });
  }
}
