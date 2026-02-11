
export const HelpText = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Quote.Trade CLI • RSI Strategy (Headless)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Usage:
  Quote.Trade-cli-bot <command> [options]

Global options:
  --create-wallet   Generate a new wallet, authenticate, then run (no .env API keys)
  --debug          Enable debug logging for auth steps (no secrets printed)

Commands:
  rsi:enable   Start RSI runner for a symbol
  deposit      Deposit USDC or USDT to your account (ERC-20 transfer)
  help         Show this help message

Examples:
  npm run cli -- rsi:enable --symbol BTC
  npm run cli -- rsi:enable --symbol BTC --create-wallet
  npm run cli -- deposit --amount 100 --currency USDC
  npm run cli -- deposit --amount 50 --currency USDT --create-wallet
`;