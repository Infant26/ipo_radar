/**
 * Daily OHLCV for every stock (about 14 months, enough for a 200-day average plus a
 * year of signals), adjusted for bonuses and splits, plus Nifty 50 / Nifty 500 closes.
 */
import { fetchDay, fetchIndexDay, fromIso, toIso, type Adjustment } from "./nse";
import type { Bars } from "./technical";

export interface IndexSeries extends Bars {
  dates: string[];
  pe: number | null;
  pb: number | null;
}

export interface DailyData {
  dates: string[];
  bars: Map<string, Bars>;
  indices: Map<string, IndexSeries>;
  /** files that failed to download (holidays aren't failures) */
  missing: number;
  /** share of trading-day files downloaded */
  coverage: number;
  /** NSE started refusing requests, so the rest was skipped this time */
  blocked: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CALENDAR_DAYS = 420;
export const INDEX_NAMES = ["NIFTY 50", "NIFTY 500"];

async function pool<T>(items: T[], n: number, fn: (t: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        await fn(items[k], k);
      }
    }),
  );
}

export async function loadDaily(
  latest: string,
  symbols: string[],
  adjustments: Map<string, Adjustment[]>,
): Promise<DailyData> {
  // Calendar slots, oldest first; weekends are skipped without a request
  const slots: string[] = [];
  for (let k = CALENDAR_DAYS; k >= 0; k--) {
    const d = toIso(new Date(fromIso(latest).getTime() - k * 86400_000));
    if (![0, 6].includes(fromIso(d).getUTCDay())) slots.push(d);
  }
  const S = slots.length;
  const symIndex = new Map(symbols.map((s, i) => [s, i]));
  const N = symbols.length;
  // Flat typed arrays [symbol * S + slot] keep ~3,000 stocks x 300 days compact
  const O = new Float64Array(N * S);
  const H = new Float64Array(N * S);
  const L = new Float64Array(N * S);
  const C = new Float64Array(N * S);
  const V = new Float64Array(N * S);
  const traded = new Uint8Array(S);
  const idx = new Map<string, { o: number[]; h: number[]; l: number[]; c: number[]; dates: string[]; pe: number | null; pb: number | null }>();
  const idxSlots: Map<string, import("./nse").IndexRow>[] = new Array(S);
  let missing = 0;
  let loaded = 0;
  let blockedRun = 0;
  let blocked = false;

  // NSE's archive blocks bursts of requests, so download gently: 3 at a time, retry with
  // a pause, and stop for now if it keeps refusing. Successful files are cached for good,
  // so the next load only fetches what's still missing.
  async function gently<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const v = await fn();
        blockedRun = 0;
        return v;
      } catch (e) {
        if (/HTTP 403|HTTP 429/.test(String((e as Error).message))) blockedRun++;
        if (blockedRun >= 6) blocked = true;
        if (blocked || attempt >= 2) throw e;
        await sleep(attempt ? 2500 : 800);
      }
    }
  }

  await pool(slots, 3, async (date, s) => {
    if (blocked) {
      missing++;
      return;
    }
    let day: Awaited<ReturnType<typeof fetchDay>> = null;
    try {
      day = await gently(() => fetchDay(date));
    } catch {
      missing++;
      return;
    }
    if (!day) return; // holiday
    loaded++;
    const ix = await gently(() => fetchIndexDay(date)).catch(() => null);
    if (ix) idxSlots[s] = ix;
    traded[s] = 1;
    for (const [sym, r] of day.rows) {
      const j = symIndex.get(sym);
      if (j === undefined) continue;
      // Adjust for bonuses/splits that went ex after this date
      let f = 1;
      for (const a of adjustments.get(sym) ?? []) if (a.exDate > date && a.exDate <= latest) f *= a.factor;
      const p = j * S + s;
      O[p] = r.open / f;
      H[p] = r.high / f;
      L[p] = r.low / f;
      C[p] = r.close / f;
      V[p] = r.volume * f;
    }
  });

  const tradingSlots = slots.map((_, s) => s).filter((s) => traded[s]);
  const dates = tradingSlots.map((s) => slots[s]);

  const bars = new Map<string, Bars>();
  symbols.forEach((sym, j) => {
    const b: Bars = { open: [], high: [], low: [], close: [], volume: [] };
    for (const s of tradingSlots) {
      const p = j * S + s;
      if (!(C[p] > 0)) continue; // not traded that day (suspended or not yet listed)
      b.open.push(O[p]);
      b.high.push(H[p]);
      b.low.push(L[p]);
      b.close.push(C[p]);
      b.volume.push(V[p]);
    }
    if (b.close.length) bars.set(sym, b);
  });

  for (const name of INDEX_NAMES) {
    const series = { o: [] as number[], h: [] as number[], l: [] as number[], c: [] as number[], dates: [] as string[], pe: null as number | null, pb: null as number | null };
    for (const s of tradingSlots) {
      const r = idxSlots[s]?.get(name);
      if (!r) continue;
      series.o.push(r.open);
      series.h.push(r.high);
      series.l.push(r.low);
      series.c.push(r.close);
      series.dates.push(slots[s]);
      series.pe = r.pe;
      series.pb = r.pb;
    }
    idx.set(name, series);
  }

  const indices = new Map<string, IndexSeries>();
  for (const [name, s] of idx) {
    indices.set(name, {
      open: s.o,
      high: s.h,
      low: s.l,
      close: s.c,
      volume: s.c.map(() => 0),
      dates: s.dates,
      pe: s.pe,
      pb: s.pb,
    });
  }
  return { dates, bars, indices, missing, coverage: loaded / Math.max(1, loaded + missing), blocked };
}
