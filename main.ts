// Early-launch rider for the pump.fun Sharpe sprint.
//
// Forward-return stats on the dev window: from a coin's 4th trade, the mean
// price change over the next ~15 trades is positive (a right tail of coins
// that keep running), while the median change 300 slots later is deeply
// negative (most coins die within minutes). So this bot enters early and
// exits on TRADE count, not wall-clock slots: it rides active coins for 15
// of their trades, takes profit at +30%, cuts at -12%, trails after +18%,
// and bails by slot count only when a coin goes quiet. Slippage is left
// wide open: a capped order adverse-selects its fills (the buys that would
// have won are the ones that get rejected for moving). One round trip per
// mint, ever, and at most 36 entries so fee bleed stays bounded.
//
// Everything is decided from the batch stream alone: no clock, no random, no
// environment reads, so two runs over the same data agree byte for byte.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// ---- fixed knobs -----------------------------------------------------------
const MAX_STAKE = (LAMPORTS_PER_SOL * 3n) / 100n; // 0.03 SOL per entry
const MIN_CAP = (LAMPORTS_PER_SOL * 2n) / 100n; // need cap >= 0.02 SOL
const MAX_ENTRIES = 36;
const TP_NUM = 130n; // take profit at entry * 1.30
const SL_NUM = 88n; // stop loss at entry * 0.88
const TRAIL_ARM = 118n; // trailing stop arms at entry * 1.18
const TRAIL_NUM = 92n; // ...and exits at peak * 0.92
const EXIT_AFTER_TRADES = 15; // ride 15 trades of the coin, then leave
const MAX_HOLD_SLOTS = 500; // quiet-coin bailout
const SLIPPAGE_BPS = 10_000; // wide open: a capped order adverse-selects fills

// ---- per-coin memory -------------------------------------------------------
interface Coin {
  firstPrice: bigint; // scaled price at first trade seen
  lastPrice: bigint; // scaled price (quote * 1e9 / token)
  peakPrice: bigint;
  trades: number;
  sells: number;
  buyVol: bigint;
  sellVol: bigint;
  buyers: Set<string>;
  recentFlow: { buy: bigint; sell: bigint }[]; // last 6 trades' flow
}

interface Held {
  entryPrice: bigint;
  peakPrice: bigint;
  entrySlot: number;
  entryTrades: number; // coin trade count when the position appeared
  sellSent: boolean; // a sell for this position is already in flight
}

const coins = new Map<string, Coin>();
const held = new Map<string, Held>();
const everOrdered = new Set<string>(); // mints we ever sent a buy for

function priceOf(vq: bigint, vt: bigint): bigint {
  if (vt === 0n) return 0n;
  return (vq * 1_000_000_000n) / vt;
}

function getCoin(mint: string): Coin {
  let c = coins.get(mint);
  if (c === undefined) {
    c = {
      firstPrice: 0n,
      lastPrice: 0n,
      peakPrice: 0n,
      trades: 0,
      sells: 0,
      buyVol: 0n,
      sellVol: 0n,
      buyers: new Set(),
      recentFlow: [],
    };
    coins.set(mint, c);
  }
  return c;
}

// Fold this batch's trades into per-coin memory before deciding anything.
function learn(batch: { events: readonly unknown[] }): void {
  for (const raw of batch.events) {
    const e = raw as {
      event: string;
      mint: string;
      is_buy?: boolean;
      sol_amount?: string;
      user?: string;
      virtual_quote_reserves?: string;
      virtual_token_reserves?: string;
    };
    if (e.event !== 'TradeEvent') continue;
    const c = getCoin(e.mint);
    const p = priceOf(BigInt(e.virtual_quote_reserves ?? '0'), BigInt(e.virtual_token_reserves ?? '0'));
    if (p > 0n) {
      if (c.firstPrice === 0n) c.firstPrice = p;
      c.lastPrice = p;
      if (p > c.peakPrice) c.peakPrice = p;
    }
    c.trades += 1;
    const vol = BigInt(e.sol_amount ?? '0');
    if (e.is_buy) {
      c.buyVol += vol;
      if (e.user) c.buyers.add(e.user);
      c.recentFlow.push({ buy: vol, sell: 0n });
    } else {
      c.sells += 1;
      c.sellVol += vol;
      c.recentFlow.push({ buy: 0n, sell: vol });
    }
    if (c.recentFlow.length > 6) c.recentFlow.shift();
    const h = held.get(e.mint);
    if (h !== undefined && p > h.peakPrice) h.peakPrice = p;
  }
}

// Exit test for one held coin; returns true when the whole position should go.
function exitSignal(c: Coin | undefined, h: Held, slot: number): boolean {
  if (slot - h.entrySlot > MAX_HOLD_SLOTS) return true;
  if (c === undefined) return false;
  if (c.trades - h.entryTrades >= EXIT_AFTER_TRADES) return true;
  if (c.lastPrice === 0n || h.entryPrice === 0n) return false;
  const p = c.lastPrice;
  if (p * 100n >= h.entryPrice * TP_NUM) return true;
  if (p * 100n <= h.entryPrice * SL_NUM) return true;
  if (h.peakPrice * 100n >= h.entryPrice * TRAIL_ARM && p * 100n <= h.peakPrice * TRAIL_NUM) return true;
  let rb = 0n;
  let rs = 0n;
  for (const f of c.recentFlow) {
    rb += f.buy;
    rs += f.sell;
  }
  if (rs > rb * 2n && rs > 0n) return true; // sellers took over
  return false;
}

await runBot({
  onBatch(state, batch) {
    learn(batch);
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];

    // Refresh held entries from the account: a buy that filled since the last
    // batch shows up as a position; stamp its entry price and the coin's
    // trade count so exits have a reference.
    for (const [mint] of state.positions) {
      if (!held.has(mint)) {
        const c = coins.get(mint);
        held.set(mint, {
          entryPrice: c?.lastPrice ?? 0n,
          peakPrice: c?.lastPrice ?? 0n,
          entrySlot: batch.slot,
          entryTrades: c?.trades ?? 0,
          sellSent: false,
        });
      }
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    // Exits first: free slots and cash before considering new entries. Never
    // send a second sell while one is already in flight for the position.
    let slotsUsed = state.committedPositionCount();
    for (const [mint, pos] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const h = held.get(mint);
      if (h === undefined || h.sellSent) continue;
      if (!exitSignal(coins.get(mint), h, batch.slot)) continue;
      orders.push({
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      h.sellSent = true;
      slotsUsed -= 1;
    }

    // Entries: deterministic order (sorted mints). Strict early setup only:
    // the batch carrying the coin's 4th trade, no sells yet, real money in
    // the curve (cap at least 0.02 SOL means at least 2 SOL of real reserve).
    let free = state.freeCashLamports();
    const candidates = [...coins.keys()].sort();
    for (const mint of candidates) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slotsUsed >= caps.max_open_positions) break;
      if (everOrdered.size >= MAX_ENTRIES) break;
      if (held.has(mint) || state.positions.has(mint)) continue;
      if (everOrdered.has(mint)) continue; // one round trip per mint, ever
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const c = coins.get(mint);
      if (c === undefined) continue;
      if (c.trades !== 4 || c.sells !== 0) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_CAP) continue;
      const stake = cap < MAX_STAKE ? cap : MAX_STAKE;
      if (free < stake + tx) break;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: stake,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      free -= stake + tx;
      slotsUsed += 1;
      everOrdered.add(mint);
    }

    return orders;
  },
});
