# 📈 Quote.Trade CLI Bot — RSI Strategy (Headless)

A **Node.js + TypeScript** command‑line trading bot.  
It connects to your Quote.Trade backend over **WebSocket** to stream liquidity + account updates, aggregates **candles**, computes **RSI**, and submits orders via your executor.

- ✅ **Order size in USD** via `--notionalUsd`
- ✅ **Two‑step signals per band**: *flatten → reverse* (max **2 orders/cycle**)
- ✅ **WS‑driven state**: show **positions** on start & on change; print **fills/partials/rejects**
- ✅ **Depth-aware** checks using the order book snapshot carried with each candle
- ✅ Works on Linux/macOS and Windows (PowerShell & CMD)

---

## 📦 Prerequisites
- **Node.js** v18+
- **npm**

---

## 🔧 Install
```bash
git clone https://github.com/quoteTrade/quote-trade-CLI-trading-bot
cd quote-trade-CLI-trading-bot
npm install
```

---

## ⚙️ Configure

Create a `.env` from `sample.env` and fill in your endpoints/creds:

```env
API_BASE_URL=https://app.quote.trade/api
LIQUIDITY_WS_URL=wss://app.quote.trade/ws/liquidity
LISTEN_KEY_WS_URL=wss://app.quote.trade/ws/listenKey

TRADE_API_KEY=
TRADE_API_SECRET=
MODE=real    # "paper" -> log only, "real" -> execute trades
```

> `LISTEN_KEY_WS_URL` is used for account/order events (positions, fills, rejections).  
> `LIQUIDITY_WS_URL` is your market data (order book / ticks).

---

## 🧰 NPM Scripts

```json
{
  "scripts": {
    "dev": "ts-node src/cli.ts",
    "build": "tsc -p .",
    "start": "node dist/cli.js",
    "help": "node dist/cli.js -- help",
    "cli": "node dist/cli.js"
  }
}
```

- **dev**: run TypeScript directly
- **build**: compile to `dist/`
- **cli**: run the compiled CLI
- **help**: show the built-in command help (after `build`)

> When using `npm run`, remember the `--` separator before CLI args.

---

## 🚀 Run (build first)

```bash
npm run build
npm run cli -- rsi:enable --symbol BTC
```

### Create wallet and run (no .env API keys)
Generate a new wallet, authenticate, then start the RSI runner. Save the printed private key for future runs.
```bash
npm run cli -- rsi:enable --symbol BTC --create-wallet
```

### With custom options
```bash
npm run cli -- rsi:enable   --symbol BTC   --notionalUsd 100   --timeframe 1m   --period 14   --low 30   --high 70   --maxOrdersPerCycle 2
```

With a new wallet:
```bash
npm run cli -- rsi:enable --symbol BTC --notionalUsd 100 --timeframe 1m --create-wallet
```

**Windows PowerShell** (same syntax):
```powershell
npm run build
npm run cli -- rsi:enable --symbol BTC --notionalUsd 100 --timeframe 1m --period 14 --low 30 --high 70 --maxOrdersPerCycle 2
```

---

## 🤖 Command: `rsi:enable`

Start an RSI strategy runner for a symbol.

**Required**
- `--symbol <SYMBOL>` — e.g., `BTC`

**Auth (global option)**
- `--create-wallet` — generate a new wallet, authenticate via challenge/sign, then run (no `TRADE_API_KEY` / `TRADE_API_SECRET` in .env). Save the printed private key and add to .env as `WALLET_PRIVATE_KEY` for next runs.
**Sizing**
- `--notionalUsd <USD>` — order size in USD (default: `20`)

**Signal logic**
- `--period <N>` — RSI length (default: `14`)
- `--low <N>` — Oversold band (default: `30`)
- `--high <N>` — Overbought band (default: `70`)
- `--timeframe <TF>` — `1m|5m|15m|1h|4h|1d` (default: `1m`)

**Cycle control**
- `--maxOrdersPerCycle <N>` — per‑band cap (default `2` = *flatten then reverse*)

---

## 💸 Command: `deposit`

Deposit USDC or USDT to your trading account via ERC-20 transfer (same flow as the telegram bot). Requires wallet auth (`WALLET_PRIVATE_KEY` or `--create-wallet`).

**Required**
- `--amount <number>` — amount to deposit (e.g. `100`)
- `--currency <USDC|USDT>` — token to deposit

**Config (in .env)**
- `DEPOSIT_NETWORK` — `mainnet`, `sepolia`, `polygon`, or `amoy` (default: `mainnet`). Native token symbol adjusts automatically (ETH for Ethereum/Sepolia, POL for Polygon/Amoy).
- `DEPOSIT_RPC_URL` — optional; RPC URL for the network
- `USDC_CONTRACT_ADDRESS` / `USDT_CONTRACT_ADDRESS` — ERC-20 contract addresses for the network

**Examples**
```bash
npm run cli -- deposit --amount 100 --currency USDC
npm run cli -- deposit --amount 50 --currency USDT --create-wallet
```

---

## 📐 Strategy behavior (client‑confirmed)

- **Oversold (RSI < low)**
    1) **BUY** to **flatten** an existing **SHORT** (if any).
    2) After **neutral re‑arm**, **BUY** to **open LONG** using `--notionalUsd`.

- **Overbought (RSI > high)**
    1) **SELL** to **flatten** an existing **LONG**.
    2) After **neutral re‑arm**, **SELL** to **open SHORT** using `--notionalUsd`.

- **Re‑arm rule**: after any order, RSI must return to **neutral** (`low ≤ RSI ≤ high`) before the next order on the same band can fire.
- **Inflight gating**: after submit, the bot **waits** for a **terminal WS update** (FILLED/REJECTED/CANCELED/EXPIRED) before submitting another order.
- **Per‑cycle cap**: at most **2 orders** per band cycle (flatten + reverse).

## 🔌 WebSocket events

- **Liquidity feed** → ticks & order book (used for mid‑price, best bid/ask, and depth checks).
- **ListenKey feed** → position updates + order updates (fills, partials, rejects).  
  On start/reconnect, servers may replay **recent order history**. The bot dedupes and uses WS **positions** as the source of truth so state remains correct even after a replay burst.

---

## 🪵 Example logs

```
🔌 Connected: Account WebSocket open
📦 Position • BTC: FLAT

⏳ [2025-09-05T08:00:00.000Z] Warming up — BTC 🕯️ C=108952.10
📊 [2025-09-05T08:01:00.000Z] BTC RSI=72.10 | O=... H=... L=... C=...

📤 SUBMIT • SELL BTC qty=0.001 reason="Flatten long (RSI 72.10 > 70)" (clientId=SELL-BTC-abc123)
✅ FILLED • SELL BTC qty=0.001 @ 108980.40 (orderId=789 | clientId=SELL-BTC-abc123)
🔄 Position changed • BTC: LONG → FLAT (qty 0.001 → 0)

⏭️  SKIPPED • BUY BTC qty=0.010 — insufficient-depth
↳ bestBid=108210.50 | bestAsk=108225.10 | levels=3 | vwap≈108230.40 | ref=108260.30 | drift=0.03%
```

---

## 🧪 Modes
- `MODE=paper` — log signals & order submits (no live trading)
- `MODE=real` — send live orders with your API key/secret

Make sure your executor reads `API_BASE_URL`, `TRADE_API_KEY`, `TRADE_API_SECRET`, and `MODE` from the environment.

---

## 🔍 Troubleshooting
- **“required option ‘--symbol’ not specified”** — include `--symbol BTC` (remember `--` after `npm run cli`).
- **Windows PowerShell** — same syntax as Linux/macOS; ensure `--` separator is present.
- **No trades happen** — check WS connectivity & that RSI actually crosses bands; verify symbol and market depth.

---

## 📄 License
MIT