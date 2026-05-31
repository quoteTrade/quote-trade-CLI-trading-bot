export const HelpText = `Quote.Trade CLI

Trigger commands:
  trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01
  trigger:stop-limit --symbol BTC --side SELL --stop 58000 --limit 57950 --quantity 0.01
  trigger:take-profit --symbol BTC --price 65000 --close-position
  trigger:stop-loss --symbol BTC --price 58000 --close-position
  trigger:trailing-stop --symbol BTC --trail 5% --close-position
  trigger:trailing-stop-limit --symbol BTC --trail 5% --limit-offset 50 --close-position
  trigger:oco --symbol BTC --take-profit 65000 --stop-loss 58000 --close-position
  trigger:bracket --symbol BTC --side BUY --entry 60000 --quantity 0.01 --take-profit 65000 --stop-loss 58000
  trigger:scale-out --symbol BTC --price 63000 --percent 25%
  trigger:break-even --symbol BTC --after 3% --plus 0.5% --close-position
  trigger:close-after --symbol BTC --after 4h --close-position
  trigger:cancel-after --id <id> --after 30m
  trigger:price-band --symbol BTC --side BUY --mode BREAKOUT --upper 65000 --quantity 0.01
  trigger:risk-guard --symbol BTC --metric MAX_RISK_USD --threshold 500 --action CLOSE_POSITION
  trigger:watch
  trigger:list [--all]
  trigger:cancel --id <id>

Position commands:
  positions:refresh
  positions:list
  risk
`;
