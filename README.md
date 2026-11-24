# Burst Sniper — pump.fun replay paper bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Djebrix/pumpfun-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Djebrix/pumpfun-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
— it trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve
activity, scored by net PnL.

## Strategy

A coin's fate is largely decided in its first few trades. The bot enters
exactly on the batch where a coin's trade count first reaches 5, and only if
all of these hold:

- the first 5 trades land within 10 slots (a burst, not a trickle),
- the price is already >= 2x the first trade's price,
- buy volume is >= 70% of all SOL traded so far,
- real SOL reserve is >= 2 SOL (so the 1% per-reply size cap buys a
  meaningful amount).

It buys `min(0.3 SOL, 1% of real reserve)`, one entry per coin, at most 5
open positions. On the dev window this filter enters 32 of 1222 coins, 23
of them profitable — a 2x move in 5 trades is real accumulation, and the
coins that burst that hard are the ones that go on to complete (migrate),
which is where the money is. A weaker 1.5x filter enters 106 coins but
loses money after fees, so the bar is set at 2x.

Exits, per position against the blended entry price the fills paid:

- take profit at +15% (the fill lags the decision by 2 slots, so a
  still-rising coin usually fills above the trigger),
- stop loss at -15%,
- trade-count exit after 15 more trades on the coin (a coin that has not
  popped within 15 trades is dead weight; holding it only invites the
  single-trade dump that ends most runners),
- slot backstop at 20,000 slots so a coin that stops trading cannot occupy
  a slot forever.

No scale-in (adding at rising prices only raises the blended entry) and no
re-entry. All comparisons are exact bigint ratios — no floats, no clock, no
randomness — so the two grading runs produce byte-identical action logs.

## Files

- `main.ts` — the strategy (runs as `node main.ts` on Node 22+).
- `vendor/makefun-bot.ts` — byte-identical copy of the kit's
  `sdk/ts/makefun-bot.ts` shim (the wire protocol).

## Local results (dev window)

Measured with the kit's own grader (`grade-local --driver process`):

- net PnL: **+0.589 SOL** on 10 SOL paper capital
- 32 counted round trips (>= 0.01 SOL, >= 20 coins), 64 fills, win rate 78%
- max drawdown: 2.4%
- top 3 coins made 37% of the gains; without them net PnL is still +0.24 SOL
- at 2x fees net PnL is still +0.386 SOL

Stress (`grade-local --stress`, 20 rebuilt copies of the dev window):
median +0.12 SOL, p10 -0.30, p90 +0.48; 6 of 20 copies lost money, so the
dev score is a good draw — the strategy's expected fresh-window PnL is
around the median, positive but with real variance.
