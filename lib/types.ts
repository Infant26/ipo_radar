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
  /** GMP reported by the second source, for cross-checking */
  gmpAlt: number | null;
  gmpUpdatedAt: string | null;
  rating: number | null;
  pe: number | null;
  openDate: string | null;
  closeDate: string | null;
  allotmentDate: string | null;
  listingDate: string | null;
  subscription: Subscription;
  url: string | null;
  source: "investorgain" | "ipowatch";
  // derived
  estListing: number | null;
  profitPerLot: number | null;
  minInvestment: number | null;
  score: number | null;
  verdict: Verdict | null;
  scoreParts: ScorePart[];
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
