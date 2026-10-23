import { computeStocks, type StockRow, type StockSeries } from "./compute";
import { dayOnOrBefore, fetchAdjustments, fetchNames, fromIso, istToday, toIso, type Day } from "./nse";

export interface StockData {
  asOf: string;
  builtAt: string;
  rows: StockRow[];
  series: Map<string, StockSeries>;
  notes: string[];
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

async function build(): Promise<StockData> {
  const latest = await dayOnOrBefore(istToday());
  if (!latest) throw new Error("Couldn't find a recent NSE price file");
  if (memo?.key === latest.date && Date.now() - memo.at < 12 * 3600_000) return memo.data;

  const monthDates = Array.from({ length: 60 }, (_, k) => monthsBefore(latest.date, k + 1));
  const weekDates = Array.from({ length: 52 }, (_, k) => toIso(new Date(fromIso(latest.date).getTime() - (k + 1) * 7 * 86400_000)));

  // Weekly samples snap to an earlier trading day than the anchor, never to `latest` itself
  const before = (iso: string) => dayOnOrBefore(iso, toIso(new Date(fromIso(latest.date).getTime() - 86400_000)));

  const [monthly, weekly, adjustments, names] = await Promise.all([
    pool(monthDates, 8, before),
    pool(weekDates, 8, before),
    fetchAdjustments(monthsBefore(latest.date, 61), latest.date),
    fetchNames(),
  ]);

  const ok = (r: PromiseSettledResult<Day | null>) => (r.status === "fulfilled" ? r.value : null);
  const missingMonths = monthly.filter((r) => !ok(r)).length;
  const missingWeeks = weekly.filter((r) => !ok(r)).length;
  const notes: string[] = [];
  if (missingMonths) notes.push(`${missingMonths} of 60 monthly price files couldn't be loaded`);
  if (missingWeeks) notes.push(`${missingWeeks} of 52 weekly price files couldn't be loaded`);

  const { rows, series } = computeStocks(latest, [latest, ...monthly.map(ok)], [latest, ...weekly.map(ok)], adjustments, names);
  const data: StockData = { asOf: latest.date, builtAt: new Date().toISOString(), rows, series, notes };
  memo = { key: latest.date, at: Date.now(), data };
  return data;
}
