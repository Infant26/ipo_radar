/**
 * Second and third data sources, used alongside InvestorGain:
 *   IPOji  - an independent GMP feed (and a fallback IPO list if InvestorGain is down)
 *   NSE    - official subscription figures from the exchange
 *
 * IPOWatch and IPO Central were tried but serve a bot challenge to server requests, so
 * they're not used.
 */
import type { IpoStatus, Subscription } from "./types";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

const IPOJI_URL = "https://www.ipoji.com/ipo-gmp";
const NSE_BASE = "https://www.nseindia.com";

async function get(url: string, timeoutMs: number, accept = "text/html") {
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "User-Agent": UA,
      Accept: accept,
      "Accept-Language": "en-IN,en;q=0.9",
      Referer: new URL(url).origin + "/",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res;
}

const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const num = (s: string | undefined | null) => {
  const m = String(s ?? "").replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

// ---------- matching names across sites ----------

const words = (name: string) =>
  name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(ipo|limited|ltd|india|private|pvt|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/**
 * Find the entry for `name` among another site's names. Sites name the same company
 * differently ("Zetwerk" vs "Zetwerk Manufacturing Business"), so try an exact match,
 * then the first two words, then a unique one-word prefix.
 */
export function findMatch<T>(name: string, items: T[], nameOf: (t: T) => string): T | undefined {
  const a = words(name);
  if (!a.length) return undefined;
  const keyed = items.map((t) => ({ t, w: words(nameOf(t)) }));
  const exact = keyed.find((k) => k.w.join(" ") === a.join(" "));
  if (exact) return exact.t;
  if (a.length >= 2) {
    const two = keyed.filter((k) => k.w.length >= 2 && k.w[0] === a[0] && k.w[1] === a[1]);
    if (two.length === 1) return two[0].t;
  }
  // One name is a word-prefix of the other ("zetwerk" / "zetwerk manufacturing business")
  const prefix = keyed.filter((k) => {
    const n = Math.min(k.w.length, a.length);
    return n > 0 && k.w.slice(0, n).join(" ") === a.slice(0, n).join(" ");
  });
  return prefix.length === 1 ? prefix[0].t : undefined;
}

// ---------- IPOji ----------

export interface IpojiRow {
  name: string;
  status: IpoStatus;
  gmp: number | null;
  priceLow: number | null;
  priceHigh: number | null;
  openDate: string | null;
  closeDate: string | null;
  updatedAt: string | null;
  url: string;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "Oct 21, 2026" → "2026-10-21" */
const isoDate = (s: string | undefined) => {
  const m = s?.match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})/);
  if (!m || !MONTHS[m[1].toLowerCase()]) return null;
  return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
};

/** Mainboard rows from IPOji's GMP table. */
export async function fetchIpoji(): Promise<IpojiRow[]> {
  const html = await (await get(IPOJI_URL, 8000)).text();
  const rows = [...html.matchAll(/<tr class="gmp-row"([^>]*)>([\s\S]*?)<\/tr>/g)];
  if (!rows.length) throw new Error("GMP table not found (page layout may have changed)");
  const out: IpojiRow[] = [];
  for (const [, attrs, body] of rows) {
    const attr = (k: string) => attrs.match(new RegExp(`data-${k}="([^"]*)"`))?.[1];
    if (attr("type") !== "mainboard") continue;
    const cell = (label: string) =>
      body.match(new RegExp(`<td[^>]*data-label="${label}"[^>]*>([\\s\\S]*?)</td>`))?.[1];
    const band = text(cell("Price Band") ?? "").match(/([\d,.]+)\s*-\s*([\d,.]+)/);
    const single = num(text(cell("Price Band") ?? ""));
    const dates = text(cell("Open – Close") ?? cell("Open - Close") ?? body.match(/[A-Z][a-z]{2} \d{1,2}, \d{4} – [A-Z][a-z]{2} \d{1,2}, \d{4}/)?.[0] ?? "");
    const [open, close] = dates.split(/\s+[–-]\s+/);
    const statusWord = (attr("status") ?? "").toLowerCase();
    const updated = text(body.match(/(\d{1,2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2} [AP]M IST)/)?.[1] ?? "");
    out.push({
      name: decode(attr("name") ?? ""),
      status:
        statusWord === "open" || statusWord === "live" ? "open" : statusWord === "upcoming" ? "upcoming" : statusWord === "listed" ? "listed" : "closed",
      gmp: attr("hasgmp") === "true" ? num(attr("gmp")) : null,
      priceLow: band ? num(band[1]) : single,
      priceHigh: band ? num(band[2]) : single,
      openDate: isoDate(open),
      closeDate: isoDate(close),
      updatedAt: updated || null,
      url: new URL(attr("rowurl") ?? "/ipo-gmp", IPOJI_URL).toString(),
    });
  }
  return out;
}

// ---------- NSE ----------

export interface NseIssue {
  name: string;
  symbol: string;
  subscription: Subscription;
}

interface NseCurrent {
  companyName: string;
  symbol: string;
  status: string;
}

interface NseCategoryRow {
  category: string;
  srNo: string | null;
  noOfShareOffered: string;
  noOfSharesBid: string;
  noOfTotalMeant: string;
}

/**
 * Official subscription for the issues NSE currently lists (open now or just closed).
 * NSE publishes consolidated NSE + BSE bids by category; the total is worked out from
 * the top-level categories' shares bid vs shares offered.
 */
export async function fetchNse(): Promise<NseIssue[]> {
  const current = (await (await get(`${NSE_BASE}/api/ipo-current-issue`, 8000, "application/json")).json()) as NseCurrent[];
  if (!Array.isArray(current)) throw new Error("unexpected response");
  const issues = current.filter((c) => c.symbol && c.companyName);
  const results = await Promise.allSettled(
    issues.map(async (c): Promise<NseIssue> => {
      const res = await get(
        `${NSE_BASE}/api/ipo-active-category?symbol=${encodeURIComponent(c.symbol)}`,
        8000,
        "application/json",
      );
      const data = (await res.json()) as { dataList?: NseCategoryRow[]; updateTime?: string };
      const rows = (data.dataList ?? []).filter((r) => /^\d+$/.test(r.srNo ?? ""));
      const times = (re: RegExp) => {
        const r = rows.find((x) => re.test(x.category));
        return r && r.noOfTotalMeant !== "" ? Number(r.noOfTotalMeant) : null;
      };
      const offered = rows.reduce((a, r) => a + (Number(r.noOfShareOffered) || 0), 0);
      const bid = rows.reduce((a, r) => a + (Number(r.noOfSharesBid) || 0), 0);
      return {
        name: c.companyName,
        symbol: c.symbol,
        subscription: {
          total: offered > 0 ? bid / offered : null,
          qib: times(/^Qualified Institutional/i),
          nii: times(/^Non Institutional/i),
          retail: times(/^Retail/i),
          updatedAt: data.updateTime?.replace(/^Updated as on\s*/i, "") || null,
          source: "NSE",
        },
      };
    }),
  );
  const ok = results.filter((r): r is PromiseFulfilledResult<NseIssue> => r.status === "fulfilled").map((r) => r.value);
  if (issues.length && !ok.length) {
    const first = results[0] as PromiseRejectedResult;
    throw new Error(String(first.reason?.message ?? first.reason));
  }
  return ok;
}

// ---------- combining GMPs ----------

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Do the sources agree? Small gaps are normal (dealers quote at different times), so
 * only call it a disagreement when the spread is more than 10% of the GMP and more than
 * 1.5% of the issue price.
 */
export function agreement(gmps: number[], price: number | null): "agree" | "differ" | "single" | null {
  if (!gmps.length) return null;
  if (gmps.length === 1) return "single";
  const spread = Math.max(...gmps) - Math.min(...gmps);
  const mid = Math.abs(median(gmps));
  const tolerance = Math.max(mid * 0.1, price ? price * 0.015 : 0, 2);
  return spread > tolerance ? "differ" : "agree";
}
