import { GREEN, RED, RESET } from "../ANSI";
import { HttpSvc } from "../services/http.service";
import { type SubmitOrderRequest, type SubmitOrderResult, toQuoteTradeSide } from "../triggers/types";
import type { Executor } from "../types";

export class TradeExecutor implements Executor {
  private mode = (process.env.MODE ?? "paper").toLowerCase();

  async submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResult> {
    const formattedReq: any = {
      liquidityOrder: 1,
      symbol: req.symbol,
      side: toQuoteTradeSide(req.side),
      type: req.type,
      quantity: Number(req.quantity),
      paymentCurrency: req.paymentCurrency ?? "USD",
      timestamp: Date.now(),
    };
    if (req.type === "LIMIT" && req.price !== undefined) formattedReq.price = req.price;

    if (this.mode !== "real") {
      console.log(
        `[PAPER] would submit ${req.type} ${req.side} ${req.symbol} qty=${req.quantity} price=${req.price ?? "MARKET"}`,
      );
      return { clientOrderId: req.clientOrderId ?? `paper_${Date.now()}`, paper: true, raw: formattedReq };
    }

    const resp = await HttpSvc.post("/order", formattedReq);
    return {
      orderId: resp?.orderId ? String(resp.orderId) : undefined,
      clientOrderId: resp?.clientOrderId ? String(resp.clientOrderId) : req.clientOrderId,
      raw: resp,
    };
  }

  async buy(symbol: string, quantity: string, price: number, reason: string): Promise<any> {
    console.log(`⏳ ${GREEN}[BUY SIGNAL]${RESET} ${symbol} price=${price.toFixed(2)} reason=${reason}`);
    return this.submitOrder({
      symbol,
      side: "BUY",
      type: "MARKET",
      quantity: Number(quantity),
      paymentCurrency: "USD",
    });
  }

  async sell(symbol: string, quantity: string, price: number, reason: string): Promise<any> {
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
