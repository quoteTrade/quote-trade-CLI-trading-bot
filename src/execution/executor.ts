import { Executor } from "../types";
import {GREEN, RED, RESET} from "../ANSI";
import {HttpSvc} from "../services/http.service";
import axios from "axios";

/** Replace with real REST calls to your backend when ready */
export class TradeExecutor implements Executor {
    private mode = (process.env.MODE ?? "paper").toLowerCase(); // "paper" | "real"

    async buy(symbol: string, quantity: string, price: number, reason: string): Promise<any> {
        if (this.mode !== "real") {
            console.log(`🧪 [PAPER] ${GREEN}[BUY SIGNAL]${RESET} ${symbol} | price: ${price.toFixed(2)} | reason: ${reason}`);
            return null;
        } else {
            console.log(`⏳  [REAL] ${GREEN}[BUY SIGNAL]${RESET} ${symbol} | price: ${price.toFixed(2)} | reason: ${reason}`);
        }

        const formattedReq = {
            "liquidityOrder": 1,
            "symbol": symbol,
            "side": "BUY",
            "type": "MARKET",
            // "price": price,
            "quantity": Number(quantity),
            "paymentCurrency": "USD",
            "timestamp": new Date().getTime(),
        };

        try {
            const resp: any = await HttpSvc.post(`/order`, formattedReq, {});
            console.log(`📤  ${GREEN}SUBMIT • BUY${RESET} ${symbol} quantity=${quantity} (${reason}) clientId=${resp.clientOrderId}`);
            return resp;
        } catch (error: any) {
            console.error(`❌ SUBMIT FAILED •  BUY - ${error?.error || (error?.message || 'UNKNOWN_ERROR')}`);
            return null;
        }
    }

    async sell(symbol: string, quantity: string, price: number, reason: string): Promise<any> {
        if (this.mode !== "real") {
            console.log(`🧪 [PAPER] ${RED}[SELL SIGNAL]${RESET} ${symbol} | price: ${price.toFixed(2)} | reason: ${reason}`);
            return null;
        } else {
            console.log(`⏳  [REAL] ${RED}[SELL SIGNAL]${RESET} ${symbol} | price: ${price.toFixed(2)} | reason: ${reason}`);
        }

        const formattedReq = {
            "liquidityOrder": 1,
            "symbol": symbol,
            "side": "SEL",
            "type": "MARKET",
            // "price": price,
            "quantity": Number(quantity),
            "paymentCurrency": "USD",
            "timestamp": new Date().getTime(),
        };

        try {
            const resp: any = await HttpSvc.post(`/order`, formattedReq, {});
            console.log(`📤  ${RED}SUBMIT • SELL${RESET} ${symbol} quantity=${quantity} (${reason}) clientId=${resp.clientOrderId}`);
            return resp;
        } catch (error: any) {
            console.error(`❌ SUBMIT FAILED • SELL - ${error?.error || (error?.message || 'UNKNOWN_ERROR')}`);
            return null;
        }
    }
}
