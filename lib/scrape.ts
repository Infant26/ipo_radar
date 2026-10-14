import type { Ipo, IpoStatus, SourceStatus } from "./types";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

const IG_BASE = "https://www.investorgain.com";
const IG_GMP_URL = `${IG_BASE}/report/live-ipo-gmp/331/`;
const IG_SUB_URL = `${IG_BASE}/report/ipo-subscription-live/333/ipo/`;
const IPOWATCH_URL = "https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/";

async function fetchHtml(url: string, timeoutMs = 15000): Promise<string> {
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-IN,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

// ---------- small parsing helpers ----------

const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'");

const text = (html: string | undefined | null) =>
  decode(String(html ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

const num = (s: unknown): number | null => {
  if (s === null || s === undefined) return null;
  const m = String(s).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

export const nameKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/\b(ipo|limited|ltd|india|private|pvt)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const mapStatus = (code: string): IpoStatus => {
  if (code === "O") return "open";
  if (code === "U") return "upcoming";
  if (code.startsWith("L")) return "listed";
  return "closed";
};

/**
 * InvestorGain is a Next.js app that streams its table data in the RSC
 * payload (`self.__next_f.push([1, "…"])`). Rebuild the payload and pull the
 * `initialTableResponse` JSON object out of it.
 */
function extractTable(html: string): Record<string, unknown>[] {
  let payload = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    payload += JSON.parse(m[1]);
  }
  const k = payload.indexOf('"initialTableResponse":');
  if (k < 0) throw new Error("table data not found (page layout may have changed)");
  const start = payload.indexOf("{", k);
  let depth = 0;
  let inStr = false;
  let i = start;
  for (; i < payload.length; i++) {
    const c = payload[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) break;
  }
  const obj = JSON.parse(payload.slice(start, i + 1));
  if (!Array.isArray(obj.reportTableData)) throw new Error("unexpected table format");
  return obj.reportTableData;
}

type RawIpo = Omit<
  Ipo,
  "estListing" | "profitPerLot" | "minInvestment" | "score" | "verdict" | "scoreParts"
>;

// ---------- InvestorGain ----------

async function fetchInvestorGain(): Promise<RawIpo[]> {
  const rows = extractTable(await fetchHtml(IG_GMP_URL));
  return rows
    .filter((r) => r["~IPO_Category"] === "IPO") // mainboard only
    .map((r): RawIpo => {
      const gmpHtml = String(r.GMP ?? "");
      const gmpText = text(gmpHtml);
      const gmpVal = gmpHtml.match(/<b>(-?[\d.,]+)<\/b>/)?.[1];
      const range = gmpText.match(/(-?[\d.]+)\s*↓\s*\/\s*(-?[\d.]+)\s*↑/);
      const price = num(r["Price (₹)"]) || null;
      const gmp = gmpVal !== undefined ? num(gmpVal) : null;
      const code = String(r["~ipo_status1"] ?? "");
      const sub = text(String(r.Sub ?? ""));
      return {
        id: `ig-${r["~id"]}`,
        name: String(r["~ipo_name"] ?? text(String(r.Name))),
        status: mapStatus(code),
        statusCode: code,
        price,
        lot: num(r.Lot) || null,
        sizeCr: num(text(String(r["IPO Size"] ?? ""))),
        gmp,
        gmpPct: gmp !== null && price ? (gmp / price) * 100 : null,
        gmpLow: range ? Number(range[1]) : null,
        gmpHigh: range ? Number(range[2]) : null,
        gmpAlt: null,
        gmpUpdatedAt: text(String(r["Updated-On"] ?? "")) || null,
        rating: (String(r.Rating ?? "").match(/&#128293;|🔥/g) ?? []).length || null,
        pe: num(r["~P/E"]),
        openDate: (r["~Srt_Open"] as string) || null,
        closeDate: (r["~Srt_Close"] as string) || null,
        allotmentDate: (r["~Srt_BoA_Dt"] as string) || null,
        listingDate: (r["~Str_Listing"] as string) || null,
        subscription: {
          total: /x$/i.test(sub) ? num(sub) : null,
          qib: null,
          nii: null,
          retail: null,
          updatedAt: null,
        },
        url: r["~urlrewrite_folder_name"] ? IG_BASE + r["~urlrewrite_folder_name"] : null,
        source: "investorgain",
      };
    });
}

interface SubRow {
  total: number | null;
  qib: number | null;
  nii: number | null;
  retail: number | null;
  updatedAt: string | null;
}

async function fetchInvestorGainSubs(): Promise<Map<string, SubRow>> {
  const rows = extractTable(await fetchHtml(IG_SUB_URL));
  const map = new Map<string, SubRow>();
  for (const r of rows) {
    if (r["~IPO_Category"] !== "IPO") continue;
    const nameHtml = String(r.Name ?? "");
    const name = decode(nameHtml.match(/title="([^"]+)"/)?.[1] ?? text(nameHtml));
    const totalHtml = String(r.Total ?? "");
    map.set(nameKey(name), {
      total: num(totalHtml.match(/<b>([\d.]+)<\/b>/)?.[1]),
      qib: num(r.QIB),
      nii: num(r.NII),
      retail: num(r.RII),
      updatedAt: text(totalHtml.replace(/^<b>[\d.]+<\/b>/, "")) || null,
    });
  }
  return map;
}

// ---------- IPOWatch (fallback + second GMP opinion) ----------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "15-19 Oct" / "28 Sep-1 Oct" → ISO dates in the current (or next) year */
function parseRange(s: string): [string | null, string | null] {
  const m = s.match(/(\d{1,2})\s*([A-Za-z]{3})?\s*[-–]\s*(\d{1,2})\s*([A-Za-z]{3})/);
  if (!m) return [null, null];
  const endMonth = MONTHS.indexOf(m[4].toLowerCase());
  const startMonth = m[2] ? MONTHS.indexOf(m[2].toLowerCase()) : endMonth;
  if (endMonth < 0 || startMonth < 0) return [null, null];
  const now = new Date();
  let year = now.getFullYear();
  // Dates far in the past relative to today most likely belong to next year (Dec → Jan rollover)
  if (endMonth < now.getMonth() - 6) year++;
  const iso = (y: number, mo: number, d: number) =>
    `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const startYear = startMonth > endMonth ? year - 1 : year;
  return [iso(startYear, startMonth, Number(m[1])), iso(year, endMonth, Number(m[3]))];
}

async function fetchIpoWatch(): Promise<RawIpo[]> {
  // Secondary source: don't let a slow response hold up the whole refresh.
  const html = await fetchHtml(IPOWATCH_URL, 8000);
  // The first table on the page is mainboard; the second is SME.
  const table = html.match(/<table[\s\S]*?<\/table>/)?.[0];
  if (!table) throw new Error("GMP table not found");
  const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) =>
    [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => text(c[1])),
  );
  const out: RawIpo[] = [];
  for (const cells of rows.slice(1)) {
    if (cells.length < 6) continue;
    const [company, gmpS, , priceS, , dateS] = cells;
    const statusWord = company.match(/\b(Upcoming|Open|Closed|Listed)\b\s*$/i)?.[1]?.toLowerCase();
    const name = company.replace(/\b(Upcoming|Open|Closed|Listed)\b\s*$/i, "").trim();
    const price = num(priceS);
    const gmp = num(gmpS);
    const [openDate, closeDate] = parseRange(dateS);
    const status: IpoStatus =
      statusWord === "open" ? "open" : statusWord === "upcoming" ? "upcoming" : statusWord === "listed" ? "listed" : "closed";
    out.push({
      id: `iw-${nameKey(name).replace(/ /g, "-")}`,
      name,
      status,
      statusCode: statusWord ?? "",
      price,
      lot: null,
      sizeCr: null,
      gmp,
      gmpPct: gmp !== null && price ? (gmp / price) * 100 : null,
      gmpLow: null,
      gmpHigh: null,
      gmpAlt: null,
      gmpUpdatedAt: null,
      rating: null,
      pe: null,
      openDate,
      closeDate,
      allotmentDate: null,
      listingDate: null,
      subscription: { total: null, qib: null, nii: null, retail: null, updatedAt: null },
      url: IPOWATCH_URL,
      source: "ipowatch",
    });
  }
  return out;
}

/** Names differ slightly between sites ("Tonbo Imaging India" vs "Tonbo Imaging"): match on the first two words. */
const shortKey = (name: string) => nameKey(name).split(" ").slice(0, 2).join(" ");

export async function scrapeAll(): Promise<{ ipos: RawIpo[]; sources: SourceStatus[] }> {
  const [ig, subs, iw] = await Promise.allSettled([
    fetchInvestorGain(),
    fetchInvestorGainSubs(),
    fetchIpoWatch(),
  ]);

  const err = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" ? String((r.reason as Error)?.message ?? r.reason) : undefined;

  const sources: SourceStatus[] = [
    { name: "InvestorGain GMP", ok: ig.status === "fulfilled", count: ig.status === "fulfilled" ? ig.value.length : 0, error: err(ig) },
    { name: "InvestorGain subscription", ok: subs.status === "fulfilled", count: subs.status === "fulfilled" ? subs.value.size : 0, error: err(subs) },
    { name: "IPOWatch GMP", ok: iw.status === "fulfilled", count: iw.status === "fulfilled" ? iw.value.length : 0, error: err(iw) },
  ];

  const watch = iw.status === "fulfilled" ? iw.value : [];

  if (ig.status !== "fulfilled") {
    // Primary source down — fall back to IPOWatch on its own.
    return { ipos: watch, sources };
  }

  const subMap = subs.status === "fulfilled" ? subs.value : new Map<string, SubRow>();
  const watchMap = new Map(watch.map((w) => [shortKey(w.name), w]));

  const ipos = ig.value.map((ipo) => {
    const sub = subMap.get(nameKey(ipo.name));
    const alt = watchMap.get(shortKey(ipo.name));
    // InvestorGain sometimes lists an IPO before its price band; borrow it from IPOWatch.
    const price = ipo.price ?? alt?.price ?? null;
    return {
      ...ipo,
      price,
      gmpPct: ipo.gmp !== null && price ? (ipo.gmp / price) * 100 : null,
      openDate: ipo.openDate ?? alt?.openDate ?? null,
      closeDate: ipo.closeDate ?? alt?.closeDate ?? null,
      gmpAlt: alt?.gmp ?? null,
      subscription: sub
        ? { ...sub, total: sub.total ?? ipo.subscription.total }
        : ipo.subscription,
    };
  });

  return { ipos, sources };
}
