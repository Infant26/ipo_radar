export type IpoStatus = "open" | "upcoming" | "closed" | "listed";

export interface Subscription {
  total: number | null;
  qib: number | null;
  nii: number | null;
  retail: number | null;
  updatedAt: string | null;
}

export interface ScorePart {
  key: string;
  label: string;
  weight: number;
  /** 0..1, or null when the data isn't available yet (excluded from the score) */
  value: number | null;
  detail: string;
}

export interface Ipo {
  id: string;
  name: string;
  status: IpoStatus;
  /** Raw status code from the source (U / O / C / LP / LN …) */
  statusCode: string;
  price: number | null;
  lot: number | null;
  sizeCr: number | null;
  gmp: number | null;
  gmpPct: number | null;
  gmpLow: number | null;
  gmpHigh: number | null;
  gmpUpdatedAt: string | null;
  /** GMP the source recorded on the opening day, closing day and listing day */
  gmpAtOpen: number | null;
  gmpAtClose: number | null;
  gmpAtListing: number | null;
  /** Actual listing-day result, once listed */
  listing: ListingResult | null;
  /** InvestorGain's GMP log, newest first (one closing entry per day plus today's latest) */
  gmpHistory: GmpPoint[];
  /** Change vs the last GMP recorded before today */
  gmpDayChange: { since: string; from: number; change: number } | null;
  rating: number | null;
  pe: number | null;
  openDate: string | null;
  closeDate: string | null;
  allotmentDate: string | null;
  listingDate: string | null;
  subscription: Subscription;
  url: string | null;
  source: "investorgain";
  // derived
  estListing: number | null;
  profitPerLot: number | null;
  minInvestment: number | null;
  /** Listing score: how likely a strong listing-day gain is */
  score: number | null;
  verdict: Verdict | null;
  scoreParts: ScorePart[];
  /** Business quality, scored separately from listing gains */
  fundamentals: Fundamentals;
}

export interface FinancialPeriod {
  /** e.g. "31 Mar 2026" */
  label: string;
  /** true for a full financial year (ending 31 Mar), false for a part-year stub */
  fullYear: boolean;
  assets: number | null;
  revenue: number | null;
  pat: number | null;
  ebitda: number | null;
  netWorth: number | null;
  borrowing: number | null;
}

export interface FundamentalsData {
  sector: string | null;
  /** newest first, ₹ crore */
  periods: FinancialPeriod[];
  pe: number | null;
  pb: number | null;
  peerMedianPe: number | null;
  peers: { name: string; pe: number | null }[];
  roe: number | null;
  roce: number | null;
  patMargin: number | null;
  /** share of the issue that is offer-for-sale (money goes to selling shareholders, not the company) */
  ofsPct: number | null;
  promoterPre: number | null;
  promoterPost: number | null;
  marketCapCr: number | null;
}

export interface ListingResult {
  price: number;
  /** actual listing gain over the issue price, % */
  gainPct: number;
  /** what the final GMP implied, %; null when there was no GMP */
  expectedPct: number | null;
  /** actual minus expected, percentage points */
  gapPts: number | null;
  profitPerLot: number | null;
}

export interface GmpPoint {
  /** as shown by the source, e.g. "13-Oct 23:37" */
  at: string;
  gmp: number | null;
}

export interface DetailData {
  fundamentals: FundamentalsData;
  gmpHistory: GmpPoint[];
}

export type FundVerdict = "Strong" | "Fair" | "Weak" | "Poor";

export interface Flag {
  tone: "bad" | "warn" | "good";
  text: string;
}

export interface Fundamentals {
  data: FundamentalsData | null;
  score: number | null;
  verdict: FundVerdict | null;
  parts: ScorePart[];
  flags: Flag[];
  /** share of the score's weight backed by real data (0..1) */
  coverage: number;
  /** key ratios for display */
  ratios: Record<string, number | null>;
}

export type Verdict = "Strong apply" | "Apply" | "Risky" | "Avoid";

export interface SourceStatus {
  name: string;
  ok: boolean;
  count: number;
  error?: string;
}

export interface IpoResponse {
  fetchedAt: string;
  sources: SourceStatus[];
  ipos: Ipo[];
}
