import type { Flag, FundVerdict, Fundamentals, FundamentalsData, ScorePart } from "./types";

/*
 * Fundamentals score (0–100), separate from the listing score.
 *
 * Ratio bands follow standard financial-analysis benchmarks:
 *   ROE            <8% below avg · 8–15 acceptable · 15–25 good · >25 excellent
 *   ROA            <3% below avg · 3–6 acceptable  · 6–12 good  · >12 excellent
 *   Net margin     <3% below avg · 3–10 acceptable · 10–20 good · >20 excellent
 *   EBITDA margin  <5% below avg · 5–15 acceptable · 15–25 good · >25 excellent
 *   Debt/equity    <0.3 conservative · 0.3–0.8 moderate · 0.8–2 elevated · >2 high risk
 *   P/E            <10 value · 10–20 fair · 20–35 growth · >35 premium
 *   PEG            <0.5 cheap · 0.5–1 fair · 1–2 fully valued · >2 overvalued
 * Growth uses the multi-year CAGR across every reported full year, not a single snapshot.
 * ROE is blended with ROA so leverage alone can't inflate the returns score.
 */

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const fmt = (n: number, d = 1) => n.toLocaleString("en-IN", { maximumFractionDigits: d });
const cr = (n: number) => `₹${fmt(n)} Cr`;
const sign = (n: number, d = 0) => `${n >= 0 ? "+" : ""}${fmt(n, d)}%`;
const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** % change from b to a; null when there's no meaningful base */
const growth = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null || b <= 0 ? null : ((a - b) / b) * 100;

/** Compound annual growth from `first` to `last` over `years`; null if either end is non-positive */
const cagr = (last: number | null | undefined, first: number | null | undefined, years: number) =>
  last == null || first == null || first <= 0 || last <= 0 || years < 1
    ? null
    : (Math.pow(last / first, 1 / years) - 1) * 100;

/** "31 Mar 2026" → "FY26"; other year-ends → "year to Dec 2025" */
const fyName = (label: string) => {
  const y = label.match(/(\d{4})\s*$/)?.[1];
  if (!y) return label;
  const mon = label.match(/[A-Za-z]{3}/)?.[0] ?? "";
  return /mar/i.test(mon) ? `FY${y.slice(2)}` : `year to ${mon} ${y}`;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthOf = (label: string) => MONTHS.indexOf(label.match(/[A-Za-z]{3}/)?.[0]?.toLowerCase() ?? "");

/** Months covered by a part-year stub, given the financial year-end ("30 Jun 2026" after a March year-end → 3) */
const stubMonths = (stub: string, yearEnd: string) => {
  const m = monthOf(stub);
  const e = monthOf(yearEnd);
  return m < 0 || e < 0 ? null : (m - e + 12) % 12 || 12;
};

const EMPTY: Fundamentals = {
  data: null,
  score: null,
  verdict: null,
  parts: [],
  flags: [],
  coverage: 0,
  ratios: {},
};

export function scoreFundamentals(d: FundamentalsData | null | undefined): Fundamentals {
  if (!d) return EMPTY;

  // Validate inputs: keep full years with at least revenue or profit reported.
  const years = d.periods.filter((p) => p.fullYear && (p.revenue !== null || p.pat !== null));
  const fy = years[0];
  const prev = years[1];
  const oldest = years[years.length - 1];
  const span = years.length - 1;
  // Profit CAGR needs a positive base: start from the first profitable year.
  const firstProfitIdx = years.findLastIndex((p) => (p.pat ?? 0) > 0);
  const patBase = firstProfitIdx > 0 ? years[firstProfitIdx] : null;
  const patSpan = firstProfitIdx;
  const stub = d.periods[0] && !d.periods[0].fullYear ? d.periods[0] : null;
  // Same part-year a year earlier, if the prospectus includes it
  const stubPrior = stub
    ? d.periods.find((p) => p !== stub && !p.fullYear && monthOf(p.label) === monthOf(stub.label))
    : undefined;
  const recent = d.periods[0];
  // Fall back to market cap ÷ profit when the source doesn't quote a P/E
  const pe = d.pe ?? (d.marketCapCr && fy?.pat ? d.marketCapCr / fy.pat : null);
  const parts: ScorePart[] = [];
  const flags: Flag[] = [];

  // ----- ratios -----
  const netMargin = d.patMargin ?? (fy?.pat != null && fy.revenue ? (fy.pat / fy.revenue) * 100 : null);
  const ebitdaMargin = fy?.ebitda != null && fy.revenue ? (fy.ebitda / fy.revenue) * 100 : null;
  const roa = fy?.pat != null && fy.assets ? (fy.pat / fy.assets) * 100 : null;
  const de = recent?.borrowing != null && recent.netWorth && recent.netWorth > 0 ? recent.borrowing / recent.netWorth : null;
  const patYoY = growth(fy?.pat, prev?.pat);
  const revYoY = growth(fy?.revenue, prev?.revenue);
  const patCagr = patBase ? cagr(fy?.pat, patBase.pat, patSpan) : null;
  const revCagr = cagr(fy?.revenue, oldest?.revenue, span);
  // A single year off a low base makes PEG meaningless; require a multi-year trend.
  const peg = pe !== null && pe > 0 && patCagr !== null && patCagr > 0 && patSpan >= 2 ? pe / patCagr : null;
  const ps = d.marketCapCr && fy?.revenue ? d.marketCapCr / fy.revenue : null;
  const ratios = { netMargin, ebitdaMargin, roe: d.roe, roa, roce: d.roce, de, pe, pb: d.pb, ps, peg, patCagr, revCagr };

  // 1. Profitability: net margin and EBITDA (operating) margin
  const profitVal =
    fy?.pat == null
      ? null
      : fy.pat <= 0
        ? 0
        : avg([netMargin !== null ? clamp(netMargin / 20) : null, ebitdaMargin !== null ? clamp(ebitdaMargin / 25) : null]);
  parts.push({
    key: "profit",
    label: "Profitability",
    weight: 20,
    value: profitVal,
    detail:
      fy?.pat == null
        ? "No financials"
        : `${fyName(fy.label)} profit ${cr(fy.pat)}` +
          (netMargin !== null ? `, net margin ${fmt(netMargin)}%` : "") +
          (ebitdaMargin !== null ? `, EBITDA margin ${fmt(ebitdaMargin)}%` : "") +
          " (20% / 25% = excellent)",
  });
  if (fy?.pat != null && fy.pat < 0) flags.push({ tone: "bad", text: `Loss-making in ${fyName(fy.label)}` });
  else if (netMargin !== null && netMargin < 3) flags.push({ tone: "warn", text: `Thin margin (${fmt(netMargin)}%)` });

  // 2. Earnings growth: multi-year CAGR
  const turnedProfitable = prev?.pat != null && prev.pat <= 0 && (fy?.pat ?? 0) > 0;
  parts.push({
    key: "profitGrowth",
    label: "Profit growth",
    weight: 15,
    value: turnedProfitable ? 0.7 : fy?.pat != null && fy.pat <= 0 ? 0 : patCagr === null ? null : clamp((patCagr + 10) / 35),
    detail: turnedProfitable
      ? `Turned profitable in ${fyName(fy!.label)}`
      : fy?.pat != null && fy.pat <= 0
        ? "Loss-making, no profit to grow"
        : patCagr === null
          ? "Not enough history"
          : `${patSpan}-year ${patSpan > 1 ? "CAGR " : ""}${sign(patCagr)}` +
            (patYoY !== null && patSpan > 1 ? `, last year ${sign(patYoY)}` : "") +
            (patBase !== oldest ? ` (since turning profitable in ${fyName(patBase!.label)})` : "") +
            " (25%+ = full marks)",
  });
  if (patYoY !== null && fy!.pat! > 0) {
    if (patYoY <= -15) flags.push({ tone: "warn", text: `Profit down ${fmt(-patYoY, 0)}% in ${fyName(fy!.label)}` });
    else if (patCagr !== null && patCagr >= 25 && patSpan >= 2)
      flags.push({ tone: "good", text: `Profit growing ${fmt(patCagr, 0)}% a year` });
  }

  // 3. Revenue growth: multi-year CAGR
  parts.push({
    key: "revenueGrowth",
    label: "Revenue growth",
    weight: 10,
    value: revCagr === null ? null : clamp((revCagr + 5) / 25),
    detail:
      revCagr === null
        ? "Not enough history"
        : `${span}-year CAGR ${sign(revCagr)}` + (revYoY !== null && span > 1 ? `, last year ${sign(revYoY)}` : "") + " (20%+ = full marks)",
  });
  if (revYoY !== null && revYoY <= -10) flags.push({ tone: "warn", text: `Revenue down ${fmt(-revYoY, 0)}%` });
  else if (revCagr !== null && revCagr >= 25 && span >= 2) flags.push({ tone: "good", text: `Revenue growing ${fmt(revCagr, 0)}% a year` });

  // 4. Latest part-year results
  const months = stub && fy ? stubMonths(stub.label, fy.label) : null;
  const span3 = months ? `${months} months` : "period";
  const stubG = growth(stub?.pat, stubPrior?.pat);
  const lossNarrowed = stub?.pat != null && stub.pat < 0 && stubPrior?.pat != null && stubPrior.pat < stub.pat;
  parts.push({
    key: "latest",
    label: "Latest results",
    weight: 10,
    value: stub?.pat == null ? null : stub.pat < 0 ? (lossNarrowed ? 0.2 : 0) : stubG !== null && stubG < -20 ? 0.6 : 1,
    detail:
      stub?.pat == null
        ? "No part-year results"
        : `${stub.pat < 0 ? "Loss" : "Profit"} of ${cr(Math.abs(stub.pat))} in the ${span3} to ${stub.label}` +
          (stubPrior?.pat != null ? ` (same period last year: ${cr(stubPrior.pat)})` : ""),
  });
  if (stub?.pat != null && stub.pat < 0) {
    flags.push({ tone: "bad", text: `Loss in latest ${months ? `${months} months` : "results"} (${cr(stub.pat)})` });
  }

  // 5. Returns: ROE blended with ROA
  parts.push({
    key: "returns",
    label: "Return on capital",
    weight: 15,
    value: avg([d.roe !== null ? clamp(d.roe / 25) : null, roa !== null ? clamp(roa / 12) : null]),
    detail:
      d.roe === null && roa === null
        ? "Not reported"
        : [d.roe !== null ? `ROE ${fmt(d.roe)}%` : null, roa !== null ? `ROA ${fmt(roa)}%` : null].filter(Boolean).join(", ") +
          " (25% / 12% = excellent)",
  });
  if (d.roe !== null && d.roe >= 0) {
    if (d.roe < 8) flags.push({ tone: "warn", text: `Low ROE (${fmt(d.roe)}%)` });
    else if (d.roe >= 25) flags.push({ tone: "good", text: `Excellent ROE (${fmt(d.roe)}%)` });
  }

  // 6. Valuation: P/E vs listed peers, PEG, absolute P/E band
  let valuation: number | null = null;
  const valBits: string[] = [];
  if (pe !== null && pe <= 0) {
    valuation = 0;
    valBits.push("negative earnings, P/E not meaningful");
  } else if (pe !== null) {
    const peerRel = d.peerMedianPe ? pe / d.peerMedianPe : null;
    valuation = avg([
      peerRel !== null ? clamp((1.5 - peerRel) / 0.8) : null,
      peg !== null ? clamp((2 - peg) / 1.5) : patCagr !== null && patCagr <= 0 ? 0 : null,
      clamp((50 - pe) / 40),
    ]);
    valBits.push(`P/E ${fmt(pe)}`);
    if (d.peerMedianPe) valBits.push(`peer median ${fmt(d.peerMedianPe)}`);
    if (peg !== null) valBits.push(`PEG ${fmt(peg, 2)}`);
    if (peerRel !== null && peerRel >= 1.25)
      flags.push({ tone: "warn", text: `Priced above peers (P/E ${fmt(pe, 0)} vs ${fmt(d.peerMedianPe!, 0)})` });
    else if (peerRel !== null && peerRel <= 0.8)
      flags.push({ tone: "good", text: `Priced below peers (P/E ${fmt(pe, 0)} vs ${fmt(d.peerMedianPe!, 0)})` });
    if (peg !== null && peg > 2) flags.push({ tone: "warn", text: `Overvalued for its growth (PEG ${fmt(peg, 1)})` });
    else if (pe > 35 && (patCagr === null || patCagr <= 0))
      flags.push({ tone: "warn", text: `Premium P/E ${fmt(pe, 0)} without profit growth` });
  }
  parts.push({
    key: "valuation",
    label: "Valuation",
    weight: 15,
    value: valuation,
    detail: valBits.length ? valBits.join(", ") : "P/E not available",
  });

  // 7. Leverage
  parts.push({
    key: "debt",
    label: "Debt",
    weight: 10,
    value: recent?.netWorth != null && recent.netWorth <= 0 ? 0 : de === null ? null : clamp((2 - de) / 1.7),
    detail: de === null ? "Not reported" : `Debt/equity ${fmt(de, 2)} (0.3 or less = conservative)`,
  });
  const debtG = growth(fy?.borrowing, prev?.borrowing);
  if (recent?.netWorth != null && recent.netWorth <= 0) flags.push({ tone: "bad", text: "Negative net worth" });
  else if (recent?.borrowing != null && recent.borrowing <= 1) flags.push({ tone: "good", text: "Debt-free" });
  else if (de !== null && de > 2) flags.push({ tone: "bad", text: `High debt (D/E ${fmt(de, 1)})` });
  else if (de !== null && de > 0.8) flags.push({ tone: "warn", text: `Elevated debt (D/E ${fmt(de, 1)})` });
  else if (debtG !== null && debtG >= 30 && de !== null && de > 0.15)
    flags.push({ tone: "warn", text: `Debt up ${fmt(debtG, 0)}% in ${fyName(fy!.label)}` });

  // 8. Where the IPO money goes
  parts.push({
    key: "issue",
    label: "Fresh money to company",
    weight: 5,
    value: d.ofsPct === null ? null : 1 - (0.7 * d.ofsPct) / 100,
    detail:
      d.ofsPct === null
        ? "Not reported"
        : `${fmt(100 - d.ofsPct, 0)}% fresh issue, ${fmt(d.ofsPct, 0)}% offer for sale by existing holders`,
  });
  if (d.ofsPct !== null && d.ofsPct >= 90)
    flags.push({ tone: "warn", text: `${fmt(d.ofsPct, 0)}% offer for sale (no new money)` });

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const used = parts.filter((p) => p.value !== null);
  const weight = used.reduce((s, p) => s + p.weight, 0);
  const coverage = weight / totalWeight;
  // Below 40% coverage the number would mostly be noise.
  const score = coverage >= 0.4 ? Math.round((used.reduce((s, p) => s + p.weight * p.value!, 0) / weight) * 100) : null;
  const verdict: FundVerdict | null =
    score === null ? null : score >= 65 ? "Strong" : score >= 45 ? "Fair" : score >= 25 ? "Weak" : "Poor";

  const order = { bad: 0, warn: 1, good: 2 } as const;
  flags.sort((a, b) => order[a.tone] - order[b.tone]);

  return { data: d, score, verdict, parts, flags, coverage, ratios };
}
