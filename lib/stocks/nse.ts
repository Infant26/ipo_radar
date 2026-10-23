/**
 * Official NSE data for the stocks page:
 *   - Bhavcopy: NSE's end-of-day file with every stock's close and traded value
 *   - Corporate actions: bonus issues and splits, used to adjust old prices
 *   - EQUITY_L / Nifty Total Market lists: company names and industries
 */
import { strFromU8, unzipSync } from "fflate";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const ARCHIVES = "https://nsearchives.nseindia.com";
const NSE = "https://www.nseindia.com";
/** NSE switched to the new ("UDiFF") bhavcopy format on this date. */
const NEW_FORMAT_FROM = "2024-07-08";

const YEAR = 365 * 24 * 3600;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Calendar dates are handled as "YYYY-MM-DD" strings and UTC Date objects (no time-zone drift). */
export const toIso = (d: Date) => d.toISOString().slice(0, 10);
export const fromIso = (s: string) => new Date(`${s}T00:00:00Z`);
export const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

export interface DayRow {
  close: number;
  /** traded value in ₹ */
  value: number;
  series: string;
}
export type Day = { date: string; rows: Map<string, DayRow> };

async function fetchBytes(url: string, revalidate: number, timeoutMs = 15000): Promise<Uint8Array | null> {
  const res = await fetch(url, {
    next: { revalidate },
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": UA, Referer: `${NSE}/` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return new Uint8Array(await res.arrayBuffer());
}

function bhavUrl(iso: string) {
  const [y, m, d] = iso.split("-");
  return iso >= NEW_FORMAT_FROM
    ? `${ARCHIVES}/content/cm/BhavCopy_NSE_CM_0_0_0_${y}${m}${d}_F_0000.csv.zip`
    : `${ARCHIVES}/content/historical/EQUITIES/${y}/${MONTHS[+m - 1]}/cm${d}${MONTHS[+m - 1]}${y}bhav.csv.zip`;
}

/** Ordinary shares only: EQ (rolling settlement) and BE (trade-for-trade). */
const KEEP_SERIES = new Set(["EQ", "BE"]);

function parseBhav(csv: string): Map<string, DayRow> {
  const lines = csv.split(/\r?\n/);
  const head = lines[0].split(",").map((h) => h.trim());
  const col = (...names: string[]) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const sym = col("TckrSymb", "SYMBOL");
  const ser = col("SctySrs", "SERIES");
  const cls = col("ClsPric", "CLOSE");
  const val = col("TtlTrfVal", "TOTTRDVAL");
  if (sym < 0 || ser < 0 || cls < 0) throw new Error("unexpected bhavcopy format");
  const rows = new Map<string, DayRow>();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const series = c[ser]?.trim();
    if (!series || !KEEP_SERIES.has(series)) continue;
    const close = Number(c[cls]);
    if (!(close > 0)) continue;
    rows.set(c[sym].trim(), { close, value: Number(c[val]) || 0, series });
  }
  return rows;
}

/** One trading day's closes, or null if the market was shut that day. */
export async function fetchDay(iso: string): Promise<Day | null> {
  if ([0, 6].includes(fromIso(iso).getUTCDay())) return null; // weekend
  // Past files never change; today's may not be published yet, so re-check it often.
  const recent = iso >= toIso(new Date(Date.now() - 3 * 86400_000));
  const zip = await fetchBytes(bhavUrl(iso), recent ? 1800 : YEAR);
  if (!zip) return null;
  const files = unzipSync(zip);
  const name = Object.keys(files).find((f) => f.toLowerCase().endsWith(".csv"));
  if (!name) throw new Error(`no CSV in bhavcopy for ${iso}`);
  return { date: iso, rows: parseBhav(strFromU8(files[name])) };
}

/** The last trading day on or before `iso` (looks back up to 10 days for holidays). */
export async function dayOnOrBefore(iso: string, notAfter?: string): Promise<Day | null> {
  let d = fromIso(notAfter && iso > notAfter ? notAfter : iso);
  for (let i = 0; i < 10; i++, d = new Date(d.getTime() - 86400_000)) {
    const day = await fetchDay(toIso(d));
    if (day) return day;
  }
  return null;
}

// ---------- corporate actions ----------

export interface Adjustment {
  exDate: string;
  /** divide prices before the ex-date by this to make them comparable */
  factor: number;
  label: string;
}

const NSE_DATE = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/;
const nseDate = (s: string) => {
  const m = s.match(NSE_DATE);
  if (!m) return null;
  return `${m[3]}-${String(MONTHS.indexOf(m[2].toUpperCase()) + 1).padStart(2, "0")}-${m[1]}`;
};

/** "Bonus 3:1" → 4 (3 new shares for each 1 held); "Split From Rs 10 To Re 1" → 10. */
export function adjustmentFactor(subject: string): number | null {
  const bonus = subject.match(/bonus\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/i);
  if (bonus) return (Number(bonus[1]) + Number(bonus[2])) / Number(bonus[2]);
  const fv = subject.match(/from\s*r[se]\.?\s*(\d+(?:\.\d+)?)\s*\/?-?.*?to\s*r[se]\.?\s*(\d+(?:\.\d+)?)/i);
  if (fv && /split|sub-?division|consolidat/i.test(subject)) {
    const from = Number(fv[1]);
    const to = Number(fv[2]);
    return from > 0 && to > 0 ? from / to : null;
  }
  return null;
}

/** Bonus and split adjustments per symbol, from `fromIso` to `toIso`. */
export async function fetchAdjustments(from: string, to: string): Promise<Map<string, Adjustment[]>> {
  const out = new Map<string, Adjustment[]>();
  // NSE serves this in yearly chunks; past years never change.
  const chunks: [string, string][] = [];
  for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y++) {
    chunks.push([`${y}-01-01` < from ? from : `${y}-01-01`, `${y}-12-31` > to ? to : `${y}-12-31`]);
  }
  const ddmmyyyy = (iso: string) => iso.split("-").reverse().join("-");
  const results = await Promise.all(
    chunks.map(async ([a, b]) => {
      const current = b >= toIso(new Date(Date.now() - 30 * 86400_000));
      const res = await fetch(
        `${NSE}/api/corporates-corporateActions?index=equities&from_date=${ddmmyyyy(a)}&to_date=${ddmmyyyy(b)}`,
        {
          next: { revalidate: current ? 6 * 3600 : YEAR },
          signal: AbortSignal.timeout(15000),
          headers: { "User-Agent": UA, Referer: `${NSE}/`, Accept: "application/json" },
        },
      );
      if (!res.ok) throw new Error(`corporate actions HTTP ${res.status}`);
      return (await res.json()) as { symbol: string; exDate: string; subject: string }[];
    }),
  );
  for (const rows of results) {
    for (const r of rows) {
      const factor = adjustmentFactor(r.subject ?? "");
      const exDate = nseDate(r.exDate ?? "");
      if (!factor || factor === 1 || !exDate) continue;
      const list = out.get(r.symbol) ?? [];
      if (!list.some((x) => x.exDate === exDate && x.factor === factor)) list.push({ exDate, factor, label: r.subject });
      out.set(r.symbol, list);
    }
  }
  return out;
}

// ---------- names and industries ----------

function csvRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const out: string[] = [];
      let cur = "";
      let q = false;
      for (const ch of line) {
        if (ch === '"') q = !q;
        else if (ch === "," && !q) {
          out.push(cur.trim());
          cur = "";
        } else cur += ch;
      }
      out.push(cur.trim());
      return out;
    });
}

export async function fetchNames(): Promise<Map<string, { name: string; industry: string | null; equity: boolean }>> {
  const [eq, tm] = await Promise.allSettled([
    fetch(`${ARCHIVES}/content/equities/EQUITY_L.csv`, {
      next: { revalidate: 24 * 3600 },
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": UA },
    }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))),
    fetch("https://www.niftyindices.com/IndexConstituent/ind_niftytotalmarket_list.csv", {
      next: { revalidate: 24 * 3600 },
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": UA },
    }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))),
  ]);
  if (eq.status !== "fulfilled") throw new Error(`NSE equity list: ${(eq.reason as Error)?.message}`);
  const out = new Map<string, { name: string; industry: string | null; equity: boolean }>();
  for (const [sym, name] of csvRows(eq.value).slice(1)) if (sym) out.set(sym, { name, industry: null, equity: true });
  if (tm.status === "fulfilled") {
    for (const [name, industry, sym] of csvRows(tm.value).slice(1)) {
      const cur = out.get(sym);
      if (cur) out.set(sym, { ...cur, name: cur.name || name, industry: industry || null });
    }
  }
  return out;
}
