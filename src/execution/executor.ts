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
  account?: string;
  clientOrderId?: string;
  reduceOnly?: boolean;
  disableLeverage?: 0 | 1;
}

export class TradeExecutor implements Executor {
  private mode = (process.env.MODE ?? "paper").toLowerCase();

  async submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResult> {
    const formattedReq: QuoteTradeOrderPayload = {
      liquidityOrder: 1,
      symbol: req.symbol,
      side: toQuoteTradeSide(req.side),
      type: req.type,
      quantity: Number(req.quantity),
      paymentCurrency: req.paymentCurrency ?? "USD",
      timestamp: Date.now(),
    };
    if (req.type === "LIMIT" && req.price !== undefined) formattedReq.price = req.price;
    if (req.account !== undefined) formattedReq.account = req.account;
    if (req.disableLeverage !== undefined) formattedReq.disableLeverage = req.disableLeverage ? 1 : 0;
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
