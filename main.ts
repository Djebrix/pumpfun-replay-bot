// Burst-sniper: a paper bot for the pump.fun replay sprint.
//
// Idea (from the dev dataset, 24h of pump.fun bonding-curve events):
// a coin's fate is largely decided in its first few trades. Coins whose first
// 5 trades land within 10 slots, push the price >= 2x the first trade's
// price, and are >= 70% buy volume are the real runners — the 2x-in-5-trades
// burst is a much stronger signal than a 1.5x drift (on the dev window the
// 1.5x filter loses money after fees; the 2x filter is +0.57 SOL). The bot
// enters exactly on the batch where the trade count first reaches 5, and
// only there: everything else in the window mean-reverts, so the bot never
// chases a pump that is already old. On the dev window this filter enters
// 32 of 1222 coins, 23 of them profitable, and catches the coins that go on
// to complete (migrate) — the burst is real accumulation, and completers
// are where the money is.
//
// Exits (all per position, against the blended entry price the fills paid):
//   - take profit at +15% (the fill lags the decision by 2 slots, so a
//     still-rising coin usually fills above the trigger),
//   - stop loss at -15%,
//   - trade-count exit after 15 more trades on the coin (a coin that has
//     not popped within 15 trades is dead weight; holding it only invites
//     the single-trade dev dump that ends most runners),
//   - slot backstop at 20_000 slots (~2h) so a coin that stops trading
//     cannot occupy one of the 5 slots forever.
// No scale-in: adding at rising prices only raises the blended entry.
// No re-entry: one shot per coin.
//
// All comparisons are exact bigint ratios (no floats, no clock, no
// randomness), so the two grading runs produce byte-identical action logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// --- entry: the burst -------------------------------------------------------
/** The trade count at which a coin is judged: exactly this trade. */
const ENTRY_TRADES = 5;
/** The first ENTRY_TRADES trades must land inside this many slots. */
const ENTRY_SPAN_SLOTS = 10;
/** Price must be at least this multiple of the first trade's price (2/1). */
const ENTRY_MULT_NUM = 2n;
const ENTRY_MULT_DEN = 1n;
/** Buy SOL must be at least this share of all SOL traded (7/10). */
const BUY_SHARE_NUM = 7n;
const BUY_SHARE_DEN = 10n;
/** Real SOL reserve must be at least this (so the 1% size cap buys >= 0.02 SOL). */
const MIN_REAL_LAMPORTS = 2n * LAMPORTS_PER_SOL;
/** Target stake per coin; the 1% size cap usually binds below this. */
const STAKE_LAMPORTS = (3n * LAMPORTS_PER_SOL) / 10n;
/** A round trip only counts at >= 0.01 SOL. */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n;

// --- exits ------------------------------------------------------------------
/** Take profit at +15% over the blended entry price (115/100). */
const TP_NUM = 115n;
const TP_DEN = 100n;
/** Stop loss at -15% under the blended entry price (85/100). */
const SL_NUM = 85n;
const SL_DEN = 100n;
/** Exit after this many trades on the coin since the entry fill. */
const MAX_HOLD_TRADES = 15;
/** Backstop: exit after this many slots held (frees dead slots). */
const MAX_HOLD_SLOTS = 20_000;
/** Never let a fill be refused for slippage: accept the market price. */
const MAX_SLIPPAGE_BPS = 10_000;

/** What the bot remembers about one mint. */
interface Tracked {
  /** First trade's post-trade price as (virtual quote, virtual token). */
  firstVq: bigint | null;
  firstVt: bigint | null;
  /** Trades seen. */
  trades: number;
  /** Trades seen before the current batch (for exact-trade entry). */
  tradesBeforeBatch: number;
  /** SOL volume by side. */
  buySol: bigint;
  sellSol: bigint;
  /** Slots of the first ENTRY_TRADES trades (for the span check). */
  firstSlots: number[];
}

/** A held position, as its fills reported it. */
interface Held {
  /** Blended entry price as (cost lamports, token amount). */
  entryCost: bigint;
  entryTokens: bigint;
  /** Trade count of the mint when the position first appeared. */
  entryTrades: number;
  /** Slot when the position first appeared. */
  entrySlot: number;
}

const tracked = new Map<string, Tracked>();
const held = new Map<string, Held>();
/** Coins already entered (one shot per coin). */
const decided = new Set<string>();

function track(mint: string): Tracked {
  let t = tracked.get(mint);
  if (t === undefined) {
    t = {
      firstVq: null,
      firstVt: null,
      trades: 0,
      tradesBeforeBatch: 0,
      buySol: 0n,
      sellSol: 0n,
      firstSlots: [],
    };
    tracked.set(mint, t);
  }
  return t;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    // Snapshot trade counts before this batch's events, so the entry can
    // fire exactly on the batch where the count first reaches ENTRY_TRADES.
    // Only the mints in this batch can be judged this batch, so snapshot
    // just those. Sweeping every coin ever seen on every batch made the
    // run quadratic in the window (batches x coins): on the 1/16 dev
    // sample that sweep alone was 36.9M iterations, half of all onBatch
    // time, and on a full 24h window it is what blows the 1800s wall
    // budget. Mints absent from this batch are never consulted below —
    // the entry loop only visits mints in batch.events — so their stale
    // tradesBeforeBatch is never read.
    for (const e of batch.events) {
      const t = tracked.get(e.mint);
      if (t !== undefined) t.tradesBeforeBatch = t.trades;
    }

    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        track(e.mint);
      } else if (e.event === 'TradeEvent') {
        const t = track(e.mint);
        const vq = BigInt(e.virtual_quote_reserves);
        const vt = BigInt(e.virtual_token_reserves);
        if (t.firstVq === null || t.firstVt === null) {
          t.firstVq = vq;
          t.firstVt = vt;
        }
        t.trades += 1;
        if (t.firstSlots.length < ENTRY_TRADES) t.firstSlots.push(e.slot);
        if (e.is_buy) t.buySol += BigInt(e.sol_amount);
        else t.sellSol += BigInt(e.sol_amount);
      }
    }

    // Refresh held positions from the account the fills reported.
    for (const [mint, h] of held) {
      if (!state.positions.has(mint)) {
        held.delete(mint);
        // Decided and gone: the coin can never re-enter, so its
        // per-trade state can go too instead of lingering to the end
        // of the window.
        tracked.delete(mint);
      }
    }
    for (const [mint, pos] of state.positions) {
      if (!held.has(mint)) {
        const t = tracked.get(mint);
        held.set(mint, {
          entryCost: BigInt(pos.cost_lamports),
          entryTokens: BigInt(pos.token_amount),
          entryTrades: t !== undefined ? t.trades : 0,
          entrySlot: state.slot,
        });
      }
    }
    // Mints with a sell already in flight: never sell twice.
    const sellPending = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') sellPending.add(p.order.mint);
    }

    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();

    // --- exits first ------------------------------------------------------
    for (const [mint, h] of held) {
      if (sellPending.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      if (vt === 0n || h.entryTokens === 0n) continue;
      const t = tracked.get(mint);
      const tradesSinceEntry = t !== undefined ? t.trades - h.entryTrades : 0;
      // price >= entry * 115/100  <=>  vq * entryTokens * 100 >= 115 * entryCost * vt
      const takeProfit =
        vq * h.entryTokens * TP_DEN >= TP_NUM * h.entryCost * vt;
      // price <= entry * 85/100  <=>  vq * entryTokens * 100 <= 85 * entryCost * vt
      const stopLoss =
        vq * h.entryTokens * SL_DEN <= SL_NUM * h.entryCost * vt;
      const stale =
        tradesSinceEntry >= MAX_HOLD_TRADES ||
        state.slot - h.entrySlot >= MAX_HOLD_SLOTS;
      if (takeProfit || stopLoss || stale) {
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        const sell: SellInput = {
          side: 'sell',
          mint,
          token_amount: BigInt(pos.token_amount),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        orders.push(sell);
        sellPending.add(mint);
      }
    }

    // --- entries ----------------------------------------------------------
    const maxPositions = state.hello.caps.max_open_positions;
    let committed = state.committedPositionCount();
    let free = state.freeCashLamports();
    for (const e of batch.events) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (committed >= maxPositions) break;
      const mint = e.mint;
      if (decided.has(mint)) continue;
      if (state.positions.has(mint) || held.has(mint)) continue;
      const t = tracked.get(mint);
      if (t === undefined || t.firstVq === null || t.firstVt === null) continue;
      // Exactly on the batch where the trade count first reaches ENTRY_TRADES.
      if (!(t.tradesBeforeBatch < ENTRY_TRADES && t.trades >= ENTRY_TRADES)) continue;
      // This batch judges the coin once and for all: the count only moves
      // past ENTRY_TRADES, so a coin judged here never gets another entry
      // window whether it passes or fails (the original code left failed
      // coins undecided, but the exact-trade-5 condition above already
      // blocks any later entry). Record the verdict now and drop its
      // per-trade state when it fails, instead of carrying every judged
      // coin to the end of the 24h window.
      decided.add(mint);
      const curve = state.curves.get(mint);
      const cap = state.maxBuyLamports(mint);
      // The first ENTRY_TRADES trades must be a burst, not a trickle.
      const burst =
        t.firstSlots.length >= ENTRY_TRADES &&
        t.firstSlots[ENTRY_TRADES - 1] - t.firstSlots[0] <= ENTRY_SPAN_SLOTS &&
        curve !== undefined &&
        !curve.complete &&
        // Price >= 2x the first trade's price  <=>  vq * firstVt >= 2 * firstVq * vt.
        curve.virtual_quote_reserves * t.firstVt * ENTRY_MULT_DEN >=
          ENTRY_MULT_NUM * t.firstVq * curve.virtual_token_reserves &&
        // Buy-dominated flow.
        t.buySol + t.sellSol !== 0n &&
        t.buySol * BUY_SHARE_DEN >= BUY_SHARE_NUM * (t.buySol + t.sellSol) &&
        // Enough real reserve for a meaningful buy.
        curve.real_quote_reserves >= MIN_REAL_LAMPORTS &&
        cap >= MIN_BUY_LAMPORTS;
      if (!burst) {
        tracked.delete(mint);
        continue;
      }
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) {
        tracked.delete(mint);
        continue;
      }
      const buy: BuyInput = {
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(buy);
      free -= amount + tx;
      committed += 1;
    }

    return orders;
  },
});
