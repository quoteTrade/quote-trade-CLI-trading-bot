# 📈 Quote.Trade CLI Bot — RSI Strategy (Headless)

A **Node.js + TypeScript** command‑line trading bot.  
It connects to your Quote.Trade backend over **WebSocket** to stream liquidity + account updates, aggregates **candles**, computes **RSI**, and submits orders via your executor.

- ✅ **Order size in USD** via `--notionalUsd`
- ✅ **Two‑step signals per band**: *flatten → reverse* (max **2 orders/cycle**)
- ✅ **WS‑driven state**: show **positions** on start & on change; print **fills/partials/rejects**
- ✅ **Depth-aware** checks using the order book snapshot carried with each candle
- ✅ **Three auth modes**: API keys, existing wallet, or freshly generated wallet
- ✅ **Ed25519 signing** support alongside the default HMAC-SHA256
- ✅ Works on Linux/macOS and Windows (PowerShell & CMD)

---

## 📦 Prerequisites
- **Node.js** v18+
- **npm**

---

## 🔧 Install
```bash
git clone https://github.com/solfini-org/command-line-trading-bot
cd command-line-trading-bot
npm install
```

---

## ⚙️ Configure

Create a `.env` from `sample.env` and fill in your endpoints/credentials.

```env
API_BASE_URL=https://app.quote.trade/api
LIQUIDITY_WS_URL=wss://app.quote.trade/ws/liquidity
LISTEN_KEY_WS_URL=wss://app.quote.trade/ws/listenKey

# ── Auth Mode A: SHA256 API keys (registered via UI) ──────────────────────────
TRADE_API_KEY=
TRADE_API_SECRET=

MODE=real    # "paper" → log only, "real" → execute trades

# ── Auth Mode B: Existing wallet ───────────────────────────────────────────────
# WALLET_PRIVATE_KEY=0x<your-ethereum-private-key>

# ── Signing algorithm (optional, default: sha256) ─────────────────────────────
# SIGNING_ALGORITHM=sha256   # sha256 | ed25519

# ── Ed25519 public key to attach on registration (optional) ───────────────────
# ED25519_PUBLIC_KEY=-----BEGIN PUBLIC KEY----- MCow... -----END PUBLIC KEY-----

# ── Deposit (ERC-20) ──────────────────────────────────────────────────────────
# DEPOSIT_NETWORK=mainnet    # mainnet | sepolia | polygon | amoy
# DEPOSIT_RPC_URL=https://eth.merkle.io
# USDC_CONTRACT_ADDRESS=
# USDT_CONTRACT_ADDRESS=
```

> `LISTEN_KEY_WS_URL` is used for account/order events (positions, fills, rejections).  
> `LIQUIDITY_WS_URL` is your market data (order book / ticks).

---

## 🧰 NPM Scripts

```json
{
  "scripts": {
    "dev":   "ts-node src/cli.ts",
    "build": "tsc -p .",
    "start": "node dist/cli.js",
    "cli":   "node dist/cli.js",
    "help":  "node dist/cli.js -- help"
  }
}
```

- **dev** — run TypeScript directly (no build step)
- **build** — compile to `dist/`
- **cli** — run the compiled CLI
- **help** — show the built-in command help (after `build`)

> When using `npm run`, remember the `--` separator before CLI args.

---

## 🔐 Auth Modes

The bot supports three mutually exclusive authentication modes, evaluated in priority order:

### Mode A — SHA256 API keys (fastest)
Set `TRADE_API_KEY` and `TRADE_API_SECRET` in `.env` (obtained from the platform UI or after running `register`). No wallet interaction needed.

### Mode B — Existing wallet
Set `WALLET_PRIVATE_KEY` in `.env`, then pass `--existing-wallet`. The bot derives your address, calls `getChallenge → sign → registerUser` (if new) → `logon`, and prints your SHA256 API keys for future use.

### Mode C — New wallet (no prior keys)
Pass `--create-wallet`. The bot generates a fresh Ethereum wallet, registers it, and prints the wallet private key + SHA256 API keys. **Save them immediately.**

---

## 🔑 Signing Algorithms

Both algorithms use the same `TRADE_API_KEY` / `TRADE_API_SECRET` env vars. `SIGNING_ALGORITHM` (or `--signing-algorithm`) controls how `TRADE_API_SECRET` is interpreted.

| Algorithm | `TRADE_API_SECRET` value | Signature format |
|-----------|--------------------------|-----------------|
| `sha256` (default) | HMAC key string | `HMAC-SHA256(secret, payload)` → hex |
| `ed25519` | Base64 body of PKCS#8 private key (no PEM headers) | `Ed25519.sign(key, payload)` → base64 |

**To set up Ed25519 signing:**
1. Register with `--generate-ed25519-key` — prints **KEY SET 1** (SHA256) and **KEY SET 2** (Ed25519).
2. Set `TRADE_API_KEY` = Ed25519 API key (from KEY SET 2).
3. Set `TRADE_API_SECRET` = base64 body of the private key (from KEY SET 2, no PEM headers).
4. Set `SIGNING_ALGORITHM=ed25519` in `.env`.

---

## 🌐 Global Options

These options apply to every command:

| Option | Description |
|--------|-------------|
| `--debug` | Enable debug logging for auth steps (no secrets printed) |
| `--auth-base-url <url>` | Override `API_BASE_URL` for wallet auth (e.g. `https://app.quote.trade/api`) |
| `--signing-algorithm <sha256\|ed25519>` | Override `SIGNING_ALGORITHM` from `.env` |

---

## 🚀 Quick Start

```bash
npm run build

# Mode A — API keys already in .env:
npm run cli -- rsi:enable --symbol BTC

# Mode B — existing wallet in .env:
npm run cli -- rsi:enable --symbol BTC --existing-wallet

# Mode C — generate a new wallet on the fly:
npm run cli -- rsi:enable --symbol BTC --create-wallet
```

---

## 📋 Commands

### `register`

Standalone registration — obtain SHA256 (and optionally Ed25519) API keys without starting the bot.

```bash
# New wallet:
npm run cli -- register --create-wallet

# Existing wallet from .env:
npm run cli -- register --existing-wallet

# New wallet + generate an Ed25519 key pair and attach it:
npm run cli -- register --create-wallet --generate-ed25519-key

# Existing wallet + provide your own Ed25519 public key:
npm run cli -- register --existing-wallet \
  --ed25519-public-key "-----BEGIN PUBLIC KEY----- MCow... -----END PUBLIC KEY-----" \
  --ed25519-public-key-name "MyBot"

# Existing wallet + Ed25519 public key from a file:
npm run cli -- register --existing-wallet \
  --ed25519-public-key ./keys/ed25519_pub.pem
```

**Options**

| Option | Description |
|--------|-------------|
| `--create-wallet` | Generate a new Ethereum wallet, register it, and print credentials |
| `--existing-wallet` | Use `WALLET_PRIVATE_KEY` from `.env` to register and obtain API keys |
| `--ed25519-public-key <key>` | Ed25519 public key to attach (PEM string, base64 DER, or file path) |
| `--ed25519-public-key-name <name>` | Human-readable key name (default: `QuoteTrade-BOT`) |
| `--generate-ed25519-key` | Generate a new Ed25519 key pair, print it, and attach the public key |

> After registration the bot prints **KEY SET 1** (SHA256 keys) and, if an Ed25519 key was attached, **KEY SET 2** (Ed25519 API key + private key reminder). Save both sets to `.env`.

---

### `rsi:enable`

Start an RSI strategy runner for a symbol.

```bash
npm run build
npm run cli -- rsi:enable --symbol BTC

# With custom parameters:
npm run cli -- rsi:enable \
  --symbol BTC \
  --notionalUsd 100 \
  --timeframe 1m \
  --period 14 \
  --low 30 \
  --high 70 \
  --maxOrdersPerCycle 2

# New wallet + Ed25519 signing in one step:
npm run cli -- rsi:enable --symbol BTC --create-wallet \
  --generate-ed25519-key --signing-algorithm ed25519
```

**Options**

| Option | Default | Description |
|--------|---------|-------------|
| `--symbol <SYMBOL>` | *(required)* | Trading symbol, e.g. `BTC` |
| `--notionalUsd <USD>` | `20` | Order size in USD |
| `--timeframe <TF>` | `1m` | Candle timeframe: `1m\|5m\|15m\|1h\|4h\|1d` |
| `--period <N>` | `14` | RSI period |
| `--low <N>` | `30` | Oversold threshold |
| `--high <N>` | `70` | Overbought threshold |
| `--maxOrdersPerCycle <N>` | `2` | Per-band order cap (flatten + reverse) |
| `--create-wallet` | — | Generate a new wallet, register, then start trading |
| `--existing-wallet` | — | Use `WALLET_PRIVATE_KEY` from `.env` to authenticate |
| `--ed25519-public-key <key>` | — | Attach Ed25519 key on registration |
| `--ed25519-public-key-name <name>` | `QuoteTrade-BOT` | Name for the Ed25519 key |
| `--generate-ed25519-key` | — | Generate + attach a new Ed25519 key pair |

---

### `rsi:disable`

Stop the RSI runner for a symbol.

```bash
npm run cli -- rsi:disable --symbol BTC
```

---

### `rsi:status`

Show the current status of one or all active runners.

```bash
npm run cli -- rsi:status              # all runners
npm run cli -- rsi:status --symbol BTC # specific runner
```

---

### `rsi:list`

List all active runner symbols.

```bash
npm run cli -- rsi:list
```

---

### `deposit`

Deposit USDC or USDT to your trading account via ERC-20 transfer (same flow as the Telegram bot). Requires wallet auth (`WALLET_PRIVATE_KEY` or `--create-wallet`).

```bash
npm run cli -- deposit --amount 100 --currency USDC --existing-wallet
npm run cli -- deposit --amount 50  --currency USDT --create-wallet
```

**Options**

| Option | Description |
|--------|-------------|
| `--amount <number>` | *(required)* Amount to deposit, e.g. `100` |
| `--currency <USDC\|USDT>` | *(required)* Token to deposit |
| `--create-wallet` | Generate a new wallet, register, then deposit |
| `--existing-wallet` | Use `WALLET_PRIVATE_KEY` from `.env` |

**Deposit `.env` config**

| Variable | Description |
|----------|-------------|
| `DEPOSIT_NETWORK` | `mainnet`, `sepolia`, `polygon`, or `amoy` (default: `mainnet`) |
| `DEPOSIT_RPC_URL` | Optional RPC URL for the network |
| `USDC_CONTRACT_ADDRESS` | ERC-20 contract address for USDC on the chosen network |
| `USDT_CONTRACT_ADDRESS` | ERC-20 contract address for USDT on the chosen network |

> Native token symbol adjusts automatically: ETH for Ethereum/Sepolia, POL for Polygon/Amoy.

---

### `help`

Print the full built-in help text.

```bash
npm run cli -- help
# or
npm run help
```

---

## 📐 Strategy Behavior

- **Oversold (RSI < low)**
    1. **BUY** to **flatten** an existing **SHORT** (if any).
    2. After **neutral re‑arm**, **BUY** to **open LONG** using `--notionalUsd`.

- **Overbought (RSI > high)**
    1. **SELL** to **flatten** an existing **LONG**.
    2. After **neutral re‑arm**, **SELL** to **open SHORT** using `--notionalUsd`.

- **Re‑arm rule**: after any order, RSI must return to **neutral** (`low ≤ RSI ≤ high`) before the next order on the same band can fire.
- **Inflight gating**: after submit, the bot **waits** for a **terminal WS update** (`FILLED` / `REJECTED` / `CANCELED` / `EXPIRED`) before submitting another order.
- **Per‑cycle cap**: at most **2 orders** per band cycle (flatten + reverse).

---

## 🔌 WebSocket Events

- **Liquidity feed** → ticks & order book (used for mid‑price, best bid/ask, and depth checks).
- **ListenKey feed** → position updates + order updates (fills, partials, rejects).  
  On start/reconnect, servers may replay **recent order history**. The bot deduplicates and uses WS **positions** as the source of truth so state remains correct even after a replay burst.

---

## 🪵 Example Logs

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

| Symptom | Fix |
|---------|-----|
| `required option '--symbol' not specified` | Include `--symbol BTC` and remember the `--` separator after `npm run cli` |
| `No credentials found` | Set `TRADE_API_KEY` + `TRADE_API_SECRET` in `.env`, or pass `--existing-wallet` / `--create-wallet` |
| `Wallet login failed` | Ensure `WALLET_PRIVATE_KEY` is a valid `0x`-prefixed Ethereum private key |
| No trades happen | Check WS connectivity; verify RSI actually crosses bands; check symbol and market depth |
| Ed25519 signing fails | Ensure `TRADE_API_SECRET` contains only the base64 body (no PEM headers); set `SIGNING_ALGORITHM=ed25519` |
| **Windows PowerShell** | Same syntax as Linux/macOS; ensure `--` separator is present |

---

## 📄 License
MIT
