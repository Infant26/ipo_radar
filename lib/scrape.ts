import type { DetailData, FinancialPeriod, FundamentalsData, GmpPoint, Ipo, IpoStatus, SourceStatus } from "./types";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

const IG_BASE = "https://www.investorgain.com";
const IG_API = "https://webnodejs.investorgain.com/cloud/v2/report/data-read";
// Report ids on InvestorGain: 331 = live GMP, 333 = live subscription
const GMP_REPORT = { id: 331, page: `${IG_BASE}/report/ipo-gmp-live/331/` };
const SUB_REPORT = { id: 333, page: `${IG_BASE}/report/ipo-subscription-live/333/ipo/` };

async function fetchHtml(url: string, timeoutMs = 15000, revalidate?: number): Promise<string> {
  const res = await fetch(url, {
    ...(revalidate ? { next: { revalidate } } : { cache: "no-store" as const }),
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
 * InvestorGain is a Next.js app that streams its data in the RSC payload
 * (`self.__next_f.push([1, "…"])`). Rebuild that payload as one string.
 */
function flightPayload(html: string): string {
  let payload = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    payload += JSON.parse(m[1]);
  }
  return payload;
}

/** Parse the JSON object/array that follows `"key":` in the payload. */
function extractJson(payload: string, key: string): unknown {
  const k = payload.indexOf(`"${key}":`);
  if (k < 0) throw new Error(`${key} not found (page layout may have changed)`);
  const start = k + key.length + 3;
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
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) break;
  }
  return JSON.parse(payload.slice(start, i + 1));
}

function extractTable(html: string): Record<string, unknown>[] {
  const obj = extractJson(flightPayload(html), "initialTableResponse") as {
    reportTableData?: Record<string, unknown>[];
  };
  if (!Array.isArray(obj.reportTableData)) throw new Error("unexpected table format");
  return obj.reportTableData;
}

/**
 * Rows of an InvestorGain report. The page's server-rendered HTML can be
 * hours old (it's cached on their side), so read the same JSON API the page
 * itself polls, and only fall back to the HTML if that fails.
 */
async function fetchReport(report: { id: number; page: string }): Promise<Record<string, unknown>[]> {
  const ist = new Date(Date.now() + 5.5 * 3600_000); // read UTC fields as IST
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth() + 1;
  const fy = m >= 4 ? `${y}-${String((y + 1) % 100).padStart(2, "0")}` : `${y - 1}-${String(y % 100).padStart(2, "0")}`;
  const v = `${ist.getUTCHours()}-${ist.getUTCMinutes()}`;
  try {
    const res = await fetch(`${IG_API}/${report.id}/1/${m}/${y}/${fy}/0/all?search=&v=${v}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": UA, Accept: "application/json", Referer: report.page, Origin: IG_BASE },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { reportTableData?: Record<string, unknown>[] };
    if (!Array.isArray(json.reportTableData) || !json.reportTableData.length) throw new Error("empty");
    return json.reportTableData;
  } catch {
    return extractTable(await fetchHtml(report.page));
  }
}

/** HTML table → rows of cell text */
function tableRows(html: string): string[][] {
  return [...html.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) =>
    [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => text(c[1])),
  );
}

type RawIpo = Omit<
  Ipo,
  | "estListing"
  | "profitPerLot"
  | "minInvestment"
  | "score"
  | "verdict"
  | "scoreParts"
  | "fundamentals"
  | "gmpHistory"
  | "gmpDayChange"
>;

// ---------- InvestorGain ----------

async function fetchInvestorGain(): Promise<RawIpo[]> {
  const rows = await fetchReport(GMP_REPORT);
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
  const rows = await fetchReport(SUB_REPORT);
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

// ---------- InvestorGain IPO detail page (financials) ----------

/**
 * Detail pages are big (~400 KB each) and financials rarely change, so don't
 * re-download them on every refresh. Kept to an hour because the page also
 * carries the GMP history used for "vs yesterday", and the cache is keyed by
 * the IST date so a new day never reuses yesterday's copy.
 */
const DETAIL_TTL_S = 60 * 60;
const detailCache = new Map<string, { at: number; data: DetailData }>();

const istDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

function parseGmpHistory(payload: string): GmpPoint[] {
  const html = payload.match(/<table class="gmp-table[\s\S]*?<\/table>/)?.[0];
  if (!html) return [];
  return tableRows(html)
    .slice(1)
    .map((cells) => {
      const at = cells[0]?.match(/^\d{1,2}-[A-Za-z]{3}(\s+\d{1,2}:\d{2})?/)?.[0];
      // "₹93 (34.32%) ▲" → 93; "₹-- (0.00%)" → null
      const g = cells[1]?.match(/₹\s*(-?[\d,]+(?:\.\d+)?)/)?.[1];
      return at ? { at, gmp: g !== undefined ? Number(g.replace(/,/g, "")) : null } : null;
    })
    .filter((p): p is GmpPoint => p !== null);
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function parseFinancials(payload: string): FinancialPeriod[] {
  const html = payload.match(/<table[^>]*id=['"]financialTable['"][\s\S]*?<\/table>/)?.[0];
  if (!html) return [];
  const rows = tableRows(html);
  const header = rows.find((r) => /period/i.test(r[0] ?? ""));
  if (!header) return [];
  const row = (re: RegExp) => rows.find((r) => re.test(r[0] ?? ""));
  const assets = row(/^assets/i) ?? row(/^total assets/i);
  const revenue = row(/^revenue/i) ?? row(/^total income/i);
  const pat = row(/^profit after tax/i);
  const ebitda = row(/^ebitda/i);
  const netWorth = row(/^net worth/i);
  const borrowing = row(/^total borrowing/i);
  const labels = header.slice(1);
  // The oldest column in a prospectus is always a full financial year; use its
  // month as the year-end (most companies end in March, some in December).
  const month = (l: string) => l.match(/[A-Za-z]{3}/)?.[0]?.toLowerCase();
  const fyEnd = month(labels[labels.length - 1] ?? "") ?? "mar";
  return labels.map((label, i) => ({
    label,
    fullYear: month(label) === fyEnd,
    assets: num(assets?.[i + 1]),
    revenue: num(revenue?.[i + 1]),
    pat: num(pat?.[i + 1]),
    ebitda: num(ebitda?.[i + 1]),
    netWorth: num(netWorth?.[i + 1]),
    borrowing: num(borrowing?.[i + 1]),
  }));
}

function parsePeers(payload: string, company: string): { name: string; pe: number | null }[] {
  const html = payload.match(/<table[^>]*id=['"]analysisTable['"][\s\S]*?<\/table>/)?.[0];
  if (!html) return [];
  const rows = tableRows(html);
  const peCol = rows[0]?.findIndex((h) => /^p\/e/i.test(h)) ?? -1;
  if (peCol < 0) return [];
  const key = nameKey(company).split(" ")[0];
  return rows
    .slice(1)
    .filter((r) => r[0] && !nameKey(r[0]).startsWith(key) && !/^our company/i.test(r[0]))
    .map((r) => ({ name: r[0].replace(/\s+(ltd|limited)\.?$/i, ""), pe: num(r[peCol]) }));
}

async function fetchDetail(url: string): Promise<DetailData> {
  const key = `${istDate()} ${url}`;
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.at < DETAIL_TTL_S * 1000) return hit.data;

  // Date in the URL so Vercel's data cache also starts fresh each IST day
  const payload = flightPayload(await fetchHtml(`${url}?d=${istDate()}`, 12000, DETAIL_TTL_S));
  const info = (extractJson(payload, "ipoData") as Record<string, unknown>[])[0] ?? {};
  const n = (k: string) => {
    const v = info[k];
    return v === "" || v === null || v === undefined ? null : num(v);
  };
  // Both in rupees
  const total = n("issue_size_in_amt");
  const ofs = n("issue_size_ofs_in_amt");
  const ofsPct = total && ofs !== null ? (ofs / total) * 100 : null;

  const peers = parsePeers(payload, String(info.company_name ?? ""));
  const data: FundamentalsData = {
    sector: (info.company_sector as string) || null,
    periods: parseFinancials(payload),
    pe: n("pe_ratio"),
    pb: n("price_to_book_value"),
    peerMedianPe: median(peers.map((p) => p.pe).filter((p): p is number => p !== null && p > 0)),
    peers,
    roe: n("kpi_ronw") ?? n("kpi_roe"),
    roce: n("kpi_roce"),
    patMargin: n("kpi_pat_margin"),
    ofsPct: ofsPct !== null ? Math.min(100, Math.max(0, ofsPct)) : null,
    promoterPre: n("promoter_shareholding_pre_issue"),
    promoterPost: n("promoter_shareholding_post_issue"),
    marketCapCr: n("market_cap"),
  };
  const detail: DetailData = { fundamentals: data, gmpHistory: parseGmpHistory(payload) };
  for (const k of detailCache.keys()) if (!k.startsWith(istDate())) detailCache.delete(k);
  detailCache.set(key, { at: Date.now(), data: detail });
  return detail;
}

export async function scrapeAll(): Promise<{
  ipos: RawIpo[];
  sources: SourceStatus[];
  details: Map<string, DetailData>;
}> {
  const [ig, subs] = await Promise.allSettled([fetchInvestorGain(), fetchInvestorGainSubs()]);

  const err = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" ? String((r.reason as Error)?.message ?? r.reason) : undefined;

  const sources: SourceStatus[] = [
    { name: "InvestorGain GMP", ok: ig.status === "fulfilled", count: ig.status === "fulfilled" ? ig.value.length : 0, error: err(ig) },
    { name: "InvestorGain subscription", ok: subs.status === "fulfilled", count: subs.status === "fulfilled" ? subs.value.size : 0, error: err(subs) },
  ];

  if (ig.status !== "fulfilled") return { ipos: [], sources, details: new Map() };

  const subMap = subs.status === "fulfilled" ? subs.value : new Map<string, SubRow>();
  const ipos = ig.value.map((ipo) => {
    const sub = subMap.get(nameKey(ipo.name));
    return sub ? { ...ipo, subscription: { ...sub, total: sub.total ?? ipo.subscription.total } } : ipo;
  });

  // Financials for the IPOs you can still apply for
  const targets = ipos.filter((i) => (i.status === "open" || i.status === "upcoming") && i.url);
  const results = await Promise.allSettled(targets.map((i) => fetchDetail(i.url!)));
  const details = new Map<string, DetailData>();
  results.forEach((r, idx) => {
    if (r.status === "fulfilled") details.set(targets[idx].id, r.value);
  });
  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  sources.push({
    name: "InvestorGain financials",
    ok: failed.length === 0,
    count: details.size,
    error: failed.length
      ? `${failed.length} of ${targets.length} failed: ${String(failed[0].reason?.message ?? failed[0].reason)}`
      : undefined,
  });

  return { ipos, sources, details };
}
