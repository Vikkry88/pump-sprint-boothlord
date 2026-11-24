// Launch-sniper + tight-momentum bot for the pump.fun paper sprint (v2).
//
// Lesson from the dev window: long holds and loose stops bleed. The momentum pilot lost
// -9.45 SOL and the reversion pilot -4.37 SOL on the same data, while the fastest trader —
// buy fresh launches, take profit fast, cut losers fast — lost only -0.42 SOL with a 4.6%
// max drawdown. This bot is built on that lesson, in its own code:
//
//   1. Sniper: buy a launch within its first few slots, only if it passes a rug filter
//      (creator's own buy small, few distinct buyers so it is not a bundled dump, creator
//      has not sold). Stake 0.1 SOL. Take profit at +15%, stop at -12%, never hold past
//      12 slots, exit at once when the creator sells.
//   2. Tight momentum: a mature curve with accelerating buy pressure gets a small first buy
//      and pyramid adds only into strength, with a 12% stop, 15% trail and a 400-slot cap.
//
// Exits always come first in a batch. Guardrail pacing keeps the run above 20 coins with
// tiny probe round trips when fills or coins lag the pace.
//
// Deterministic by construction: no clock, no randomness, no environment reads; iteration only
// over insertion-ordered maps fed by the batch stream. The hello message opens the run, one
// batch arrives per slot, and onBatch answers with orders — hello, batch, orders, slot.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  devBuy: number;
  devSold: boolean;
  buyers: Set<string>;
  bought: number;
  soldByOthers: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
  lastTradeSlot: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
  kind: 'snipe' | 'mom';
}

const P = {
  // sniper
  snipeMaxAge: 4,
  snipeStake: 0.1,
  snipeMinRq: 0.3,
  snipeMaxRq: 30,
  snipeMaxDevBuy: 2.5,
  snipeMaxBuyers: 3,
  snipeTp: 0.15,
  snipeSl: 0.12,
  snipeMaxHold: 12,
  // momentum
  momWindow: 30,
  momMinNetSol: 1,
  momMinBuys: 3,
  momMinBuyers: 4,
  momMinUp: 0.05,
  momMaxUp: 0.8,
  momNearHigh: 0.9,
  momMinAge: 400,
  momMinRq: 2,
  momMaxRq: 60,
  momStake: 0.6,
  momFirst: 0.05,
  momAdd: 0.1,
  momStop: 0.12,
  momTrail: 0.15,
  momTrailArm: 0.08,
  momMaxHold: 400,
  // shared
  minBuySol: 0.01,
  buySlipBps: 1000,
  fadeWindow: 15,
  fadeNetSol: 0.5,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 4,
  maxExposure: 6,
  probeSol: 0.02,
  probeMinRq: 3,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14_400,
};

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const probes = new Map<Pubkey, boolean>();
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = {
      created: null,
      creator: null,
      devBuy: 0,
      devSold: false,
      buyers: new Set(),
      bought: 0,
      soldByOthers: 0,
      trades: [],
      entries: 0,
      lastExit: -1e12,
      lastTradeSlot: 0,
    };
    tapes.set(mint, t);
  }
  return t;
}

function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

function momSignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < P.momMinRq || rqSol > P.momMaxRq) return false;
  if (t.created === null || now - t.created < P.momMinAge) return false;
  const from = now - P.momWindow;
  const mid = now - P.momWindow / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const byUser = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    } else sellSol += tr.sol;
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < P.momMinBuys || byUser.size < P.momMinBuyers) return false;
  if (buySol - sellSol < P.momMinNetSol) return false;
  if (startPrice <= 0) return false;
  const up = last / startPrice - 1;
  if (up < P.momMinUp || up > P.momMaxUp) return false;
  if (last < high * P.momNearHigh) return false;
  if (netNew <= 0 || netNew < netOld) return false;
  return true;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const traded = new Set<Pubkey>();
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const t = tapeOf(e.mint);
        t.created = e.slot;
        t.creator = e.creator;
        t.lastTradeSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
        t.lastTradeSlot = e.slot;
        const isDev = t.creator !== null && e.user === t.creator;
        if (e.is_buy) {
          t.bought += sol;
          if (isDev && e.slot === t.created) t.devBuy += sol;
          else if (!isDev) t.buyers.add(e.user);
        } else if (isDev) {
          t.devSold = true;
        } else {
          t.soldByOthers += sol;
        }
        traded.add(e.mint);
      }
    }
    const keep = Math.max(P.momWindow, P.fadeWindow) + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }
    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;

    // Exits first. Sniper positions: TP +15%, SL -12%, max 12 slots, exit on dev sell.
    // Momentum positions: TP via trail, SL -12%, max 400 slots, fade exit.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
      const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
      const tokens = Number(pos.token_amount);
      const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValue) h.peakValue = value;
      h.lastValue = value;
      let exit = h.exiting;
      const t = tapeOf(mint);
      if (h.kind === 'snipe') {
        if (value >= cost * (1 + P.snipeTp)) exit = true;
        if (value <= cost * (1 - P.snipeSl)) exit = true;
        if (now - h.opened > P.snipeMaxHold) exit = true;
        if (t.devSold) exit = true;
      } else {
        if (value < cost * (1 - P.momStop)) exit = true;
        if (h.peakValue >= cost * (1 + P.momTrailArm) && value < h.peakValue * (1 - P.momTrail)) exit = true;
        if (now - h.opened > P.momMaxHold) exit = true;
        if (flow(t, now, P.fadeWindow) < -P.fadeNetSol) exit = true;
      }
      if (!exit) continue;
      h.exiting = true;
      let sellPending = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
      }
      if (sellPending) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // Probes: sell the whole probe as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (!selling) probes.set(mint, true);
    }

    // Entries and pyramid adds.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let mainLeft = P.maxMain - held.size;
    let exposure = 0;
    for (const [mint, h] of held) {
      exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
    }
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = held.get(mint);
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (h === undefined) {
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        if (t.entries >= P.maxEntries || now - t.lastExit < P.cooldown) continue;
        let want = 0;
        let kind: 'snipe' | 'mom' = 'mom';
        let stake = P.momStake;
        // Sniper first: fresh launch, rug filter.
        if (t.created !== null && now - t.created <= P.snipeMaxAge) {
          if (
            rqSol >= P.snipeMinRq &&
            rqSol <= P.snipeMaxRq &&
            t.devBuy <= P.snipeMaxDevBuy &&
            t.buyers.size <= P.snipeMaxBuyers &&
            !t.devSold
          ) {
            want = P.snipeStake;
            kind = 'snipe';
            stake = P.snipeStake;
          }
        }
        if (want === 0 && momSignal(t, now, rqSol)) {
          want = Math.min(P.momFirst, P.momStake);
          kind = 'mom';
          stake = P.momStake;
        }
        if (want === 0) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, stake, P.maxExposure - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < P.minBuySol) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: P.buySlipBps,
        });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, {
          opened: now,
          peakValue: 0,
          invested: amount,
          exiting: false,
          filled: false,
          lastAddPrice: price,
          lastValue: 0,
          kind,
        });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      } else if (h.kind === 'mom') {
        // Pyramid momentum into strength only.
        if (h.exiting || !h.filled) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (h.invested >= P.momStake - P.minBuySol) continue;
        if (price < h.lastAddPrice) continue;
        if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
        if (flow(t, now, P.momWindow) < 0.5) continue;
        if (rqSol > P.momMaxRq) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, P.momAdd, P.momStake - h.invested, P.maxExposure - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < P.minBuySol) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: P.buySlipBps,
        });
        free -= amount + tx;
        exposure += amount;
        h.invested += amount;
        h.lastAddPrice = price;
      }
    }

    // Guardrail pacing: probe round trips when fills or coins lag the pace.
    if (probes.size < 2 && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / P.paceSecs);
      const needCoins = myCoins.size < Math.ceil(P.targetCoins * pace);
      const needFills = myFills < Math.ceil(P.targetFills * pace);
      if (needCoins || needFills) {
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= 2) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < P.probeMinRq) continue;
          if (free < P.probeSol + 2 * tx) break;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: BigInt(Math.floor(P.probeSol * LAMPORTS)),
            max_slippage_bps: P.buySlipBps,
          });
          probes.set(mint, false);
          free -= P.probeSol + tx;
        }
      }
    }
    return orders;
  },
});
