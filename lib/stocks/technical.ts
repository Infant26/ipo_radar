/**
 * Bull / bear analysis, adapted from TradingAgents (TauricResearch, Apache-2.0,
 * https://github.com/TauricResearch/TradingAgents) as fixed rules. No AI model calls.
 *
 * TradingAgents runs a team of LLM agents. This keeps its structure and vocabulary and
 * replaces each agent with transparent rules over official NSE daily prices:
 *
 *   Market (technical) analyst  ->  its indicator set: 50/200 SMA, 10 EMA, MACD (12,26,9),
 *                                   RSI(14) with 70/30 levels, Bollinger (20, 2), ATR(14), VWMA(20)
 *   Bull and bear researchers   ->  evidence for and against, each point weighted
 *   Research manager            ->  5-tier rating (Buy, Overweight, Hold, Underweight, Sell)
 *                                   from the balance of bull and bear evidence
 *   Risk team / portfolio mgr   ->  caps on the rating: bear market, stock in a bear trend,
 *                                   illiquid, extreme volatility, short history
 *   Trader                      ->  entry, stop-loss and target grounded in ATR and moving
 *                                   averages (the repo's trader is told to use ATR and
 *                                   support/resistance for exactly this)
 *
 * Its news, sentiment and fundamentals analysts aren't ported: they need LLMs or paid data.
 */

export type Regime = "Bull" | "Bear" | "Recovering" | "Weakening" | "Sideways";
export type Rating = "Buy" | "Overweight" | "Hold" | "Underweight" | "Sell";
export const RATINGS: Rating[] = ["Buy", "Overweight", "Hold", "Underweight", "Sell"];

export interface Bars {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

export interface Indicators {
  close: number;
  sma50: number | null;
  sma200: number | null;
  sma200Prev: number | null;
  ema10: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  macdHistPrev: number | null;
  rsi: number | null;
  bollMid: number | null;
  bollUpper: number | null;
  bollLower: number | null;
  atr: number | null;
  vwma: number | null;
  high52: number | null;
  low52: number | null;
  high20: number | null;
  /** trading days since the 50-day last crossed the 200-day; sign = direction (+ golden, - death) */
  crossDaysAgo: number | null;
}

export interface Point {
  text: string;
  weight: number;
}

export interface TradePlan {
  horizon: "Swing" | "Positional";
  status: "buy" | "wait" | "watch" | "avoid";
  headline: string;
  entry: number | null;
  zone: [number, number] | null;
  stop: number | null;
  target: number | null;
  /** % below entry */
  riskPct: number | null;
  note: string;
}

export interface Signal {
  regime: Regime | null;
  rating: Rating;
  /** -100 (all bear) .. +100 (all bull) */
  net: number;
  bull: Point[];
  bear: Point[];
  caps: string[];
  swing: TradePlan;
  positional: TradePlan;
  indicators: Indicators;
}

// ---------- indicator maths ----------

const last = <T,>(a: T[]) => a[a.length - 1];

function smaSeries(x: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(x.length).fill(null);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i];
    if (i >= n) sum -= x[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function emaSeries(x: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(x.length).fill(null);
  if (x.length < n) return out;
  const k = 2 / (n + 1);
  let e = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < x.length; i++) {
    e = x[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** Wilder smoothing, as used by RSI and ATR. */
function wilder(x: number[], n: number): number | null {
  if (x.length < n) return null;
  let v = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < x.length; i++) v = (v * (n - 1) + x[i]) / n;
  return v;
}

export function indicators(b: Bars): Indicators {
  const c = b.close;
  const n = c.length;
  const sma50s = smaSeries(c, 50);
  const sma200s = smaSeries(c, 200);
  const ema10 = last(emaSeries(c, 10));
  const ema12 = emaSeries(c, 12);
  const ema26 = emaSeries(c, 26);
  const macdLine = c.map((_, i) => (ema12[i] !== null && ema26[i] !== null ? ema12[i]! - ema26[i]! : null));
  const macdVals = macdLine.filter((v): v is number => v !== null);
  const sig = emaSeries(macdVals, 9);
  const macd = macdVals.length ? last(macdVals) : null;
  const macdSignal = sig.length ? last(sig) : null;
  const hist = macdVals.map((m, i) => (sig[i] !== null ? m - sig[i]! : null)).filter((v): v is number => v !== null);

  // RSI(14), Wilder
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < n; i++) {
    const d = c[i] - c[i - 1];
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }
  const ag = wilder(gains, 14);
  const al = wilder(losses, 14);
  const rsi = ag === null || al === null ? null : al === 0 ? 100 : 100 - 100 / (1 + ag / al);

  // Bollinger (20, 2)
  let bollMid: number | null = null;
  let bollUpper: number | null = null;
  let bollLower: number | null = null;
  if (n >= 20) {
    const w = c.slice(-20);
    bollMid = w.reduce((a, v) => a + v, 0) / 20;
    const sd = Math.sqrt(w.reduce((a, v) => a + (v - bollMid!) ** 2, 0) / 20);
    bollUpper = bollMid + 2 * sd;
    bollLower = bollMid - 2 * sd;
  }

  // ATR(14), Wilder over true range
  const tr: number[] = [];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(b.high[i] - b.low[i], Math.abs(b.high[i] - c[i - 1]), Math.abs(b.low[i] - c[i - 1])));
  }
  const atr = wilder(tr, 14);

  // VWMA(20)
  let vwma: number | null = null;
  if (n >= 20) {
    let pv = 0;
    let vv = 0;
    for (let i = n - 20; i < n; i++) {
      pv += c[i] * b.volume[i];
      vv += b.volume[i];
    }
    vwma = vv > 0 ? pv / vv : null;
  }

  const yr = Math.min(n, 250);
  const high52 = n >= 120 ? Math.max(...b.high.slice(-yr)) : null;
  const low52 = n >= 120 ? Math.min(...b.low.slice(-yr)) : null;
  const high20 = n >= 20 ? Math.max(...b.high.slice(-20)) : null;

  // Most recent 50/200 crossover within the last 120 sessions
  let crossDaysAgo: number | null = null;
  for (let i = n - 1, k = 0; i > 0 && k < 120; i--, k++) {
    const a = sma50s[i], bb = sma200s[i], pa = sma50s[i - 1], pb = sma200s[i - 1];
    if (a === null || bb === null || pa === null || pb === null) break;
    if (Math.sign(a - bb) !== Math.sign(pa - pb)) {
      crossDaysAgo = a > bb ? k : -k;
      break;
    }
  }

  return {
    close: c[n - 1],
    sma50: last(sma50s),
    sma200: last(sma200s),
    sma200Prev: n > 220 ? sma200s[n - 21] : null,
    ema10,
    macd,
    macdSignal,
    macdHist: hist.length ? last(hist) : null,
    macdHistPrev: hist.length > 3 ? hist[hist.length - 4] : null,
    rsi,
    bollMid,
    bollUpper,
    bollLower,
    atr,
    vwma,
    high52,
    low52,
    high20,
    crossDaysAgo,
  };
}

// ---------- regime ----------

/**
 * Bull / bear state from the long-term trend, using the common definitions: price and the
 * 50-day both above a rising 200-day is a bull trend; both below it, or a 20%+ fall from
 * the 52-week high while under the 200-day, is a bear trend.
 */
export function regimeOf(i: Indicators): Regime | null {
  if (i.sma50 === null || i.sma200 === null) return null;
  const above = i.close > i.sma200;
  const golden = i.sma50 > i.sma200;
  const rising = i.sma200Prev === null ? true : i.sma200 >= i.sma200Prev;
  const offHigh = i.high52 ? i.close / i.high52 - 1 : 0;
  if (above && golden && rising) return "Bull";
  if (!above && (!golden || offHigh <= -0.2)) return "Bear";
  if (above && !golden) return "Recovering";
  if (!above && golden) return "Weakening";
  return "Sideways";
}

// ---------- bull vs bear case ----------

const fmt = (n: number) => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: n < 100 ? 2 : 0 });
const pc = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;

export interface MarketContext {
  regime: Regime | null;
  label: string;
}

export function analyse(
  b: Bars,
  ctx: { liquidityCr: number | null; market: MarketContext | null },
): Signal | null {
  if (b.close.length < 60) return null;
  const i = indicators(b);
  const regime = regimeOf(i);
  const bull: Point[] = [];
  const bear: Point[] = [];
  const add = (side: Point[], weight: number, text: string) => side.push({ weight, text });
  const c = i.close;
  const inUptrend = i.sma200 !== null && c > i.sma200;

  // Moving averages (trend)
  if (i.sma200 !== null) {
    if (c > i.sma200) add(bull, 20, `Price ${fmt(c)} is ${pc(c / i.sma200 - 1)} above its 200-day average (${fmt(i.sma200)})`);
    else add(bear, 20, `Price ${fmt(c)} is ${pc(c / i.sma200 - 1)} below its 200-day average (${fmt(i.sma200)})`);
  }
  if (i.sma50 !== null && i.sma200 !== null) {
    const when = i.crossDaysAgo !== null ? ` (crossed ${Math.abs(i.crossDaysAgo)} sessions ago)` : "";
    if (i.sma50 > i.sma200) add(bull, 15, `Golden cross: 50-day average above the 200-day${when}`);
    else add(bear, 15, `Death cross: 50-day average below the 200-day${when}`);
  }
  if (i.sma200 !== null && i.sma200Prev !== null) {
    if (i.sma200 > i.sma200Prev) add(bull, 5, "The 200-day average is rising");
    else add(bear, 5, "The 200-day average is falling");
  }
  if (i.ema10 !== null) {
    if (c > i.ema10) add(bull, 5, `Above its 10-day EMA (${fmt(i.ema10)}): short-term momentum up`);
    else add(bear, 5, `Below its 10-day EMA (${fmt(i.ema10)}): short-term momentum down`);
  }

  // MACD
  if (i.macd !== null && i.macdSignal !== null) {
    const rising = i.macdHist !== null && i.macdHistPrev !== null && i.macdHist > i.macdHistPrev;
    if (i.macd > i.macdSignal) add(bull, 10, `MACD above its signal line${rising ? ", histogram widening" : ""}`);
    else add(bear, 10, `MACD below its signal line${!rising ? ", histogram widening" : ""}`);
    if (i.macd > 0) add(bull, 5, "MACD above zero: the 12-day EMA leads the 26-day");
    else add(bear, 5, "MACD below zero: the 12-day EMA trails the 26-day");
  }

  // RSI with 70/30 levels; in strong trends RSI can stay extreme, so read it with the trend
  if (i.rsi !== null) {
    const r = i.rsi.toFixed(0);
    if (i.rsi > 70) add(bear, 5, `RSI ${r}: overbought, pullback risk`);
    else if (i.rsi >= 50) add(bull, 10, `RSI ${r}: healthy momentum, not overbought`);
    else if (i.rsi >= 30) add(bear, 5, `RSI ${r}: momentum below the midline`);
    else if (inUptrend) add(bull, 5, `RSI ${r}: oversold dip inside an uptrend`);
    else add(bear, 10, `RSI ${r}: oversold and still in a downtrend`);
  }

  // Bollinger (20, 2)
  if (i.bollUpper !== null && i.bollLower !== null) {
    if (c > i.bollUpper) {
      if (regime === "Bull") add(bull, 3, "Riding above the upper Bollinger band, typical of a strong trend");
      else add(bear, 5, "Stretched above the upper Bollinger band");
    } else if (c < i.bollLower) {
      if (inUptrend) add(bull, 5, "At the lower Bollinger band while above the 200-day: possible support");
      else add(bear, 5, "Breaking below the lower Bollinger band");
    }
  }

  // Volume (VWMA)
  if (i.vwma !== null) {
    if (c > i.vwma) add(bull, 5, `Above its volume-weighted average (${fmt(i.vwma)}): volume backs the move`);
    else add(bear, 5, `Below its volume-weighted average (${fmt(i.vwma)}): sellers dominate the volume`);
  }

  // Volatility (ATR)
  const atrPct = i.atr !== null ? i.atr / c : null;
  if (atrPct !== null && atrPct > 0.05) add(bear, 5, `Volatile: average daily range ${(atrPct * 100).toFixed(1)}% of price`);

  // Price structure
  if (i.high52 !== null) {
    const off = c / i.high52 - 1;
    if (off >= -0.05) add(bull, 5, `Within ${(-off * 100).toFixed(1)}% of its 52-week high (${fmt(i.high52)})`);
    else if (off <= -0.2) add(bear, 10, `${(-off * 100).toFixed(0)}% below its 52-week high: in its own bear market`);
  }

  // Market backdrop
  if (ctx.market?.regime === "Bull") add(bull, 5, `Market backdrop: ${ctx.market.label}`);
  else if (ctx.market?.regime === "Bear") add(bear, 10, `Market headwind: ${ctx.market.label}`);

  const sb = bull.reduce((a, p) => a + p.weight, 0);
  const sr = bear.reduce((a, p) => a + p.weight, 0);
  const net = sb + sr ? Math.round(((sb - sr) / (sb + sr)) * 100) : 0;

  // Research manager: rating from the balance of evidence
  let idx = net >= 50 ? 0 : net >= 20 ? 1 : net > -20 ? 2 : net > -50 ? 3 : 4;

  // Risk team: caps that can only lower the rating
  const caps: string[] = [];
  const capAt = (max: number, why: string) => {
    if (idx < max) {
      idx = max;
      caps.push(why);
    }
  };
  if (i.sma200 === null) capAt(2, "Less than 200 trading days of history: held at Hold");
  if (regime === "Bear") capAt(2, "Stock is in a bear trend: no buy rating");
  if (ctx.market?.regime === "Bear") capAt(1, "Market is in a bear phase: Buy lowered to Overweight");
  if (ctx.liquidityCr !== null && ctx.liquidityCr < 1) capAt(2, "Illiquid (under ₹1 Cr a day): held at Hold");
  if (atrPct !== null && atrPct > 0.07 && idx < 4) {
    idx += 1;
    caps.push(`Very volatile (${(atrPct * 100).toFixed(1)}% daily range): lowered one step`);
  }
  const rating = RATINGS[idx];

  bull.sort((a, b2) => b2.weight - a.weight);
  bear.sort((a, b2) => b2.weight - a.weight);

  return {
    regime,
    rating,
    net,
    bull,
    bear,
    caps,
    swing: swingPlan(i, rating, regime),
    positional: positionalPlan(i, rating, regime, ctx.market?.regime === "Bear"),
    indicators: i,
  };
}

// ---------- trader: entry, stop and target ----------

const round = (n: number) => (n >= 100 ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100);

function plan(
  horizon: TradePlan["horizon"],
  status: TradePlan["status"],
  headline: string,
  entry: number | null,
  zone: [number, number] | null,
  atr: number | null,
  atrMult: number,
  rewardRisk: number,
  note: string,
): TradePlan {
  const stop = entry !== null && atr !== null ? entry - atrMult * atr : null;
  const target = entry !== null && stop !== null ? entry + rewardRisk * (entry - stop) : null;
  return {
    horizon,
    status,
    headline,
    entry: entry !== null ? round(entry) : null,
    zone: zone ? [round(zone[0]), round(zone[1])] : null,
    stop: stop !== null && stop > 0 ? round(stop) : null,
    target: target !== null ? round(target) : null,
    riskPct: entry !== null && stop !== null && stop > 0 ? (entry - stop) / entry : null,
    note,
  };
}

/**
 * Swing (weeks to months): buy near the 20-day average / 10-day EMA in an uptrend,
 * stop 2x ATR below entry, target at 2x the risk.
 */
function swingPlan(i: Indicators, rating: Rating, regime: Regime | null): TradePlan {
  const { close: c, atr, bollMid: mid, ema10, sma50, sma200, high20 } = i;
  if (atr === null || mid === null) return plan("Swing", "watch", "Not enough data", null, null, null, 2, 2, "");
  if (rating === "Buy" || rating === "Overweight") {
    const lo = mid - 0.5 * atr;
    const hi = Math.max(mid + 0.5 * atr, ema10 ?? mid);
    if (c >= lo && c <= hi) {
      return plan("Swing", "buy", "In the buy zone now", c, [lo, hi], atr, 2, 2,
        "Price is near its 20-day average and 10-day EMA, where uptrends often pause before continuing.");
    }
    if (c > hi) {
      return plan("Swing", "wait", "Extended: wait for a pullback", hi, [lo, hi], atr, 2, 2,
        `Price is ${pc(c / mid - 1)} above its 20-day average. Chasing raises the risk; a dip into the zone gives a better entry.`);
    }
    if (sma50 !== null && c > sma50) {
      return plan("Swing", "buy", "Dip to support", c, [lo, hi], atr, 2, 2,
        "Below the 20-day average but still above the 50-day, which often acts as support in an uptrend.");
    }
    return plan("Swing", "wait", `Wait for a close above ${fmt(mid)}`, mid, [lo, hi], atr, 2, 2,
      "Trend is up on balance but price has slipped under its short-term averages.");
  }
  if (rating === "Hold") {
    // Reclaiming the short-term averages is the first sign buyers are back; a far-off
    // 20-day high left over from a sharp fall isn't a useful trigger.
    const reclaim = Math.max(mid, ema10 ?? mid);
    const trigger = c < reclaim ? reclaim : Math.min(high20 ?? reclaim, Math.max(reclaim, c + 0.5 * atr));
    return plan("Swing", "watch", `Watch: consider only above ${fmt(trigger)}`, trigger, null, atr, 2, 2,
      c < reclaim
        ? "Mixed signals. A close back above its 10-day EMA and 20-day average would show buyers returning."
        : "Mixed signals. A push through recent highs would confirm buyers are in control.");
  }
  const reclaim = sma200 ?? sma50 ?? mid;
  return plan("Swing", "avoid", "Avoid for now", null, null, null, 2, 2,
    regime === "Bear"
      ? `Bear trend. Re-check if it closes back above its ${sma200 ? "200" : "50"}-day average (${fmt(reclaim)}).`
      : `Evidence leans bearish. Re-check if it closes above ${fmt(reclaim)}.`);
}

/**
 * Positional (months to a year): buy pullbacks toward the 50-day average while the
 * 200-day trend is up, stop 3x ATR below entry, target at 3x the risk.
 */
function positionalPlan(i: Indicators, rating: Rating, regime: Regime | null, marketBear: boolean): TradePlan {
  const { close: c, atr, sma50, sma200 } = i;
  if (atr === null || sma50 === null || sma200 === null) {
    return plan("Positional", "watch", "Needs 200 days of history", null, null, null, 3, 3,
      "The positional plan relies on the 200-day trend, which this stock doesn't have yet.");
  }
  if (regime === "Bull" && rating !== "Underweight" && rating !== "Sell") {
    const lo = sma50 - 0.5 * atr;
    const hi = sma50 + 1.0 * atr;
    if (c >= lo && c <= hi) {
      // In a bear market only stocks rated above Hold get a buy; the rest are watched
      if (marketBear && rating === "Hold") {
        return plan("Positional", "watch", "At the 50-day, but the market is in a bear phase", c, [lo, hi], atr, 3, 3,
          "The stock's own uptrend holds, but most stocks fall with the market. Waiting for the market to turn, or starting small, limits the damage if it doesn't.");
      }
      return plan("Positional", "buy", "At the 50-day average: buy zone", c, [lo, hi], atr, 3, 3,
        `Long-term uptrend; the trend fails if it closes below the 200-day average (${fmt(sma200)}).`);
    }
    if (c > hi) {
      return plan("Positional", "wait", `Wait for a pullback toward ${fmt(sma50)}`, hi, [lo, hi], atr, 3, 3,
        `Uptrend intact but price is ${pc(c / sma50 - 1)} above its 50-day average. Patience usually gives a better entry.`);
    }
    return plan("Positional", "watch", "Below the 50-day: wait for it to recover", sma50, [lo, hi], atr, 3, 3,
      `Still above the 200-day (${fmt(sma200)}), so the long-term trend holds, but wait for a close back above the 50-day.`);
  }
  if (regime === "Recovering") {
    return plan("Positional", "watch", "Early recovery: wait for the golden cross", null, null, null, 3, 3,
      `Price is back above the 200-day (${fmt(sma200)}), but the 50-day (${fmt(sma50)}) hasn't crossed above it yet.`);
  }
  if (regime === "Weakening") {
    return plan("Positional", "avoid", "Weakening: stand aside", null, null, null, 3, 3,
      `Price has dropped below the 200-day (${fmt(sma200)}). Re-check if it closes back above it.`);
  }
  return plan("Positional", "avoid", "Avoid: no long-term uptrend", null, null, null, 3, 3,
    `Wait until it closes above its 200-day average (${fmt(sma200)}) and the 50-day crosses above it.`);
}
