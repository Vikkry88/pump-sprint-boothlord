[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Vikkry88/pump-sprint-boothlord/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Vikkry88/pump-sprint-boothlord/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump Sprint Bot — washout-dip + momentum pyramid

Paper-trading bot for the make.fun **Pump.fun Paper Sprint** bounty. One program
(`main.ts`, Node 22) trades pump.fun bonding curves on a replay of real chain
data. No real money, no entry fee — the house replays every entry on the same
6-hour forward window and ranks by net PnL.

## Strategy

Two entries, one exit discipline:

1. **Momentum** — a mature curve whose recent tape shows accelerating buy
   pressure (net SOL flowing in, several distinct buyers, price rising and
   sitting near its window high) gets a small first buy, then the position is
   pyramided into strength only, up to 1.5 SOL.
2. **Washout dip** — a curve that ran up then fell 25–45% off its recent high
   while buyers step back in gets small dip buys in tranches (buy the washout,
   not the top).

Exits: stop-loss vs cost, trailing stop once up, a time limit, and a fade exit
when net flow turns negative. Guardrail pacing keeps the run above 20 coins
with tiny probe round trips when fills or coins lag.

Deterministic: no clock, no randomness, no environment reads — the two graded
executions produce byte-identical action logs.

## Run it

The kit's local grader (from the unpacked competition kit):

```bash
node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process
```

## Files

- `main.ts` — the strategy (my own code).
- `vendor/makefun-bot.ts` — the kit's protocol shim, vendored byte for byte
  (excluded from authorship counts, as the kit's RULES say).

## Limits

- Capital 10 SOL, max 5 open positions, max 1% of a curve's real reserve per
  buy batch, max 16 orders per batch. Guardrails: round trip ≥ 0.01 SOL on
  ≥ 20 coins, max drawdown ≤ 50%.
