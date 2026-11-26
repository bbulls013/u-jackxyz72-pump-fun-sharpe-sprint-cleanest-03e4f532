# Pump.fun Sharpe Sprint — Cleanest Paper Bot

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/bbulls013/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/bbulls013/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the 6-hour pump.fun replay, ranked by hourly Sharpe
ratio. It trades small, exits fast and keeps hourly returns smooth instead of
swinging for one moonshot.

## Strategy

Forward-return stats on the dev window: from a coin's 4th trade, the mean
price change over the next ~15 trades is positive (a right tail of coins that
keep running), while the median change 300 slots later is deeply negative
(most coins die within minutes). So the bot:

- **Enters early**: on the batch carrying a coin's 4th trade, only if no
  sells yet and the curve already holds at least 2 SOL of real reserve
  (order cap at least 0.02 SOL). Stake is the cap, at most 0.03 SOL.
- **Exits on trade count, not slots**: after riding 15 of the coin's trades,
  or at +30% take profit, -12% stop loss, a trailing stop armed at +18%
  (exit at peak x 0.92), a seller-takeover fade, or 500 slots if the coin
  goes quiet.
- **Slippage wide open**: a capped order adverse-selects its fills — the
  buys that would have won are the ones rejected for moving.
- **Bounded bleed**: one round trip per mint, ever, and at most 36 entries.

Everything is decided from the batch stream alone — no clock, no random, no
environment reads — so two runs over the same data agree byte for byte.

## Dev window result

Graded locally with the kit (`grade-local`, process driver): 35 round trips
on 35 distinct mints, net PnL -0.022 SOL, hourly Sharpe -0.125, max drawdown
0.44%. The dev window is hostile after fees; the bot's job on the final
window is to keep the same low bleed while the right tail does the work.

## Layout

- `main.ts` — the strategy (Node 22, no dependencies)
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` bot shim

Run by the grader as `node /bot/main.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=p1s79ayf&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
