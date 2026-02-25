
export const HelpText = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Quote.Trade CLI • RSI Strategy (Headless)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Usage:
  Quote.Trade-cli-bot <command> [options]

Global options:
  --debug                              Enable debug logging for auth steps (no secrets printed)
  --auth-base-url <url>                Override API_BASE_URL for wallet auth
                                       (e.g. https://app.quote.trade/api)
  --signing-algorithm <sha256|ed25519>
                                       Signing algorithm for API request headers.
                                       sha256  (default) — HMAC-SHA256(TRADE_API_SECRET, payload) → hex
                                                           X-Mbx-Apikey = TRADE_API_KEY
                                       ed25519           — Ed25519.sign(TRADE_API_SECRET, payload) → base64
                                                           X-Mbx-Apikey = TRADE_API_KEY
                                       Both modes use the same TRADE_API_KEY / TRADE_API_SECRET env vars.
                                       Overrides SIGNING_ALGORITHM in .env.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 AUTH MODES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Mode A — SHA256 API keys (registered via UI):
  Set TRADE_API_KEY and TRADE_API_SECRET in .env.
  No wallet interaction needed. Fastest path.

Mode B — Existing wallet (register via CLI):
  Set WALLET_PRIVATE_KEY in .env, then run:
    register --existing-wallet
  The bot derives your address, gets a challenge, signs it,
  registers (if new), logs in, and prints your SHA256 API keys.

Mode C — New wallet (register via CLI):
  No keys needed. Run:
    register --create-wallet
  The bot generates a fresh wallet, registers it, and prints
  the wallet private key + SHA256 API keys. Save them!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SIGNING ALGORITHMS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Both algorithms use the same TRADE_API_KEY and TRADE_API_SECRET env vars.
SIGNING_ALGORITHM controls how TRADE_API_SECRET is interpreted.

SHA256 (default):
  signature = HMAC-SHA256(TRADE_API_SECRET, payload) → hex
  X-Mbx-Apikey = TRADE_API_KEY
  TRADE_API_SECRET is an HMAC key string.
  Required .env: TRADE_API_KEY, TRADE_API_SECRET

Ed25519:
  signature = Ed25519.sign(TRADE_API_SECRET, payload) → base64
  X-Mbx-Apikey = TRADE_API_KEY
  TRADE_API_SECRET is the BASE64 BODY of the PKCS#8 private key
  (no -----BEGIN/END PRIVATE KEY----- headers — just the middle part).
  Required .env: TRADE_API_KEY (Ed25519 API key), TRADE_API_SECRET (base64 body only)
  SIGNING_ALGORITHM=ed25519

  To obtain Ed25519 credentials:
    1. Register with --generate-ed25519-key (prints KEY SET 1 + KEY SET 2)
    2. Set TRADE_API_KEY    = Ed25519 API key  (from KEY SET 2)
    3. Set TRADE_API_SECRET = base64 body of private key  (from KEY SET 2, no headers)
    4. Set SIGNING_ALGORITHM = ed25519

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 COMMANDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

register
  Register a new account and obtain SHA256 API keys.
  Options:
    --create-wallet                  Generate a new Ethereum wallet and register
    --existing-wallet                Use WALLET_PRIVATE_KEY from .env
    --ed25519-public-key <key>       Attach an Ed25519 public key (PEM, base64, or file path)
    --ed25519-public-key-name <name> Name for the Ed25519 key (default: QuoteTrade-BOT)
    --generate-ed25519-key           Generate a new Ed25519 key pair and attach it

rsi:enable
  Start the RSI trading strategy for a symbol.
  Options:
    --symbol <SYMBOL>          Required. e.g. BTC
    --notionalUsd <USD>        Order size in USD (default: 20)
    --timeframe <TF>           1m|5m|15m|1h|4h|1d (default: 1m)
    --period <N>               RSI period (default: 14)
    --low <N>                  Oversold threshold (default: 30)
    --high <N>                 Overbought threshold (default: 70)
    --maxOrdersPerCycle <N>    Max orders per band cycle (default: 2)
    --create-wallet            Generate a new wallet, register, then trade
    --existing-wallet          Use WALLET_PRIVATE_KEY from .env to authenticate
    --ed25519-public-key <key>       Attach Ed25519 key on registration
    --ed25519-public-key-name <name> Name for the Ed25519 key
    --generate-ed25519-key           Generate + attach a new Ed25519 key pair

deposit
  Deposit USDC or USDT via ERC-20 transfer.
  Options:
    --amount <number>          Required. Amount to deposit (e.g. 100)
    --currency <USDC|USDT>     Required. Currency to deposit
    --create-wallet            Generate a new wallet, register, then deposit
    --existing-wallet          Use WALLET_PRIVATE_KEY from .env

rsi:disable  --symbol <SYMBOL>    Stop RSI runner for a symbol
rsi:status   [--symbol <SYMBOL>]  Show runner status (all or specific)
rsi:list                          List active runner symbols
help                              Show this help message

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 EXAMPLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Register with a new wallet (no prior keys needed):
  npm run cli -- register --create-wallet

# Register with an existing wallet from .env:
  npm run cli -- register --existing-wallet

# Register with a new wallet + attach an Ed25519 key:
  npm run cli -- register --create-wallet --generate-ed25519-key

# Register with an existing wallet + provide your own Ed25519 key:
  npm run cli -- register --existing-wallet \\
    --ed25519-public-key "-----BEGIN PUBLIC KEY----- MCow... -----END PUBLIC KEY-----" \\
    --ed25519-public-key-name "MyBot"

# Register with an existing wallet + Ed25519 key from a file:
  npm run cli -- register --existing-wallet \\
    --ed25519-public-key ./keys/ed25519_pub.pem

# Trade using API keys from .env (Mode A — fastest, SHA256 signing):
  npm run cli -- rsi:enable --symbol BTC

# Trade using API keys from .env with Ed25519 signing:
  # (requires TRADE_API_KEY=<ed25519-api-key>, TRADE_API_SECRET=<base64-body>, SIGNING_ALGORITHM=ed25519 in .env)
  npm run cli -- rsi:enable --symbol BTC --signing-algorithm ed25519

# Trade using existing wallet from .env (Mode B):
  npm run cli -- rsi:enable --symbol BTC --existing-wallet

# Trade using a new wallet (Mode C) with Ed25519 signing:
  npm run cli -- rsi:enable --symbol BTC --create-wallet \\
    --generate-ed25519-key --signing-algorithm ed25519

# Deposit USDC using existing wallet:
  npm run cli -- deposit --amount 100 --currency USDC --existing-wallet

# Deposit USDT using a new wallet:
  npm run cli -- deposit --amount 50 --currency USDT --create-wallet
`;
