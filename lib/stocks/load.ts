import { computeStocks, type StockRow, type StockSeries } from "./compute";
import { loadDaily, type IndexSeries } from "./daily";
import { dayOnOrBefore, fetchAdjustments, fetchDay, fetchNames, fromIso, istToday, toIso, type Day } from "./nse";
import { analyse, indicators, regimeOf, type Bars, type Regime, type Signal } from "./technical";

export interface IndexState {
  name: string;
  close: number;
  sma50: number | null;
  sma200: number | null;
  regime: Regime | null;
  offHigh: number | null;
  pe: number | null;
  pb: number | null;
  /** last ~250 closes for the chart */
  closes: number[];
}

export interface MarketSummary {
  regime: Regime | null;
  headline: string;
  guidance: string;
  indices: IndexState[];
  breadth: { above200: number; golden: number; counted: number; bull: number; bear: number };
}

export interface StockData {
  asOf: string;
  builtAt: string;
  rows: StockRow[];
  series: Map<string, StockSeries>;
  signals: Map<string, Signal>;
  bars: Map<string, Bars>;
  market: MarketSummary | null;
  notes: string[];
  /** false while daily price history is still downloading */
  complete: boolean;
}

function indexState(name: string, s: IndexSeries | undefined): IndexState | null {
  if (!s || s.close.length < 60) return null;
  const i = indicators(s);
  return {
    name,
    close: i.close,
    sma50: i.sma50,
    sma200: i.sma200,
    regime: regimeOf(i),
    offHigh: i.high52 ? i.close / i.high52 - 1 : null,
    pe: s.pe,
    pb: s.pb,
    closes: s.close.slice(-250),
  };
}

/** The market's own bull/bear read, used as the backdrop for every stock. */
function marketSummary(indices: IndexState[], signals: Signal[]): MarketSummary {
  const n50 = indices.find((x) => x.name === "NIFTY 50") ?? indices[0];
  const withTrend = signals.filter((s) => s.indicators.sma200 !== null);
  const counted = withTrend.length;
  const share = (f: (s: Signal) => boolean) => (counted ? withTrend.filter(f).length / counted : 0);
  const breadth = {
    above200: share((s) => s.indicators.close > s.indicators.sma200!),
    golden: share((s) => s.indicators.sma50 !== null && s.indicators.sma50 > s.indicators.sma200!),
    bull: share((s) => s.regime === "Bull"),
    bear: share((s) => s.regime === "Bear"),
    counted,
  };
  const regime = n50?.regime ?? null;
  const pctAbove = Math.round(breadth.above200 * 100);
  const off = n50?.offHigh != null ? Math.round(-n50.offHigh * 100) : null;
  const headline =
    regime === "Bull"
      ? "Bull market"
      : regime === "Bear"
        ? "Bear market"
        : regime === "Recovering"
          ? "Recovering market"
          : regime === "Weakening"
            ? "Weakening market"
            : "Sideways market";
  const guidance =
    regime === "Bull"
      ? `The Nifty 50 is above a rising 200-day average${pctAbove < 50 ? `, but only ${pctAbove}% of stocks are above theirs, so the rally is narrow: be selective` : ` and ${pctAbove}% of stocks are above theirs`}. Buying pullbacks in stocks with their own bull trend fits this phase.`
      : regime === "Bear"
        ? `The Nifty 50 is below its 200-day average${off !== null ? ` and ${off}% off its high` : ""}, and ${pctAbove}% of stocks are above their 200-day. Most stocks fall with the market: ratings are capped, and waiting for the trend to turn is usually wiser than buying dips.`
        : regime === "Recovering"
          ? `The Nifty 50 is back above its 200-day average but the 50-day hasn't crossed above it yet. ${pctAbove}% of stocks are above their 200-day. Early recoveries can fail; smaller positions and tighter stops suit this phase.`
          : regime === "Weakening"
            ? `The Nifty 50 has slipped below its 200-day average while the 50-day is still above it. ${pctAbove}% of stocks are above their 200-day. Protect gains and avoid new aggressive buys until the trend is clear.`
            : `The trend is flat. ${pctAbove}% of stocks are above their 200-day average. Pick individual stocks with a clear uptrend.`;
  return { regime, headline, guidance, indices, breadth };
}

/** Same calendar day `months` earlier (clamped to the month's last day). */
function monthsBefore(iso: string, months: number) {
  const d = fromIso(iso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() - months;
  const target = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return toIso(target);
}

/** Run async jobs with at most `n` in flight. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try {
          out[k] = { status: "fulfilled", value: await fn(items[k]) };
        } catch (e) {
          out[k] = { status: "rejected", reason: e };
        }
      }
    }),
  );
  return out;
}

let memo: { key: string; at: number; data: StockData } | null = null;
let inflight: Promise<StockData> | null = null;
const MEMO_MS = 3 * 3600_000;

export async function loadStocks(): Promise<StockData> {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.data;
  if (inflight) return inflight;
  inflight = build().finally(() => (inflight = null));
  return inflight;
}

/** Result of an explicit refresh: did NSE have a newer trading day than the one shown? */
export interface RefreshResult {
  data: StockData;
  updated: boolean;
  checkedAt: string;
}

let lastCheck: { at: number; asOf: string } | null = null;
const CHECK_EVERY_MS = 2 * 60_000;

/**
 * Ask NSE directly (no cache) whether a newer day's prices than the current ones exist,
 * and rebuild with it if so. Only the weekdays after the last known date are checked
 * (usually one request), and repeat clicks within two minutes reuse the last answer.
 */
export async function refreshStocks(): Promise<RefreshResult> {
  const current = await loadStocks();
  const now = Date.now();
  if (lastCheck && lastCheck.asOf === current.asOf && now - lastCheck.at < CHECK_EVERY_MS) {
    return { data: current, updated: false, checkedAt: new Date(lastCheck.at).toISOString() };
  }
  // Weekdays after the current date, newest first, up to today (IST)
  const candidates: string[] = [];
  for (let d = fromIso(istToday()); toIso(d) > current.asOf && candidates.length < 7; d = new Date(d.getTime() - 86400_000)) {
    if (![0, 6].includes(d.getUTCDay())) candidates.push(toIso(d));
  }
  let newer: Day | null = null;
  for (const iso of candidates) {
    newer = await fetchDay(iso, { fresh: true }).catch(() => null);
    if (newer) break;
  }
  lastCheck = { at: now, asOf: newer?.date ?? current.asOf };
  if (!newer) return { data: current, updated: false, checkedAt: new Date(now).toISOString() };

  if (!inflight) inflight = build(newer).finally(() => (inflight = null));
  const data = await inflight;
  return { data, updated: data.asOf !== current.asOf, checkedAt: new Date(now).toISOString() };
}

async function build(latestHint?: Day): Promise<StockData> {
  const latest = latestHint ?? (await dayOnOrBefore(istToday()));
  if (!latest) throw new Error("Couldn't find a recent NSE price file");
  if (memo?.key === latest.date && memo.data.complete && Date.now() - memo.at < 12 * 3600_000) return memo.data;

  const monthDates = Array.from({ length: 60 }, (_, k) => monthsBefore(latest.date, k + 1));
  const weekDates = Array.from({ length: 52 }, (_, k) => toIso(new Date(fromIso(latest.date).getTime() - (k + 1) * 7 * 86400_000)));

  // Weekly samples snap to an earlier trading day than the anchor, never to `latest` itself
  const before = (iso: string) => dayOnOrBefore(iso, toIso(new Date(fromIso(latest.date).getTime() - 86400_000)));

  const samples = Promise.all([pool(monthDates, 4, before), pool(weekDates, 4, before)]);
  const [adjustments, names] = await Promise.all([
    fetchAdjustments(monthsBefore(latest.date, 61), latest.date),
    fetchNames(),
  ]);
  const equities = [...latest.rows.keys()].filter((s) => names.get(s)?.equity);
  const [[monthly, weekly], daily] = await Promise.all([
    samples,
    loadDaily(latest.date, equities, adjustments).catch((e: Error) => {
      console.error("daily prices failed", e);
      return null;
    }),
  ]);

  const ok = (r: PromiseSettledResult<Day | null>) => (r.status === "fulfilled" ? r.value : null);
  const missingMonths = monthly.filter((r) => !ok(r)).length;
  const missingWeeks = weekly.filter((r) => !ok(r)).length;
  const notes: string[] = [];
  if (missingMonths) notes.push(`${missingMonths} of 60 monthly price files couldn't be loaded`);
  if (missingWeeks) notes.push(`${missingWeeks} of 52 weekly price files couldn't be loaded`);

  const { rows, series } = computeStocks(latest, [latest, ...monthly.map(ok)], [latest, ...weekly.map(ok)], adjustments, names);

  // Bull / bear analysis (TradingAgents-style rules) on daily prices
  const signals = new Map<string, Signal>();
  let market: MarketSummary | null = null;
  // Gaps in daily data distort the indicators, so only analyse once it's (nearly) complete
  const complete = !!daily && daily.coverage >= 0.95;
  if (daily && !complete) {
    notes.push(
      `Bull/bear signals need a year of daily prices: ${Math.round(daily.coverage * 100)}% downloaded so far. ` +
        "NSE limits how fast its files can be fetched, so the rest loads on the next refresh (try again in a few minutes).",
    );
  }
  if (daily && complete) {
    if (daily.missing) notes.push(`${daily.missing} daily price files couldn't be loaded; signals may be slightly less precise`);
    const indices = ["NIFTY 50", "NIFTY 500"]
      .map((n) => indexState(n, daily.indices.get(n)))
      .filter((x): x is IndexState => x !== null);
    const n50 = indices.find((x) => x.name === "NIFTY 50");
    const ctxMarket = n50
      ? {
          regime: n50.regime,
          label: `Nifty 50 ${n50.regime === "Bull" ? "in a bull trend" : n50.regime === "Bear" ? "in a bear trend" : (n50.regime ?? "trend unclear").toLowerCase()}`,
        }
      : null;
    for (const r of rows) {
      const b = daily.bars.get(r.symbol);
      if (!b) continue;
      const sig = analyse(b, { liquidityCr: r.liquidityCr, market: ctxMarket });
      if (!sig) continue;
      signals.set(r.symbol, sig);
      r.signal = {
        rating: sig.rating,
        regime: sig.regime,
        net: sig.net,
        swing: { status: sig.swing.status, headline: sig.swing.headline, entry: sig.swing.entry, stop: sig.swing.stop },
        positional: { status: sig.positional.status, headline: sig.positional.headline, entry: sig.positional.entry, stop: sig.positional.stop },
      };
    }
    market = marketSummary(indices, [...signals.entries()].filter(([s]) => {
      const row = rows.find((x) => x.symbol === s);
      return (row?.liquidityCr ?? 0) >= 1;
    }).map(([, v]) => v));
  } else if (!daily) {
    notes.push("Daily prices couldn't be loaded, so bull/bear signals are unavailable");
  }

  const data: StockData = {
    asOf: latest.date,
    builtAt: new Date().toISOString(),
    rows,
    series,
    signals,
    bars: daily?.bars ?? new Map(),
    market,
    notes,
    complete,
  };
  // Incomplete builds are kept briefly so the next refresh resumes the download
  memo = { key: latest.date, at: complete ? Date.now() : Date.now() - MEMO_MS + 60_000, data };
  return data;
}
