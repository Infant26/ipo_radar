import type { DetailData, GmpPoint, Ipo, ScorePart, Verdict } from "./types";
import { scoreFundamentals } from "./fundamentals";

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
  | "listing"
> & { listingPrice?: number | null; listingGainPct?: number | null };

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
/** log-scaled 0..1 where `target` maps to 1 */
const logScale = (x: number, target: number) => clamp(Math.log10(1 + Math.max(0, x)) / Math.log10(1 + target));

/** Today's date in India, as YYYY-MM-DD */
export const todayIST = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/**
 * How far through the bidding window we are (0..1). Subscription numbers
 * grow over the window — QIBs in particular usually bid on the last day —
 * so expectations scale with progress instead of punishing day-1 IPOs.
 */
function biddingProgress(ipo: RawIpo): number {
  if (!ipo.openDate || !ipo.closeDate) return 1;
  const total = dayDiff(ipo.openDate, ipo.closeDate) + 1;
  const elapsed = dayDiff(ipo.openDate, todayIST()) + 1;
  return clamp(elapsed / Math.max(1, total), 1 / 3, 1);
}

export function scoreIpo(ipo: RawIpo): Pick<Ipo, "score" | "verdict" | "scoreParts"> {
  const parts: ScorePart[] = [];
  const fmt = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

  // 1. Expected listing gain — the core signal. 40%+ GMP earns full marks.
  parts.push({
    key: "gmp",
    label: "Expected listing gain",
    weight: 45,
    value: ipo.gmpPct === null ? 0 : clamp(ipo.gmpPct / 40),
    detail: ipo.gmpPct === null ? "No GMP yet" : `${fmt(ipo.gmpPct)}% GMP (40%+ = full marks)`,
  });

  // 2. GMP momentum — is today's GMP near its peak, or has it been sliding?
  const { gmp, gmpLow, gmpHigh } = ipo;
  let momentum: number | null = null;
  if (gmp !== null && gmpLow !== null && gmpHigh !== null && gmpHigh > 0) {
    momentum = gmpHigh === gmpLow ? (gmp > 0 ? 1 : 0) : clamp((gmp - gmpLow) / (gmpHigh - gmpLow));
  }
  parts.push({
    key: "momentum",
    label: "GMP momentum",
    weight: 10,
    value: momentum,
    detail:
      momentum === null
        ? "No GMP history"
        : `₹${fmt(gmp!)} now, range ₹${fmt(gmpLow!)} to ₹${fmt(gmpHigh!)}`,
  });

  // 3. Overall demand (only once bidding has started)
  const sub = ipo.subscription;
  const progress = biddingProgress(ipo);
  const live = ipo.status !== "upcoming";
  const demandTarget = Math.max(3, 50 * progress);
  parts.push({
    key: "demand",
    label: "Overall subscription",
    weight: 15,
    value: live && sub.total !== null ? logScale(sub.total, demandTarget) : null,
    detail:
      live && sub.total !== null
        ? `${fmt(sub.total)}x (target ${fmt(demandTarget)}x at this stage)`
        : "Bidding not started",
  });

  // 4. QIB (institutional) demand. QIBs mostly bid on the final day, so before
  //    then only count it once they're already fully subscribed.
  const qibCounts = live && sub.qib !== null && (progress >= 1 || sub.qib >= 1);
  parts.push({
    key: "qib",
    label: "QIB (institutional) demand",
    weight: 20,
    value: qibCounts ? logScale(sub.qib!, 30) : null,
    detail: qibCounts
      ? `${fmt(sub.qib!)}x (30x+ = full marks)`
      : live && sub.qib !== null
        ? `${fmt(sub.qib)}x so far; QIBs usually bid on the last day`
        : "Not available yet",
  });

  // 5. Source's hype rating (1–5 🔥)
  parts.push({
    key: "rating",
    label: "Market buzz rating",
    weight: 10,
    value: ipo.rating !== null ? clamp(ipo.rating / 5) : null,
    detail: ipo.rating !== null ? `${ipo.rating}/5 🔥` : "Not rated",
  });

  const used = parts.filter((p) => p.value !== null);
  const totalWeight = used.reduce((s, p) => s + p.weight, 0);
  const score = totalWeight
    ? Math.round((used.reduce((s, p) => s + p.weight * p.value!, 0) / totalWeight) * 100)
    : null;

  let verdict: Verdict | null = null;
  if (score !== null) {
    if (ipo.gmp === null || ipo.gmp <= 0) verdict = "Avoid";
    else if (score >= 65) verdict = "Strong apply";
    else if (score >= 45) verdict = "Apply";
    else if (score >= 25) verdict = "Risky";
    else verdict = "Avoid";
  }

  return { score, verdict, scoreParts: parts };
}

const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "13-Oct 23:37" → "13 Oct"; null if it can't be read */
const dayOf = (at: string) => {
  const m = at.match(/^(\d{1,2})-([A-Za-z]{3})/);
  return m && MON.includes(m[2].toLowerCase()) ? `${Number(m[1])} ${m[2]}` : null;
};

/** Current GMP vs the last entry the source logged before today (IST). */
function dayChange(gmp: number | null, history: GmpPoint[]): Ipo["gmpDayChange"] {
  if (gmp === null) return null;
  const today = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })
    .format(new Date())
    .replace(/^(\d+)\s+(\w{3}).*$/, "$1 $2");
  const prev = history.find((p) => p.gmp !== null && dayOf(p.at) !== null && dayOf(p.at)!.toLowerCase() !== today.toLowerCase());
  return prev ? { since: dayOf(prev.at)!, from: prev.gmp!, change: gmp - prev.gmp! } : null;
}

/** Compare the actual listing with what the final GMP implied. */
function listingResult(ipo: RawIpo): Ipo["listing"] {
  const { listingPrice, listingGainPct, price } = ipo;
  if (listingPrice == null || !price) return null;
  const gainPct = listingGainPct ?? ((listingPrice - price) / price) * 100;
  // The last GMP before listing; "--" on the day usually means it had fallen to zero
  const finalGmp = ipo.gmpAtListing ?? ipo.gmp;
  const expectedPct = finalGmp !== null ? (finalGmp / price) * 100 : null;
  return {
    price: listingPrice,
    gainPct,
    expectedPct,
    gapPts: expectedPct !== null ? gainPct - expectedPct : null,
    profitPerLot: ipo.lot ? (listingPrice - price) * ipo.lot : null,
  };
}

export function enrich(ipo: RawIpo, detail?: DetailData | null): Ipo {
  const estListing = ipo.price && ipo.gmp !== null ? ipo.price + ipo.gmp : null;
  const profitPerLot = ipo.lot && ipo.gmp !== null ? ipo.lot * ipo.gmp : null;
  const minInvestment = ipo.lot && ipo.price ? ipo.lot * ipo.price : null;
  const live = ipo.status === "open" || ipo.status === "upcoming";
  const scored = live ? scoreIpo(ipo) : { score: null, verdict: null, scoreParts: [] };
  // Without a price band the GMP can't be turned into a % gain, so don't rank it yet.
  if (live && !ipo.price) Object.assign(scored, { score: null, verdict: null });
  const gmpHistory = detail?.gmpHistory ?? [];
  const { listingPrice: _lp, listingGainPct: _lg, ...rest } = ipo;
  return {
    ...rest,
    listing: listingResult(ipo),
    estListing,
    profitPerLot,
    minInvestment,
    ...scored,
    fundamentals: scoreFundamentals(detail?.fundamentals),
    gmpHistory,
    gmpDayChange: dayChange(ipo.gmp, gmpHistory),
  };
}
