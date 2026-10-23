/**
 * Stock metrics and scores from official NSE prices.
 *
 * Method (stated so the numbers can be checked):
 *  - Prices are NSE closing prices, adjusted for bonus issues and splits (not dividends,
 *    so these are price returns; dividend yield would add to them).
 *  - Samples: the latest trading day, then the trading day on or before each monthly
 *    anniversary for 60 months, and each week for 52 weeks.
 *  - CAGR(n) = (P_now / P_n_years_ago)^(1/n) - 1. "Year k" = return from k years ago to
 *    k-1 years ago.
 *  - Volatility = std dev of monthly log returns over the last 36 months x sqrt(12).
 *  - Max drawdown = largest peak-to-trough fall in the monthly series.
 *  - Return per unit of risk (Sharpe-style) = (CAGR - 6.5% risk-free) / volatility.
 *    6.5% approximates the Indian 10-year government bond yield.
 *  - 10- and 40-week moving averages stand in for the 50- and 200-day averages.
 *  - Liquidity = median daily traded value on the sampled days over the last year.
 */
import type { Adjustment, Day, DayRow } from "./nse";

export const RISK_FREE = 0.065;
/** Below this median daily traded value (₹ crore) a stock is treated as illiquid. */
export const ILLIQUID_CR = 1;

export interface ScorePart {
  key: string;
  label: string;
  weight: number;
  value: number | null;
  detail: string;
}

export type StockVerdict = "Strong" | "Fair" | "Weak" | "Poor";

export interface StockFlag {
  tone: "bad" | "warn" | "good";
  text: string;
}

export interface StockRow {
  symbol: string;
  name: string;
  industry: string | null;
  series: string;
  price: number;
  /** trailing returns as fractions: 1W, 1M, 3M, 6M */
  r1w: number | null;
  r1m: number | null;
  r3m: number | null;
  r6m: number | null;
  /** cagr[0] = 1-year return, cagr[1] = 2-year CAGR ... cagr[4] = 5-year CAGR */
  cagr: (number | null)[];
  /** years[0] = last 12 months, years[1] = 12-24 months ago ... */
  years: (number | null)[];
  vol: number | null;
  maxDD: number | null;
  sharpe: number | null;
  /** median daily traded value, ₹ crore */
  liquidityCr: number | null;
  fromHigh: number | null;
  aboveMa10: boolean | null;
  aboveMa40: boolean | null;
  ma10AboveMa40: boolean | null;
  historyMonths: number;
  /** false when a price jump suggests an unrecorded split or bonus */
  dataOk: boolean;
  adjusted: boolean;
  longTerm: { score: number | null; verdict: StockVerdict | null; parts: ScorePart[] };
  shortTerm: { score: number | null; verdict: StockVerdict | null; parts: ScorePart[] };
  flags: StockFlag[];
}

export interface StockSeries {
  symbol: string;
  /** monthly adjusted closes, oldest first */
  monthly: { date: string; close: number }[];
  adjustments: Adjustment[];
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const pct = (n: number, d = 1) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`;
const verdictOf = (s: number | null): StockVerdict | null =>
  s === null ? null : s >= 65 ? "Strong" : s >= 45 ? "Fair" : s >= 25 ? "Weak" : "Poor";

function scoreOf(parts: ScorePart[], minCoverage: number) {
  const total = parts.reduce((a, p) => a + p.weight, 0);
  const used = parts.filter((p) => p.value !== null);
  const w = used.reduce((a, p) => a + p.weight, 0);
  const score = w / total >= minCoverage ? Math.round((used.reduce((a, p) => a + p.weight * p.value!, 0) / w) * 100) : null;
  return { score, verdict: verdictOf(score), parts };
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Product of adjustment factors for ex-dates after `date` (up to the latest day). */
function factorAfter(adj: Adjustment[] | undefined, date: string, latest: string) {
  if (!adj) return 1;
  let f = 1;
  for (const a of adj) if (a.exDate > date && a.exDate <= latest) f *= a.factor;
  return f;
}

export function computeStocks(
  latest: Day,
  monthly: (Day | null)[],
  weekly: (Day | null)[],
  adjustments: Map<string, Adjustment[]>,
  names: Map<string, { name: string; industry: string | null; equity: boolean }>,
): { rows: StockRow[]; series: Map<string, StockSeries> } {
  const rows: StockRow[] = [];
  const series = new Map<string, StockSeries>();

  for (const [symbol, now] of latest.rows) {
    // Companies only: NSE's equity list leaves out ETFs, REITs/InvITs and bonds
    const info = names.get(symbol);
    if (!info?.equity) continue;
    const adj = adjustments.get(symbol);
    const at = (d: Day | null): number | null => {
      const r: DayRow | undefined = d?.rows.get(symbol);
      return r && d ? r.close / factorAfter(adj, d.date, latest.date) : null;
    };

    // m[k] = adjusted close k months ago (m[0] = latest)
    const m = monthly.map(at);
    const w = weekly.map(at);
    const price = now.close;
    m[0] = price;
    w[0] = price;

    // History length: oldest month with a price, counting only an unbroken run from today
    let historyMonths = 0;
    for (let k = 1; k < m.length && m[k] !== null; k++) historyMonths = k;

    // Data check: a missed consolidation shows up as a huge one-month rise (>300%), which
    // would falsely top the gainers lists. Big one-month falls do happen for real (and a
    // missed split only makes returns look worse), so those are just labelled.
    let dataOk = true;
    let worstMonth = 0;
    for (let k = 0; k < historyMonths; k++) {
      const a = m[k];
      const b = m[k + 1];
      if (!a || !b) continue;
      if (a / b > 4) dataOk = false;
      worstMonth = Math.min(worstMonth, a / b - 1);
    }

    const ret = (k: number) => (m[k] ? price / m[k]! - 1 : null);
    const cagr = [1, 2, 3, 4, 5].map((n) => {
      const p = m[12 * n];
      return p && 12 * n <= historyMonths ? Math.pow(price / p, 1 / n) - 1 : null;
    });
    const years = [1, 2, 3, 4, 5].map((n) => {
      const a = m[12 * (n - 1)];
      const b = m[12 * n];
      return a && b && 12 * n <= historyMonths ? a / b - 1 : null;
    });

    // Volatility from up to 36 monthly log returns
    const logs: number[] = [];
    for (let k = 0; k < Math.min(36, historyMonths); k++) {
      if (m[k] && m[k + 1]) logs.push(Math.log(m[k]! / m[k + 1]!));
    }
    let vol: number | null = null;
    if (logs.length >= 12) {
      const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
      vol = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / (logs.length - 1)) * Math.sqrt(12);
    }

    // Max drawdown, oldest to newest
    let peak = 0;
    let maxDD: number | null = null;
    for (let k = historyMonths; k >= 0; k--) {
      const p = m[k];
      if (!p) continue;
      peak = Math.max(peak, p);
      const dd = p / peak - 1;
      maxDD = maxDD === null ? dd : Math.min(maxDD, dd);
    }
    if (historyMonths < 12) maxDD = null;

    const baseCagr = cagr[2] ?? cagr[1] ?? cagr[0];
    const sharpe = vol && baseCagr !== null ? (baseCagr - RISK_FREE) / vol : null;

    // Short-term trend from weekly closes
    const wk = w.filter((x): x is number => x !== null);
    const avg = (n: number) => (w.slice(0, n).every((x) => x !== null) ? w.slice(0, n).reduce((a, b) => a! + b!, 0)! / n : null);
    const ma10 = avg(10);
    const ma40 = avg(40);
    const high = wk.length >= 26 ? Math.max(...wk) : null;
    const fromHigh = high ? price / high - 1 : null;

    const values = weekly
      .map((d) => d?.rows.get(symbol)?.value)
      .filter((v): v is number => v !== undefined && v > 0);
    values.push(now.value);
    const liq = median(values);
    const liquidityCr = liq !== null ? liq / 1e7 : null;

    const r1w = w[1] ? price / w[1]! - 1 : null;
    const r1m = ret(1);
    const r3m = ret(3);
    const r6m = ret(6);
    const mom12_1 = m[1] && m[12] ? m[1]! / m[12]! - 1 : null;

    // ---------- long-term score ----------
    const longCagr = cagr[4] ?? cagr[2] ?? null;
    const longLabel = cagr[4] !== null ? "5-year" : "3-year";
    const yrs = years.filter((y): y is number => y !== null);
    const positive = yrs.filter((y) => y > 0).length;
    const liqVal = liquidityCr === null ? null : clamp(Math.log10(liquidityCr / 0.5) / Math.log10(20)); // ₹0.5 Cr → 0, ₹10 Cr → 1

    const longParts: ScorePart[] = [
      {
        key: "growth",
        label: "Long-run growth",
        weight: 30,
        value: longCagr === null ? null : clamp(longCagr / 0.3),
        detail: longCagr === null ? "Needs 3+ years of history" : `${longLabel} CAGR ${pct(longCagr)} a year (30%+ = full marks)`,
      },
      {
        key: "consistency",
        label: "Consistency",
        weight: 20,
        value: yrs.length >= 3 ? clamp(positive / yrs.length - (Math.min(...yrs) < -0.3 ? 0.25 : 0)) : null,
        detail:
          yrs.length >= 3
            ? `Up in ${positive} of ${yrs.length} years, worst year ${pct(Math.min(...yrs), 0)}`
            : "Needs 3+ years of history",
      },
      {
        key: "sharpe",
        label: "Return per unit of risk",
        weight: 20,
        value: sharpe === null ? null : clamp(sharpe / 1.5),
        detail:
          sharpe === null
            ? "Needs a year of history"
            : `${sharpe.toFixed(2)} (CAGR above 6.5% risk-free, per unit of volatility; 1.5+ = full marks)`,
      },
      {
        key: "drawdown",
        label: "Drawdown",
        weight: 15,
        value: maxDD === null ? null : clamp(1 + maxDD / 0.6),
        detail: maxDD === null ? "Needs a year of history" : `Worst fall from a peak ${pct(maxDD, 0)} (0% best, -60% or worse = zero)`,
      },
      {
        key: "trend",
        label: "Long-term trend",
        weight: 10,
        value: ma40 === null ? null : price > ma40 ? 1 : 0.2,
        detail: ma40 === null ? "Needs 40 weeks of history" : price > ma40 ? "Above its 40-week average" : "Below its 40-week average",
      },
      {
        key: "liquidity",
        label: "Liquidity",
        weight: 5,
        value: liqVal,
        detail: liquidityCr === null ? "No trading data" : `₹${liquidityCr.toFixed(liquidityCr < 10 ? 2 : 0)} Cr traded a day (₹10 Cr+ = full marks)`,
      },
    ];

    // ---------- short-term score ----------
    const trendVal =
      ma10 === null || ma40 === null ? null : (price > ma10 ? 0.4 : 0) + (price > ma40 ? 0.3 : 0) + (ma10 > ma40 ? 0.3 : 0);
    const shortParts: ScorePart[] = [
      {
        key: "momentum",
        label: "12-month momentum",
        weight: 25,
        value: mom12_1 === null ? null : clamp((mom12_1 + 0.1) / 0.7),
        detail:
          mom12_1 === null ? "Needs a year of history" : `${pct(mom12_1)} from 12 months ago to last month (+60% = full marks)`,
      },
      {
        key: "r3m",
        label: "3-month return",
        weight: 20,
        value: r3m === null ? null : clamp((r3m + 0.05) / 0.35),
        detail: r3m === null ? "Not enough history" : `${pct(r3m)} (+30% = full marks)`,
      },
      {
        key: "r1m",
        label: "1-month return",
        weight: 10,
        value: r1m === null ? null : clamp((r1m + 0.05) / 0.15),
        detail: r1m === null ? "Not enough history" : `${pct(r1m)} (+10% = full marks)`,
      },
      {
        key: "trend",
        label: "Trend",
        weight: 20,
        value: trendVal,
        detail:
          trendVal === null
            ? "Needs 40 weeks of history"
            : [
                price > ma10! ? "above 10-week average" : "below 10-week average",
                price > ma40! ? "above 40-week" : "below 40-week",
                ma10! > ma40! ? "10-week above 40-week" : "10-week below 40-week",
              ].join(", "),
      },
      {
        key: "high",
        label: "Near 52-week high",
        weight: 15,
        value: fromHigh === null ? null : clamp(1 + fromHigh / 0.3),
        detail: fromHigh === null ? "Needs 6 months of history" : `${pct(fromHigh)} from its 52-week high (weekly closes)`,
      },
      {
        key: "liquidity",
        label: "Liquidity",
        weight: 10,
        value: liqVal,
        detail: liquidityCr === null ? "No trading data" : `₹${liquidityCr.toFixed(liquidityCr < 10 ? 2 : 0)} Cr traded a day`,
      },
    ];

    // ---------- flags ----------
    const flags: StockFlag[] = [];
    if (!dataOk) flags.push({ tone: "bad", text: "Rose 4x+ in a month with no recorded split: check data" });
    if (worstMonth < -0.6) flags.push({ tone: "warn", text: `Fell ${(-worstMonth * 100).toFixed(0)}% in a single month` });
    if (liquidityCr !== null && liquidityCr < ILLIQUID_CR) flags.push({ tone: "bad", text: `Illiquid (₹${liquidityCr.toFixed(2)} Cr a day)` });
    if (now.series === "BE") flags.push({ tone: "warn", text: "Trade-for-trade segment (no intraday)" });
    if (price < 20) flags.push({ tone: "warn", text: `Penny stock (₹${price.toFixed(2)})` });
    if (vol !== null && vol > 0.6) flags.push({ tone: "warn", text: `Very volatile (${(vol * 100).toFixed(0)}% a year)` });
    if (maxDD !== null && maxDD < -0.6) flags.push({ tone: "warn", text: `Fell ${(-maxDD * 100).toFixed(0)}% from a peak` });
    if (historyMonths < 12) flags.push({ tone: "warn", text: "Listed less than a year" });
    if (years[0] !== null && years[0] > 3)
      flags.push({ tone: "warn", text: `Up ${(years[0] + 1).toFixed(1)}x in a year: check news for demergers or one-offs` });
    if (yrs.length >= 4 && positive === yrs.length) flags.push({ tone: "good", text: `Up every year for ${yrs.length} years` });
    if (fromHigh !== null && fromHigh > -0.03) flags.push({ tone: "good", text: "At its 52-week high" });

    const round = (n: number | null, d = 4) => (n === null || !isFinite(n) ? null : Number(n.toFixed(d)));
    rows.push({
      symbol,
      name: names.get(symbol)?.name ?? symbol,
      industry: names.get(symbol)?.industry ?? null,
      series: now.series,
      price,
      r1w: round(r1w),
      r1m: round(r1m),
      r3m: round(r3m),
      r6m: round(r6m),
      cagr: cagr.map((c) => round(c)),
      years: years.map((c) => round(c)),
      vol: round(vol),
      maxDD: round(maxDD),
      sharpe: round(sharpe, 2),
      liquidityCr: round(liquidityCr, 2),
      fromHigh: round(fromHigh),
      aboveMa10: ma10 === null ? null : price > ma10,
      aboveMa40: ma40 === null ? null : price > ma40,
      ma10AboveMa40: ma10 === null || ma40 === null ? null : ma10 > ma40,
      historyMonths,
      dataOk,
      adjusted: !!adj?.some((a) => a.exDate <= latest.date),
      longTerm: scoreOf(longParts, 0.6),
      shortTerm: scoreOf(shortParts, 0.6),
      flags,
    });

    series.set(symbol, {
      symbol,
      monthly: monthly
        .map((d, k) => ({ date: k === 0 ? latest.date : d?.date ?? "", close: m[k] }))
        .filter((p): p is { date: string; close: number } => p.close !== null && !!p.date)
        .reverse()
        .map((p) => ({ date: p.date, close: Number(p.close.toFixed(2)) })),
      adjustments: adj ?? [],
    });
  }
  return { rows, series };
}
