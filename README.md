# Quote.Trade CLI Bot — RSI + Local L2 Trigger Orders

This branch adds local trigger management to the Quote.Trade CLI bot. The bot stores trigger definitions in `.quote-trade/triggers.json`, watches Quote.Trade liquidity/account streams locally, and sends ordinary Quote.Trade orders through the existing order submission path when a trigger fires.

The Quote.Trade API does not receive native trigger instructions in advance. The local bot must be running for local triggers to fire.

## Build and test

```bash
npm install
npm run build
npm test
```

## L2 trigger-price rule

Price-based triggers are now side- and quantity-aware:

```text
BUY  -> ask-side L2 depth
SELL -> bid-side L2 depth
```

The engine does not use `last`, `mid`, or `mark` for price-trigger decisions. For each active trigger, it resolves the intended order side and quantity first. Then it accumulates the matching L2 side from best price outward until it can cover the full order quantity:

```text
BUY 1.5 BTC limit @ 60000
  uses asks only
  fires only when cumulative ask depth for 1.5 BTC is available at <= 60000

SELL 2 ETH stop @ 3000
  uses bids only
  fires only when cumulative bid depth for 2 ETH is available at <= 3000
```

If the book crosses the trigger price but does not have enough quantity for the resolved order size, the trigger stays active and no order is submitted.

For `--close-position` and `--close-percentage`, the quantity is resolved from cached position memory before the L2 depth check. Long closes use `SELL`/bids. Short closes use `BUY`/asks.

## Core trigger commands

```bash
# BUY limit: fires only when enough ask-side depth is executable at or below 60000
npm run cli -- trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01

# SELL stop-limit: fires only when enough bid-side depth is executable at or below 58000
npm run cli -- trigger:stop-limit --symbol BTC --side SELL --stop 58000 --limit 57950 --quantity 0.01

# Position-sized exits; side and quantity are resolved from cached positions at fire time
npm run cli -- trigger:take-profit --symbol BTC --price 65000 --close-position
npm run cli -- trigger:stop-loss --symbol BTC --price 58000 --close-position
npm run cli -- trigger:trailing-stop --symbol BTC --trail 5% --close-position
npm run cli -- trigger:trailing-stop-limit --symbol BTC --trail 5% --limit-offset 50 --close-position

# OCO: whichever exit fires first cancels the other locally
npm run cli -- trigger:oco --symbol BTC --take-profit 65000 --stop-loss 58000 --close-position

# Bracket: entry limit creates OCO exit triggers after the entry position is confirmed
npm run cli -- trigger:bracket --symbol BTC --side BUY --entry 60000 --quantity 0.01 --take-profit 65000 --stop-loss 58000

# Scale out by percent of cached position
npm run cli -- trigger:scale-out --symbol BTC --price 63000 --percent 25%

# Arm a break-even stop after price moves favorably by 3%, locking entry + 0.5%
npm run cli -- trigger:break-even --symbol BTC --after 3% --plus 0.5% --close-position

# Time-based close or cancellation. Time closes submit only after a recent L2 tick confirms enough side depth.
npm run cli -- trigger:close-after --symbol BTC --after 4h --close-position
npm run cli -- trigger:close-at --symbol BTC --at 2026-05-14T12:00:00+02:00 --close-position
npm run cli -- trigger:cancel-after --id <trigger-id> --after 30m

# Price-band trigger
npm run cli -- trigger:price-band --symbol BTC --side BUY --mode BREAKOUT --upper 65000 --quantity 0.01

# Risk guard actions: ALERT, CLOSE_POSITION, CANCEL_TRIGGERS
npm run cli -- trigger:risk-guard --symbol BTC --metric MAX_RISK_USD --threshold 500 --action CLOSE_POSITION
```

Direction is side-aware. BUY limits fire at or below the price. SELL limits fire at or above it. BUY stop-style triggers fire upward. SELL stop-style triggers fire downward. Take-profit and stop-loss infer the normal exit direction from side.

## Watch, list, and cancel

```bash
npm run cli -- trigger:watch
npm run cli -- trigger:list
npm run cli -- trigger:list --all
npm run cli -- trigger:cancel --id <trigger-id>
```

## Position memory and risk

Positions are cached in `.quote-trade/positions.json`. The watcher updates the cache from listen-key account updates and from side-specific executable L2 close prices on ticks. `positions:refresh` also tries common Quote.Trade account endpoints, with `POSITIONS_ENDPOINT` configurable.

```bash
npm run cli -- positions:refresh
npm run cli -- positions:list
npm run cli -- risk
```

With `--close-position` or `--close-percentage`, the engine reads the cached position, chooses the close side (`SELL` for long, `BUY` for short), checks L2 depth for that quantity, and sends the cached available quantity or percentage. `MODE=paper` logs orders; `MODE=real` posts to Quote.Trade through the unchanged `/order` flow.

## Optional LLM strategy planner

Users can connect their own LLM provider key, or use the default free/no-subscription fallback chain for testing, and ask for trading strategies in English. The provider response is validated into exact local bot commands and saved as a pending draft. Nothing is submitted until the user confirms the draft.

Supported providers include OpenAI/ChatGPT, Codex OAuth through a ChatGPT/Codex account, Anthropic/Claude, xAI/Grok, OVHcloud AI Endpoints, Gemini, OpenRouter, GroqCloud, Hugging Face, Pollinations, and custom OpenAI-compatible gateways. The default fallback order is `ovhcloud -> gemini -> openrouter -> groq -> huggingface -> pollinations`; OVHcloud can run anonymously with rate limits for quick tests.

For ChatGPT Pro/Codex OAuth without an OpenAI Platform API key:

```bash
npm install -g @openai/codex
npm run cli -- codex:connect
npm run cli -- llm:plan --provider codex --no-fallback --prompt "Create a BTC limit buy at 60000 for quantity 0.01"
```

See `docs/llm-strategy-planner.md`, `docs/codex-oauth-cli.md`, and `docs/free-llm-fallbacks.md` for setup and safety details.
